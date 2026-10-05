/*
 * NMOS Crosspoint — Multicast Lease Manager
 *
 * Acts like a tiny "DHCP for multicasts":
 *   - One lease per NMOS sender, keyed by senderId.
 *   - Each lease occupies a *pair* of consecutive addresses in the configured
 *     CIDR pool: an odd address for Leg 1 (primary), and odd+1 (even) for
 *     Leg 2 (secondary). Single-leg senders still reserve both, so a future
 *     switch to dual-leg doesn't get a different secondary.
 *   - Leases live forever until the device is explicitly deleted by the user.
 *
 * DIVERGENCE FROM UPSTREAM: the fork this came from collapsed everything into
 * a single shared pool, with `category` reduced to a UI badge. This project
 * keeps a SEPARATE range per essence type (settings.multicastRanges), because
 * downstream switch ACLs and IGMP filtering depend on an essence type landing
 * in a known range. So here the category genuinely selects the pool, and each
 * category carries its own round-robin cursor.
 *
 * Categorisation drives which range is used:
 *   - jxsv     → media_type "video/jxsv"
 *   - videoUhd → video wider than 1920 or taller than 1080
 *   - video    → any other media_type starting with "video/"
 *   - audio    → media_type starting with "audio/"
 *   - other    → everything else that is still RTP (ANC, data)
 *
 * jxsv and videoUhd were configured in settings.json from the start but never
 * actually implemented — the old allocator mapped every flow to video, audio
 * or other and left a TODO. They are real here.
 *
 * Duplicate protection: a *global* IP→sender index is maintained across all
 * ranges, so overlapping or misconfigured ranges still cannot produce a
 * duplicate. The allocator checks both the primary and the secondary slot.
 *
 * Persistence: ./state/multicastLeases.json (atomic write), migrated once from
 * the old ./state/multicast.json on first run.
 */

import { SyncLog } from "./syncLog";

const fs = require("fs");
const path = require("path");

// The category selects which configured range a lease is drawn from, and is
// also the inventory UI badge. Keys match settings.multicastRanges.
export type MulticastCategory = "audio" | "video" | "videoUhd" | "jxsv" | "other";

export const MULTICAST_CATEGORIES: MulticastCategory[] = ["video", "videoUhd", "jxsv", "audio", "other"];

export interface MulticastLease {
    createdAt: string;
    deviceLabel: string;
    nodeId: string;
    category: MulticastCategory;
    channels: number;
    // RESERVED addresses: allocated from the pool and immutable until the
    // lease is released. Even when the user manually overrides a leg with a
    // different address, these stay locked in the pool — clearing the field
    // restores the leg back to its reserved value.
    primaryIp: string;       // odd, reserved for Leg 1
    secondaryIp: string;     // odd+1, reserved for Leg 2 (also held for single-leg senders)
    // Optional per-leg manual overrides. Keys: "0" for Leg 1, "1" for Leg 2.
    // When unset (or empty string), the effective IP for that leg is the
    // reserved address. When set, the override "wins" over the reservation.
    overrideIp?: { [leg: string]: string };
    port: number;
}

export interface LeaseStats {
    used: number;
    total: number;
}

const STATE_PATH = "./state/multicastLeases.json";

export class MulticastLeaseManager {
    private static _instance: MulticastLeaseManager | null = null;
    public static get instance(): MulticastLeaseManager | null { return this._instance; }

    private settings: any;
    private leases: { [senderId: string]: MulticastLease } = {};

    // Global IP claim index. Maps IP → senderId. Includes BOTH primary and
    // secondary IPs of every lease. The allocator and manual-edit paths use
    // this to detect collisions cleanly, regardless of category overlap.
    private ipToSender: Map<string, string> = new Map();

    // Round-robin cursor PER category (uint32, odd-aligned). One shared cursor
    // would be meaningless here, since each category scans a different range.
    private cursors: { [cat: string]: number } = {};

    private onChange: (() => void) | null = null;

    // Optional callback returning the set of destination IPs that are already
    // used by any other live NMOS sender (whether or not it has a lease).
    // Wired up at startup with NmosRegistryConnector.getActiveSenderIps so the
    // allocator can avoid handing out an address that's in use on the wire.
    private externalIpsProvider: ((excludeSenderId: string) => Set<string>) | null = null;

    constructor(settings: any) {
        MulticastLeaseManager._instance = this;
        this.settings = settings;
        this.load();
    }

    setOnChange(cb: (() => void) | null) { this.onChange = cb; }
    setExternalIpsProvider(cb: ((excludeSenderId: string) => Set<string>) | null) { this.externalIpsProvider = cb; }
    private notifyChange() {
        if (this.onChange) {
            try { this.onChange(); } catch { /* swallow */ }
        }
    }

    isEnabled(): boolean {
        return !!(this.settings && this.settings.autoMulticast && this.settings.autoMulticast.enabled);
    }

    setSettings(settings: any) { this.settings = settings; }


    // ----- Public API -----

    /**
     * Make sure a sender has a lease. If one already exists, returns it. If
     * not, attempts to allocate from the appropriate pool — but only when the
     * manager is enabled AND the sender is currently active. Inactive senders
     * are deliberately not given a lease; their address is allocated the
     * moment they transition to active (see reconcileSenderWithLease and the
     * periodic sweep in server.ts).
     */
    ensureLease(args: {
        senderId: string;
        mediaType: string;
        channels: number;
        // Frame size, so a UHD video flow can be drawn from its own range.
        width?: number;
        height?: number;
        // NMOS format urn (urn:x-nmos:format:video / :audio / :data). This is
        // what actually decides the category; media type only refines video.
        format?: string;
        deviceLabel?: string;
        nodeId?: string;
        port?: number;
        isActive?: boolean;
    }): MulticastLease | null {
        if (this.leases[args.senderId]) {
            return this.leases[args.senderId];
        }
        if (!this.isEnabled()) {
            return null;
        }
        // Only allocate for active senders. Inactive ones get their lease
        // the first time they actually go active.
        if (args.isActive === false) {
            return null;
        }

        const category = this.categorise(args.mediaType, { width: args.width, height: args.height, format: args.format });
        if (!category) {
            return null;
        }

        const pair = this.allocatePair(category, args.senderId);
        if (!pair) {
            SyncLog.log("warn", "Multicast Lease", "Pool exhausted in category " + category + " — cannot allocate for " + args.senderId);
            return null;
        }

        const lease: MulticastLease = {
            createdAt: new Date().toISOString(),
            deviceLabel: args.deviceLabel || "",
            nodeId: args.nodeId || "",
            category,
            channels: args.channels,
            primaryIp: pair.primary,
            secondaryIp: pair.secondary,
            port: args.port && args.port > 0 ? args.port : 5004,
        };
        this.leases[args.senderId] = lease;
        this.claimIp(pair.primary,   args.senderId);
        this.claimIp(pair.secondary, args.senderId);

        this.persist();
        this.notifyChange();
        SyncLog.log("info", "Multicast Lease", "Allocated " + pair.primary + " / " + pair.secondary + " for sender " + args.senderId + " (" + category + ")");
        return lease;
    }

    /**
     * Adopt the sender's *current* IS-05 addresses as its lease. Used when
     * the user enables Auto-Allocation but chooses to keep existing
     * configurations rather than force everyone onto fresh pool addresses.
     *
     * The reserved primary/secondary are set to whatever the sender is
     * currently using — even if that's outside the configured pool. The
     * addresses are claimed in the global IP index so the allocator won't
     * re-hand them out.
     *
     * Returns null and skips on collision with another lease (the caller
     * can then fall back to a fresh ensureLease allocation).
     */
    adoptLease(args: {
        senderId: string;
        mediaType: string;
        channels: number;
        width?: number;
        height?: number;
        format?: string;
        deviceLabel?: string;
        nodeId?: string;
        port?: number;
        primaryIp: string;
        secondaryIp?: string;
    }): MulticastLease | null {
        if (this.leases[args.senderId]) {
            return this.leases[args.senderId];
        }
        if (!this.isEnabled()) {
            return null;
        }
        if (!this.ipIsValid(args.primaryIp)) {
            return null;
        }
        const category = this.categorise(args.mediaType, { width: args.width, height: args.height, format: args.format });
        if (!category) {
            return null;
        }

        // Derive a secondary if the caller didn't pass one. Standard ST 2022-7
        // convention: secondary = primary + 1 when primary is odd.
        let secondary = "";
        if (args.secondaryIp && this.ipIsValid(args.secondaryIp)) {
            secondary = args.secondaryIp;
        } else if (this.ipToUint32(args.primaryIp) % 2 === 1) {
            secondary = this.uint32ToIp(this.ipToUint32(args.primaryIp) + 1);
        } else {
            // No usable secondary — single-leg sender; we use primary as both
            // so the index still reserves it from future fresh allocations.
            secondary = args.primaryIp;
        }

        // Collision check: never overwrite another sender's claim.
        const primOwner = this.ipToSender.get(args.primaryIp);
        if (primOwner && primOwner !== args.senderId) {
            SyncLog.log("warn", "Multicast Lease", "Cannot adopt " + args.primaryIp + " for " + args.senderId + " — already claimed by " + primOwner);
            return null;
        }
        if (secondary !== args.primaryIp) {
            const secOwner = this.ipToSender.get(secondary);
            if (secOwner && secOwner !== args.senderId) {
                SyncLog.log("warn", "Multicast Lease", "Cannot adopt secondary " + secondary + " for " + args.senderId + " — already claimed by " + secOwner);
                return null;
            }
        }

        const lease: MulticastLease = {
            createdAt: new Date().toISOString(),
            deviceLabel: args.deviceLabel || "",
            nodeId: args.nodeId || "",
            category,
            channels: args.channels,
            primaryIp: args.primaryIp,
            secondaryIp: secondary,
            port: args.port && args.port > 0 ? args.port : 5004,
        };
        this.leases[args.senderId] = lease;
        this.claimIp(args.primaryIp, args.senderId);
        if (secondary !== args.primaryIp) this.claimIp(secondary, args.senderId);
        this.persist();
        this.notifyChange();
        SyncLog.log("info", "Multicast Lease", "Adopted existing addresses " + args.primaryIp + " / " + secondary + " for sender " + args.senderId + " (" + category + ")");
        return lease;
    }


    /**
     * Get the desired addresses for a sender (i.e. what the IS-05 active
     * transport_params should look like). Returns the effective IPs which
     * may be either the reserved or a manual override. Returns null if no
     * lease exists.
     */
    getDesiredAddresses(senderId: string): { primaryIp: string; secondaryIp: string; port: number } | null {
        const l = this.leases[senderId];
        if (!l) return null;
        return {
            primaryIp:   this.effectiveIpForLeg(l, 0),
            secondaryIp: this.effectiveIpForLeg(l, 1),
            port:        l.port
        };
    }

    getLease(senderId: string): MulticastLease | null {
        return this.leases[senderId] || null;
    }

    /** Effective IP for a given leg — override if set, otherwise reserved. */
    private effectiveIpForLeg(lease: MulticastLease, legIndex: number): string {
        if (lease.overrideIp){
            const o = lease.overrideIp["" + legIndex];
            if (o && this.ipIsValid(o)) return o;
        }
        return legIndex === 0 ? lease.primaryIp : lease.secondaryIp;
    }
    /** Effective IP for a given senderId+leg. Public API for outside callers. */
    getEffectiveIp(senderId: string, legIndex: number): string {
        const l = this.leases[senderId];
        if (!l) return "";
        return this.effectiveIpForLeg(l, legIndex);
    }
    /** Reserved (assigned) IP for a leg — the address the user goes back to on "clear". */
    getReservedIp(senderId: string, legIndex: number): string {
        const l = this.leases[senderId];
        if (!l) return "";
        return legIndex === 0 ? l.primaryIp : l.secondaryIp;
    }

    /**
     * Apply a manual edit from the user. Updates the lease's leg IP and
     * adjusts the global IP index. If the new IP is already claimed by
     * *another* lease, that conflicting lease is fully released — the
     * conflicted sender will reallocate fresh on the next reconcile cycle.
     */
    /**
     * Record a user-driven edit of a leg.
     *
     *   ip = ""           → clear any existing override; effective IP falls
     *                       back to the reserved address.
     *   ip = <valid IP>   → set override for this leg; the reserved address
     *                       stays untouched (still locked in the pool).
     *   ip = undefined    → no IP change; only port is updated (if given).
     */
    recordManualEdit(senderId: string, legIndex: number, ip: string | undefined, port?: number) {
        let lease = this.leases[senderId];
        if (!lease) {
            // No existing lease — we can't classify the sender from here.
            // Reconcile will create one next time we see this sender.
            return;
        }
        if (!lease.overrideIp) lease.overrideIp = {};
        const key = "" + legIndex;
        const reserved = legIndex === 0 ? lease.primaryIp : lease.secondaryIp;
        const previousOverride = lease.overrideIp[key];

        if (ip === undefined) {
            // Caller didn't touch the IP — leave override / reserved as-is.
        } else if (ip === "" || (typeof ip === "string" && ip.trim() === "")) {
            // Explicit clear: remove the override. Effective IP becomes
            // the reserved address again.
            if (previousOverride){
                this.releaseIp(previousOverride, senderId);
                delete lease.overrideIp[key];
            }
            // Make sure the reserved address is still claimed for us
            if (reserved) this.claimIp(reserved, senderId);
        } else {
            const validIp = ip.trim();
            if (!this.ipIsValid(validIp)) {
                SyncLog.log("warn", "Multicast Lease", "recordManualEdit ignored invalid IP: " + validIp);
            } else if (validIp === reserved) {
                // Override matches the reserved value → no actual override.
                if (previousOverride){
                    this.releaseIp(previousOverride, senderId);
                    delete lease.overrideIp[key];
                }
                if (reserved) this.claimIp(reserved, senderId);
            } else {
                // Real override. Evict any other lease that currently holds it.
                this.evictConflict(validIp, senderId);
                if (previousOverride && previousOverride !== validIp){
                    this.releaseIp(previousOverride, senderId);
                }
                lease.overrideIp[key] = validIp;
                this.claimIp(validIp, senderId);
            }
        }

        if (port !== undefined && port > 0) lease.port = port;

        this.persist();
        this.notifyChange();
    }

    /** Release all leases for the given sender IDs (used on device delete). */
    /** Returns how many leases were actually released, so callers can report it. */
    releaseLeases(senderIds: string[]): number {
        let changed = false;
        let released = 0;
        for (const id of senderIds) {
            const l = this.leases[id];
            if (!l) continue;
            this.releaseIp(l.primaryIp,   id);
            this.releaseIp(l.secondaryIp, id);
            // Also release any manual overrides
            if (l.overrideIp){
                for (const k of Object.keys(l.overrideIp)){
                    this.releaseIp(l.overrideIp[k], id);
                }
            }
            delete this.leases[id];
            changed = true;
            released++;
            SyncLog.log("info", "Multicast Lease", "Released lease for sender " + id);
        }
        if (changed) {
            this.persist();
            this.notifyChange();
        }
        return released;
    }


    // ----- Stats / Inventory -----

    /**
     * Capacity per category. Each category has its OWN range, so each gets its
     * own total — a single pool figure would be meaningless here. `pool` is the
     * sum across categories, for a headline number.
     */
    getStats(): { pool: LeaseStats } & { [cat in MulticastCategory]?: LeaseStats } {
        const used: { [cat: string]: number } = {};
        for (const cat of MULTICAST_CATEGORIES) { used[cat] = 0; }
        for (const id in this.leases) {
            const l = this.leases[id];
            if (l && used.hasOwnProperty(l.category)) { used[l.category]++; }
        }

        const out: any = { pool: { used: 0, total: 0 } };
        for (const cat of MULTICAST_CATEGORIES) {
            const range = this.getRangeFor(cat);
            // A category with no configured range has no capacity at all,
            // which the UI should show rather than hide.
            const total = range ? Math.floor((range.end - range.start + 1) / 2) : 0;
            out[cat] = { used: used[cat], total };
            out.pool.used += used[cat];
            out.pool.total += total;
        }
        return out;
    }

    getAllLeases(): { [senderId: string]: MulticastLease } { return this.leases; }

    exportLeases(): any {
        return {
            version: 1,
            exportedAt: new Date().toISOString(),
            leases: this.leases,
        };
    }

    /**
     * Replace the current leases with the imported set. Re-builds the IP
     * index from scratch and silently drops entries that collide (first one
     * wins) to avoid bringing duplicates back in.
     */
    importLeases(data: any): { imported: number; dropped: number } {
        if (!data || typeof data !== "object" || !data.leases || typeof data.leases !== "object") {
            throw new Error("Invalid leases payload");
        }
        const newLeases: { [id: string]: MulticastLease } = {};
        const newIndex: Map<string, string> = new Map();
        let dropped = 0;

        for (const id in data.leases) {
            const raw = data.leases[id];
            if (!raw || !MULTICAST_CATEGORIES.includes(raw.category)) { dropped++; continue; }
            // Same check as load(): an invalid IP drives the reconcile loop forever.
            if (!this.ipIsValid(raw.primaryIp) || !this.ipIsValid(raw.secondaryIp)) { dropped++; continue; }
            if (newIndex.has(raw.primaryIp) || newIndex.has(raw.secondaryIp)) {
                SyncLog.log("warn", "Multicast Lease", "Import dropping duplicate lease for " + id + " — IP already claimed.");
                dropped++;
                continue;
            }
            let cleanedOverrides: { [k:string]: string } | undefined;
            if (raw.overrideIp && typeof raw.overrideIp === "object"){
                cleanedOverrides = {};
                for (const k of Object.keys(raw.overrideIp)){
                    const v = raw.overrideIp[k];
                    if (!v || typeof v !== "string" || !this.ipIsValid(v)) continue;
                    const reserved = (k === "0") ? raw.primaryIp : (k === "1" ? raw.secondaryIp : "");
                    if (v === reserved) continue;
                    if (newIndex.has(v)) continue;
                    cleanedOverrides[k] = v;
                }
                if (Object.keys(cleanedOverrides).length === 0) cleanedOverrides = undefined;
            }
            newLeases[id] = {
                createdAt:   typeof raw.createdAt === "string" ? raw.createdAt : new Date().toISOString(),
                deviceLabel: typeof raw.deviceLabel === "string" ? raw.deviceLabel : "",
                nodeId:      typeof raw.nodeId === "string" ? raw.nodeId : "",
                category:    raw.category,
                channels:    typeof raw.channels === "number" ? raw.channels : 0,
                primaryIp:   raw.primaryIp,
                secondaryIp: raw.secondaryIp,
                overrideIp:  cleanedOverrides,
                port:        typeof raw.port === "number" && raw.port > 0 ? raw.port : 5004,
            };
            newIndex.set(raw.primaryIp,   id);
            newIndex.set(raw.secondaryIp, id);
            if (cleanedOverrides){
                for (const k of Object.keys(cleanedOverrides)){
                    newIndex.set(cleanedOverrides[k], id);
                }
            }
        }
        this.leases = newLeases;
        this.ipToSender = newIndex;
        this.persist();
        this.notifyChange();
        SyncLog.log("info", "Multicast Lease", "Imported " + Object.keys(newLeases).length + " leases, dropped " + dropped + ".");
        return { imported: Object.keys(newLeases).length, dropped };
    }


    // ----- Internal: index helpers -----

    private claimIp(ip: string, senderId: string) {
        if (!ip) return;
        const owner = this.ipToSender.get(ip);
        if (owner && owner !== senderId) {
            SyncLog.log("warn", "Multicast Lease", "claimIp overwrote owner for " + ip + ": " + owner + " → " + senderId);
        }
        this.ipToSender.set(ip, senderId);
    }
    private releaseIp(ip: string, senderId: string) {
        if (!ip) return;
        if (this.ipToSender.get(ip) === senderId) {
            this.ipToSender.delete(ip);
        }
    }
    private evictConflict(ip: string, exceptSenderId: string) {
        const owner = this.ipToSender.get(ip);
        if (!owner || owner === exceptSenderId) return;
        SyncLog.log("warn", "Multicast Lease", "Manual edit claims " + ip + " — releasing conflicting lease of " + owner);
        // Drop the whole conflicting lease; it'll be re-allocated on next reconcile.
        const l = this.leases[owner];
        if (l) {
            this.releaseIp(l.primaryIp,   owner);
            this.releaseIp(l.secondaryIp, owner);
            if (l.overrideIp){
                for (const k of Object.keys(l.overrideIp)){
                    this.releaseIp(l.overrideIp[k], owner);
                }
            }
            delete this.leases[owner];
        }else{
            this.ipToSender.delete(ip);
        }
    }


    // ----- Internal: persistence -----

    /**
     * One-time migration from the old allocator's state file.
     *
     * The previous allocator stored { "nmos_<uuid>": [ {index, multicast} ] }
     * in ./state/multicast.json. Those addresses are live on the network right
     * now, so they are adopted as leases rather than reallocated — a fresh
     * allocation would repoint every sender on first boot and black every
     * receiver until it caught up.
     *
     * Category and frame size are unknown here (that state file recorded
     * neither), so the range a migrated lease sits in is whatever it already
     * occupied. The categories are only used for FUTURE allocations, so the
     * mismatch is cosmetic and self-corrects when a sender is released.
     */
    private migrateLegacyState(): boolean {
        const LEGACY_PATH = "./state/multicast.json";
        try {
            if (!fs.existsSync(LEGACY_PATH)) return false;
            const raw = JSON.parse(fs.readFileSync(LEGACY_PATH, "utf8"));
            if (!raw || typeof raw !== "object") return false;

            let adopted = 0, skipped = 0;
            for (const nmosId in raw) {
                const legs = raw[nmosId];
                if (!Array.isArray(legs) || legs.length === 0) { skipped++; continue; }
                // Keys were namespaced; leases are keyed by bare IS-04 id.
                const senderId = nmosId.startsWith("nmos_") ? nmosId.slice(5) : nmosId;

                let primary = "", secondary = "";
                for (const leg of legs) {
                    if (!leg || typeof leg.multicast !== "string") continue;
                    if (leg.index === 0) primary = leg.multicast;
                    if (leg.index === 1) secondary = leg.multicast;
                }
                if (!this.ipIsValid(primary)) { skipped++; continue; }
                if (this.ipToSender.has(primary)) { skipped++; continue; }
                if (secondary && this.ipToSender.has(secondary)) { secondary = ""; }

                // The old allocator drew legs independently, so the pair is
                // almost never adjacent. Record what is actually on the wire;
                // adjacency only matters for pairs we allocate ourselves.
                const lease: MulticastLease = {
                    createdAt: new Date().toISOString(),
                    deviceLabel: "",
                    nodeId: "",
                    category: "other",
                    channels: 0,
                    primaryIp: primary,
                    secondaryIp: secondary || primary,
                    port: 5004
                };
                this.leases[senderId] = lease;
                this.ipToSender.set(lease.primaryIp, senderId);
                if (lease.secondaryIp !== lease.primaryIp) {
                    this.ipToSender.set(lease.secondaryIp, senderId);
                }
                adopted++;
            }

            if (adopted > 0) {
                SyncLog.log("info", "Multicast Lease",
                    "Migrated " + adopted + " address assignment(s) from ./state/multicast.json" +
                    (skipped > 0 ? " (" + skipped + " skipped)" : "") + ".");
                this.persist();
                return true;
            }
        } catch (e: any) {
            SyncLog.log("warning", "Multicast Lease",
                "Could not migrate ./state/multicast.json - existing addresses may be reallocated.", e);
        }
        return false;
    }

    private load() {
        try {
            if (!fs.existsSync(STATE_PATH)) {
                // No lease file yet: this is either a fresh install or an
                // upgrade from the old allocator.
                this.migrateLegacyState();
                return;
            }
            const raw = fs.readFileSync(STATE_PATH, "utf8");
            const data = JSON.parse(raw);
            if (data && data.leases && typeof data.leases === "object") {
                let dropped = 0;
                for (const id in data.leases) {
                    const l = data.leases[id];
                    if (!l || !MULTICAST_CATEGORIES.includes(l.category)) { dropped++; continue; }

                    // Drop leases with empty / invalid IPs — older bugs could
                    // produce these and they cause an infinite reconcile loop.
                    if (!this.ipIsValid(l.primaryIp) || !this.ipIsValid(l.secondaryIp)) {
                        SyncLog.log("warn", "Multicast Lease", "Dropping lease with invalid IPs on load: " + id + " (primary='" + l.primaryIp + "', secondary='" + l.secondaryIp + "')");
                        dropped++;
                        continue;
                    }

                    // Skip on collision — first lease loaded wins.
                    if (this.ipToSender.has(l.primaryIp) || this.ipToSender.has(l.secondaryIp)) {
                        SyncLog.log("warn", "Multicast Lease", "Skipping duplicate lease on load for sender " + id);
                        dropped++;
                        continue;
                    }
                    // Sanitise overrideIp: drop invalid entries, skip claims
                    // that collide with other leases or with the reserved pair.
                    let cleanedOverrides: { [k: string]: string } | undefined;
                    if (l.overrideIp && typeof l.overrideIp === "object"){
                        cleanedOverrides = {};
                        for (const k of Object.keys(l.overrideIp)){
                            const v = l.overrideIp[k];
                            if (!v || typeof v !== "string" || !this.ipIsValid(v)) continue;
                            // If override matches the reserved IP, just drop it
                            const reserved = (k === "0") ? l.primaryIp : (k === "1" ? l.secondaryIp : "");
                            if (v === reserved) continue;
                            if (this.ipToSender.has(v)) continue;
                            cleanedOverrides[k] = v;
                        }
                        if (Object.keys(cleanedOverrides).length === 0) cleanedOverrides = undefined;
                    }
                    l.overrideIp = cleanedOverrides;

                    this.leases[id] = l;
                    this.ipToSender.set(l.primaryIp,   id);
                    this.ipToSender.set(l.secondaryIp, id);
                    if (cleanedOverrides){
                        for (const k of Object.keys(cleanedOverrides)){
                            this.ipToSender.set(cleanedOverrides[k], id);
                        }
                    }
                }
                SyncLog.log("info", "Multicast Lease", "Loaded " + Object.keys(this.leases).length + " leases from " + STATE_PATH + (dropped > 0 ? " (" + dropped + " dropped)" : ""));
                if (dropped > 0) {
                    // Rewrite a clean file
                    this.persist();
                }
            }
        } catch (e: any) {
            SyncLog.log("warn", "Multicast Lease", "Could not load " + STATE_PATH + ": " + e.message);
        }
    }

    private persist() {
        try {
            const dir = path.dirname(STATE_PATH);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            const tmp = STATE_PATH + ".tmp";
            const data = { version: 1, leases: this.leases };
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
            fs.renameSync(tmp, STATE_PATH);
        } catch (e: any) {
            SyncLog.log("error", "Multicast Lease", "Could not persist " + STATE_PATH + ": " + e.message);
        }
    }


    // ----- Internal: classification & pair allocation -----

    /**
     * Pick the range a sender's lease is drawn from.
     *
     * Unlike upstream this never returns null for a recognised RTP flow —
     * ANC and data land in "other", which has its own configured range. Only
     * a flow with no media_type at all is refused, since we would have no
     * basis to classify it.
     */
    private categorise(mediaType: string, dims?: { width?: number, height?: number, format?: string }): MulticastCategory | null {
        const format = "" + (dims?.format || "");

        // The NMOS FORMAT is the discriminator, not the media type. ANC is
        // carried as media_type "video/smpte291" but format
        // urn:x-nmos:format:data — classifying on media type alone put it in
        // the video range, which the previous allocator did not do and which
        // would quietly consume video capacity.
        if (format) {
            if (format.endsWith(":audio")) return "audio";
            if (!format.endsWith(":video")) return "other";
        } else {
            // No format available: fall back to the media type, still keeping
            // ANC out of the video ranges.
            if (!mediaType) return null;
            if (mediaType.startsWith("audio/")) return "audio";
            if (mediaType.startsWith("video/smpte291")) return "other";
            if (!mediaType.startsWith("video/")) return "other";
        }

        // Video, refined.
        if (mediaType === "video/jxsv") return "jxsv";
        // UHD gets its own range so its bandwidth stays separable at the
        // switch. Anything beyond HD counts.
        const w = Number(dims?.width) || 0;
        const h = Number(dims?.height) || 0;
        if (w > 1920 || h > 1080) return "videoUhd";
        return "video";
    }

    /**
     * The configured range for one category, from settings.multicastRanges.
     *
     * Only `primary` is read. The schema has always carried a `secondary`
     * range too, but every shipped config sets it identical to `primary`, and
     * a lease needs its two legs ADJACENT (odd / odd+1) for ST 2022-7 — which
     * two independent ranges cannot express. So the pair is allocated inside
     * the primary range and `secondary` is ignored.
     */
    private getRangeFor(category: MulticastCategory): { start: number; end: number } | null {
        try {
            const entry = this.settings?.multicastRanges?.[category];
            const cidr = (entry && typeof entry.primary === "string") ? entry.primary : null;
            if (!cidr) return null;
            return this.parseCidr(cidr);
        } catch { return null; }
    }

    /**
     * Find a free odd/even pair in the configured range. Both addresses must
     * be unclaimed globally — guards against overlapping CIDR ranges between
     * categories. Additionally consults the external-IPs provider (live
     * `senderActiveData` snapshot) so we never hand out an address already
     * being transmitted by any other NMOS sender.
     *
     * Returns null if the pool is exhausted.
     */
    private allocatePair(category: MulticastCategory, forSenderId: string): { primary: string; secondary: string } | null {
        const range = this.getRangeFor(category);
        if (!range) return null;

        let firstOdd = (range.start | 1) >>> 0;
        if (firstOdd < range.start) firstOdd = (firstOdd + 2) >>> 0;

        let cursor = this.cursors[category] || 0;
        if (!cursor || cursor < firstOdd || cursor > range.end) {
            cursor = firstOdd;
        }
        // Ensure cursor is odd
        if ((cursor & 1) === 0) cursor = (cursor + 1) >>> 0;

        // External IPs are the ones currently advertised on the wire by any
        // OTHER sender. Polled once per allocate-call (snapshot).
        let externalIps: Set<string> = new Set<string>();
        try{
            if (this.externalIpsProvider){
                externalIps = this.externalIpsProvider(forSenderId) || new Set<string>();
            }
        }catch(e){}

        const pairCount = Math.floor((range.end - range.start + 1) / 2);
        let scanned = 0;
        let ip = cursor;
        while (scanned < pairCount) {
            if (ip + 1 > range.end) {
                ip = firstOdd;
            }
            const primStr = this.uint32ToIp(ip);
            const secStr  = this.uint32ToIp(ip + 1);
            const taken =
                this.ipToSender.has(primStr) || this.ipToSender.has(secStr) ||
                externalIps.has(primStr)     || externalIps.has(secStr);
            if (!taken) {
                this.cursors[category] = (ip + 2) >>> 0;
                return { primary: primStr, secondary: secStr };
            }
            ip = (ip + 2) >>> 0;
            scanned += 1;
        }
        return null;
    }


    // ----- Internal: IP helpers -----

    private parseCidr(cidr: string): { start: number; end: number } {
        const [ipStr, bitsStr] = cidr.split("/");
        const bits = parseInt(bitsStr, 10);
        const base = this.ipToUint32(ipStr);
        const mask = bits === 0 ? 0 : ((0xFFFFFFFF << (32 - bits)) >>> 0);
        const start = (base & mask) >>> 0;
        const end = (start | ((~mask) >>> 0)) >>> 0;
        return { start, end };
    }
    private ipToUint32(ip: string): number {
        const parts = (ip || "").split(".").map(p => parseInt(p, 10));
        if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return 0;
        return (((parts[0] << 24) >>> 0) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    }
    private uint32ToIp(n: number): string {
        return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff].join(".");
    }
    private ipIsValid(ip: string): boolean {
        const parts = (ip || "").split(".");
        if (parts.length !== 4) return false;
        for (const p of parts) {
            const n = parseInt(p, 10);
            if (isNaN(n) || n < 0 || n > 255) return false;
        }
        return true;
    }
}
