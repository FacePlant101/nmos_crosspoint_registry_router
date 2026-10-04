/* 
    NMOS Crosspoint
    Copyright (C) 2021 Johannes Grieb
*/

import * as WebSocket from "ws";
import * as dns from "dns";
import axios from "axios";
import { SyncObject } from "./SyncServer/syncObject";
import { Subject } from "rxjs";

import { setTimeout as sleep } from 'node:timers/promises'

import { LoggedError, SyncLog } from "./syncLog";

import {MdnsService} from "./mdnsService"

import * as jsonpatch from 'fast-json-patch';


import * as sdpTransform from 'sdp-transform';
import { isUsbTransport, isMulticastTransport, nmosIdFromCrosspointId, transportShortCode } from "./functions";
import { CrosspointAbstraction, CrosspointConnectionSenderInfo } from "./crosspointAbstraction";
import { Topology } from "./topology";
import { AtomicNmosStateManager } from "./atomicNmosStateManager";
import { AdvancedNmosCompatibility } from "./advancedNmosCompatibility";
import { PrometheusMetrics } from "./prometheusMetrics";
import { MulticastLeaseManager } from "./multicastLeaseManager";

const fs = require("fs");



export class NmosRegistryConnector {
    private logReset = true;
    static instance:null|NmosRegistryConnector = null;
    public syncNmos: SyncObject;
    public syncConnectionState: SyncObject;

    public static registerHook(type:"nodes"|"devices"|"flows"|"senders"|"receivers"|"sources"|"sendersManifestDetail", callback: (id:string, data:any) => any){
        this.hookCallbackList[type].push(callback);
        if(NmosRegistryConnector.instance){
            Object.keys(NmosRegistryConnector.instance.nmosState[type]).forEach((item)=>{
                callback(item, NmosRegistryConnector.instance.nmosState[type][item]);
            });
        }
    }

    public static registerModifier(type:"nodes"|"devices"|"flows"|"senders"|"receivers"|"sources"|"sendersManifestDetail", callback: (id:string, data:any) => any){
        this.modifierCallbackList[type].push(callback);
    }

    static hookCallbackList = {
        "nodes" : [],
        "devices" : [],
        "sources" : [],
        "senders" : [],
        "receivers" : [],
        "flows" : [],
        "sendersManifestDetail":[]
    }

    static modifierCallbackList = {
        "nodes" : [],
        "devices" : [],
        "sources" : [],
        "senders" : [],
        "receivers" : [],
        "flows" : [],
        "sendersManifestDetail":[]
    }

    settings:any = {};
    private atomicStateManager: AtomicNmosStateManager;
    private advancedCompatibility: AdvancedNmosCompatibility;

    constructor(config:any, loaddev = false) {
        this.settings = config;
        NmosRegistryConnector.instance = this;
        this.syncNmos = new SyncObject("nmos", this.nmosState);
        this.syncConnectionState = new SyncObject("nmosConnectionState");
        
        // Initialize Atomic State Manager for optimized switching performance
        this.atomicStateManager = new AtomicNmosStateManager();
        
        // Initialize Advanced NMOS Compatibility for stream validation and optimization
        this.advancedCompatibility = AdvancedNmosCompatibility.getInstance();

        this.registryVersionList = this.settings.nmos.registryVersions;
        this.connectVersionList = this.settings.nmos.connectVersions

        // TODO dev cleanup
        //if(loaddev){
        if(false){
            try {
                let rawFile = fs.readFileSync("./state/devnmosstate/devnmosstate.json");
                let nmosDev = JSON.parse(rawFile);

                for(let type in nmosDev){
                    for(let path in nmosDev[type]){
                        let postData = nmosDev[type][path];
                            NmosRegistryConnector.modifierCallbackList[type].forEach((f)=>{
                                postData = f(path, postData);
                            })
                            this.nmosState[type][path] = postData;
                            NmosRegistryConnector.hookCallbackList[type].forEach((f)=>{
                                f(path, postData);
                            })
                    }
                }

            } catch (e) {}
            this.scheduleSyncNmos();
            this.updateCrosspoint();
        }
        // ----- dev cleanup

        
        this.settings.staticNmosRegistries.forEach((staticRegistry) => {
            try {
                let registry: NmosRegistry = {
                    ip: staticRegistry.ip,
                    port: staticRegistry.port,
                    priority: staticRegistry.priority,
                    source: "static",
                    domain: staticRegistry.domain,
                };
                this.addRegistry(registry);
                SyncLog.log("info","NMOS Settings","Adding Static Registry: "+ JSON.stringify(staticRegistry) );
            } catch (e) {
                SyncLog.log("error","NMOS Settings","Can not add Static Registry: "+ JSON.stringify(staticRegistry) );
            }
        });
    


        setTimeout(()=>{
            this.mdnsQuery();
        },5000);
        this.mdnsQueryInterval = setInterval(() => {
            this.mdnsQuery();
        }, 20000);

        // Unicast DNS-SD runs on its own, slower cadence: it is a handful of
        // ordinary DNS lookups, not multicast traffic, so re-querying every
        // 60 s is enough to pick up a registry that appears later.
        this.dnssdQuery();
        this.dnssdQueryInterval = setInterval(() => {
            this.dnssdQuery();
        }, 60000);

        MdnsService.registerHook((response) => {
            response.answers.forEach((answer) => {
                
                if (answer.name == "_nmos-registration._tcp.local") {
                    let registry: NmosRegistry = { ip: "0.0.0.0", port: 0, priority: 1000, source: "mdns", domain: "" };
                    response.additionals.forEach((element) => {
                        if (element.type == "A") {
                            registry.ip = element.data;
                        }
                        if (element.type == "SRV") {
                            registry.port = element.data.port;
                            registry.domain = element.data.target;
                        }
                    });
                    if (registry.port != 0 && registry.ip != "0.0.0.0") {
                        this.addRegistry(registry);
                    }
                }
            });
        });
    }

    // Discovery cascade: an operator-entered address (static config or a
    // runtime manual add) always outranks automatic discovery, and unicast
    // DNS-SD beats mDNS. Used to decide which source label wins when the same
    // endpoint is found twice — see addRegistry.
    private static sourceRank(source: string): number {
        if (source === "static" || source === "manual") return 3;
        if (source === "dnssd") return 2;
        return 1; // mdns
    }

    /** The DNS-SD domains to query: the configured override if set, otherwise
     *  the system resolver's search domains. Reading /etc/resolv.conf works in
     *  the container and on Linux hosts; anywhere else the empty list is a
     *  clean no-op and we fall back to mDNS / the static registry. */
    private dnssdSearchDomains(): string[] {
        let cfg = "";
        try { cfg = ("" + (this.settings?.registryDiscovery?.domain || "")).trim().replace(/\.+$/, ""); } catch (e) {}
        if (cfg) { return [cfg]; }
        try {
            const txt = fs.readFileSync("/etc/resolv.conf", "utf8");
            const domains: string[] = [];
            for (const line of ("" + txt).split("\n")) {
                const m = line.match(/^\s*(search|domain)\s+(.+)$/);
                if (!m) continue;
                for (const d of m[2].trim().split(/\s+/)) {
                    // "local" belongs to mDNS, which we already query separately.
                    const clean = d.trim().replace(/\.+$/, "");
                    if (clean && clean !== "local" && !domains.includes(clean)) { domains.push(clean); }
                }
            }
            return domains;
        } catch (e) { return []; }
    }

    /** Unicast DNS-SD (RFC 6763 over ordinary DNS):
     *  PTR on _nmos-register._tcp.<domain> (plus the deprecated
     *  _nmos-registration._tcp name) -> SRV per instance -> A record.
     *  This finds a registry on a routed network where mDNS cannot reach. */
    private async dnssdQuery() {
        // Resolve the domains before the enabled check, so the Setup page can
        // always show what *would* be searched.
        const domains = this.dnssdSearchDomains();
        const domainsChanged = domains.join(",") !== this.lastDnssdDomains.join(",");
        this.lastDnssdDomains = domains;
        if (domainsChanged) { this.updateSyncConnectionState(); }

        try {
            if (this.settings?.registryDiscovery?.unicastDnssd === false) return;
        } catch (e) {}

        if (domains.length === 0) {
            if (!this.loggedDnssdNoDomain) {
                this.loggedDnssdNoDomain = true;
                SyncLog.log("verbose", "NMOS", "Unicast DNS-SD discovery: no DNS search domain found and none configured - relying on mDNS / static registry.");
            }
            return;
        }

        const services = ["_nmos-register._tcp.", "_nmos-registration._tcp."];
        for (const domain of domains) {
            for (const svc of services) {
                let instances: string[] = [];
                try { instances = await dns.promises.resolvePtr(svc + domain); }
                catch (e) { continue; }   // NXDOMAIN and friends - try the next name
                for (const inst of instances) {
                    try {
                        const srvs = await dns.promises.resolveSrv(inst);
                        for (const srv of srvs) {
                            const target = ("" + srv.name).replace(/\.+$/, "");
                            if (!target || !srv.port) continue;
                            let ip = target;
                            try {
                                const addrs = await dns.promises.resolve4(target);
                                if (addrs.length > 0) { ip = addrs[0]; }
                            } catch (e) { /* keep the hostname - it works in the URL too */ }
                            this.addRegistry({
                                ip,
                                port: srv.port,
                                priority: (typeof srv.priority === "number") ? srv.priority : 100,
                                source: "dnssd",
                                domain,
                            });
                        }
                    } catch (e) { /* instance without SRV - skip */ }
                }
            }
        }
    }

    private mdnsQuery() {
        MdnsService.query({
            questions: [
                {
                    name: "_nmos-registration._tcp.local",
                    type: "PTR",
                    class: "IN",
                },
            ],
        });
    }
    private addRegistry(registry: NmosRegistry) {
        const rank = NmosRegistryConnector.sourceRank(registry.source);

        // Already known endpoint: keep the existing connection and only
        // relabel it when a higher-ranked source confirms the same address.
        // The old code relabelled whenever the entry was not "static", so a
        // periodic mDNS answer could downgrade a manual entry's source.
        for (let i = 0; i < this.nmosRegistryList.length; i++) {
            const el = this.nmosRegistryList[i];
            if (el.ip + ":" + el.port == registry.ip + ":" + registry.port) {
                if (rank > NmosRegistryConnector.sourceRank(el.source)) {
                    this.nmosRegistryList[i] = registry;
                    this.updateSyncConnectionState();
                }
                return;
            }
        }

        // NOTE we deliberately do NOT tear down lower-ranked registries here.
        // Exclusive source arbitration needs the generation counter that makes
        // lingering reconnect timers bail out; without it a stale timer would
        // simply resurrect a registry we just dropped. Until then we connect
        // to every distinct endpoint, as before, and only note the ranking.
        let bestRank = 0;
        for (const el of this.nmosRegistryList) {
            bestRank = Math.max(bestRank, NmosRegistryConnector.sourceRank(el.source));
        }
        if (bestRank > rank) {
            SyncLog.log("verbose", "NMOS Settings",
                "Registry " + registry.ip + ":" + registry.port + " found via " + registry.source +
                ", but a higher-priority source is already connected.");
        }

        this.nmosRegistryList.push(registry);
        SyncLog.log("info","NMOS Settings","Adding Registry ("+registry.source+"): "+registry.ip + ":"+registry.port );
        this.connectRegistry(registry);

        this.updateSyncConnectionState();
    }

    // Public method to add manual NMOS registry
    public addManualRegistry(ip: string, port: number) {
        const registry: NmosRegistry = {
            ip: ip,
            port: port,
            priority: 100, // Higher priority than mdns discoveries
            source: "manual",
            domain: ""
        };
        
        SyncLog.log("info", "NMOS Settings", "Adding Manual Registry: " + ip + ":" + port);
        this.addRegistry(registry);
    }

    connectRegistry(registry: NmosRegistry) {
        // TODO: disconnects and reconnects

        const url = "http://" + registry.ip + ":" + registry.port + "";
        this.getSubscription(url, "/nodes");
        this.getSubscription(url, "/devices");
        this.getSubscription(url, "/sources");
        this.getSubscription(url, "/senders");
        this.getSubscription(url, "/receivers");
        this.getSubscription(url, "/flows");
    }

    private mdnsQueryInterval = null;
    private dnssdQueryInterval: any = null;
    private loggedDnssdNoDomain = false;
    // Domains the last DNS-SD pass would query (override or the resolv.conf
    // search list). Surfaced on the connection-state channel so the Setup page
    // can show what is actually being searched.
    private lastDnssdDomains: string[] = [];
    private mdnsBrowser: any = null;
    private registryVersionList = ["v1.3","v1.2"];
    private connectVersionList = ["v1.1", "v1.0"];
    private channelmappingVersionList = ["v1.0"];
    private nmosRegistryList: NmosRegistry[] = [];


    // ----- syncNmos coalescing -----
    // A busy registry fires dozens of WebSocket grains per second, and the raw
    // flow called syncNmos.setState() on EVERY one. setState deep-clones the
    // whole nmosState and runs a full JSON-patch diff against the previous
    // copy — on a registry with thousands of senders and flows that is
    // milliseconds of CPU per call, burnt even for a no-op version bump.
    // Coalescing collapses a burst of N grains into one clone+diff+broadcast.
    // The published state is always the latest, because nmosState is read at
    // flush time rather than captured at schedule time.
    //
    // NOTE the payload still includes sendersManifestDetail, which dominates
    // its size. Dropping it needs details.svelte to fetch single SDPs through
    // the senderSdp route instead of reading them out of this channel.
    private syncNmosTimer: any = null;
    private scheduleSyncNmos() {
        if (this.syncNmosTimer != null) return;
        this.syncNmosTimer = setTimeout(() => {
            this.syncNmosTimer = null;
            try {
                // Recomputed on publish so the UI never annotates stale
                // conflicts against fresh transport params.
                this.nmosState.multicastConflicts = this.getMulticastConflicts();
            } catch (e) {}
            try { this.syncNmos.setState(this.nmosState); } catch (e) {}
        }, 80);
    }

    // Senders with an active-data fetch already pending, so a burst of events
    // cannot stack several retry chains on one sender.
    private activeRetryPending: { [senderId: string]: boolean } = {};

    /**
     * Retry a failed IS-05 active fetch with a short backoff.
     *
     * Bounded at three attempts: beyond that the device is not merely busy, and
     * the 30 s lease sweep will pick it up anyway.
     */
    private scheduleActiveRetry(senderId: string, hrefs: string[], attempt: number) {
        if (attempt > 3) { return; }
        if (this.activeRetryPending[senderId]) { return; }
        this.activeRetryPending[senderId] = true;

        setTimeout(async () => {
            this.activeRetryPending[senderId] = false;
            // The sender may have gone away while we waited.
            if (!this.nmosState.senders?.[senderId]) { return; }
            for (const href of hrefs) {
                try {
                    const response = await axios.get(href);
                    this.nmosState.senderActiveData[senderId] = response.data;
                    try { this.reconcileSenderWithLease(senderId); } catch (e) {}
                    this.scheduleSyncNmos();
                    this.updateCrosspoint();
                    return;
                } catch (e) { /* try the next href, then re-schedule below */ }
            }
            this.scheduleActiveRetry(senderId, hrefs, attempt + 1);
        }, 1000 * attempt);
    }

    /** Raw + parsed SDP for one sender, for the UI's SDP viewer and the audio
     *  monitor. Reading it on demand keeps single-sender lookups off the
     *  broadcast channel. */
    public getSenderSdp(senderId: string): any {
        try {
            const d = this.nmosState["sendersManifestDetail"][senderId];
            if (!d) return null;
            return { raw: d._RAWSDP || "", parsed: d };
        } catch (e) { return null; }
    }

    updateCrosspointTimer:any = null;
    updateCrosspointLimit = 0;
    updateCrosspoint(){
        if(this.updateCrosspointTimer != null){
            if(this.updateCrosspointLimit < 10){
                this.updateCrosspointLimit++;
            }else{
                return;
            }
        }
        if(this.updateCrosspointTimer != null){
            clearTimeout(this.updateCrosspointTimer);
            this.updateCrosspointTimer = null;
        }
        this.updateCrosspointTimer = setTimeout(()=>{
            this.updateCrosspointLimit = 0;
            this.updateCrosspointTimer = null;
            if (CrosspointAbstraction.instance) {
                CrosspointAbstraction.instance.updateFromNmos(this.nmosState);
            }
            
            // Update Prometheus metrics with NMOS data
            this.updatePrometheusMetrics();
            // Topology may be disabled via settings.disabledModules.core; guard access
            if (Topology.instance && typeof Topology.instance.updateDevicesFromNmos === "function") {
                Topology.instance.updateDevicesFromNmos(this.nmosState);
            }
        },100);
    }

    private updatePrometheusMetrics(): void {
        const prometheusMetrics = PrometheusMetrics.getInstance();
        if (!prometheusMetrics) return;

        // Count devices, senders, and receivers
        const deviceCount = Object.keys(this.nmosState.devices || {}).length;
        const senderCount = Object.keys(this.nmosState.senders || {}).length;
        const receiverCount = Object.keys(this.nmosState.receivers || {}).length;

        // Get registry connection status
        const registries = this.nmosRegistryList.map(registry => {
            const url = `http://${registry.ip}:${registry.port}`;
            const hasConnections = Object.keys(this.connections).some(connectionKey => 
                connectionKey.startsWith(url) && 
                this.connections[connectionKey].ws.readyState === WebSocket.OPEN
            );
            return {
                url: `${registry.ip}:${registry.port}`,
                connected: hasConnections
            };
        });

        // Update NMOS metrics
        prometheusMetrics.updateNmosRegistryMetrics(registries, deviceCount, senderCount, receiverCount);
    }

    private nmosState = {
        devices: {},
        sources: {},
        senders: {},
        receivers: {},
        flows: {},
        nodes: {},
        senderActiveData:{},
        // address -> sender ids claiming it, only where more than one does.
        multicastConflicts:{},
        channelmapping:{},
        sendersManifestDetail :{}
    };
    private connections = {};

    /**
     * Get read-only access to NMOS state for latency measurement and other purposes
     */
    public getNmosState(): any {
        return this.nmosState;
    }

    /**
     * Resolve the NMOS device id owning a crosspoint sender/receiver flow id.
     *
     * Flow ids are always "nmos_" + the NMOS resource id, so this works regardless of the
     * prefix on the crosspoint *device* that contains the flow. Legacy "nmosgrp_" device ids
     * are md5 hashes and cannot be resolved directly, which is why callers should come in via
     * a flow rather than a device id.
     */
    public static nmosDeviceIdFromFlowId(flowId: string): string {
        const nmosState = NmosRegistryConnector.instance?.getNmosState?.();
        if(!nmosState){ return ""; }
        const resourceId = nmosIdFromCrosspointId(flowId);
        return nmosState.receivers?.[resourceId]?.device_id
            ?? nmosState.senders?.[resourceId]?.device_id
            ?? "";
    }

    /**
     * Identify a Matrox ConvertIP device from its NMOS device record, preferring the vendor
     * control/tags over the device label (labels are user editable).
     */
    public static isMatroxCipDevice(nmosDeviceId: string): boolean {
        const nmosState = NmosRegistryConnector.instance?.getNmosState?.();
        const nmosDevice = nmosState?.devices?.[nmosDeviceId];
        if(!nmosDevice){ return false; }

        const tags = (nmosDevice.tags ?? {}) as Record<string, string[]>;
        const manufacturer = tags["urn:x-nmos:tag:asset:manufacturer/v1.0"]?.[0];
        const product = tags["urn:x-nmos:tag:asset:product/v1.0"]?.[0];
        const controls = Array.isArray(nmosDevice.controls) ? nmosDevice.controls : [];
        const hasMatroxWebUi = controls.some((control: any) => control?.type === "urn:x-matrox:cip:webui");
        const description = typeof nmosDevice.description === "string" ? nmosDevice.description.toLowerCase() : "";

        return (
            hasMatroxWebUi ||
            (typeof manufacturer === "string" && manufacturer.toLowerCase() === "matrox" &&
                typeof product === "string" && product.toLowerCase() === "convertip") ||
            description.includes("matrox")
        );
    }


    private getSubscription(nmosRegistryUrl: string, resource: string) {
        this.registryVersionList.forEach((version)=>{
            this.getVersionSubscription(nmosRegistryUrl,resource,version );
        })
    }

    private getVersionSubscription(nmosRegistryUrl: string, resource: string, version:string){
        axios.post(nmosRegistryUrl + "/x-nmos/query/" + version + "/subscriptions", {
            resource_path: resource,
            params: {},
            persist: false,
            max_update_rate_ms: 50,
        }).then((response: any) => {
            this.logReset = true;
            let subscription = response.data;
            let fullResource = nmosRegistryUrl + "_" + resource + "_" + version;
            if (this.connections[fullResource]) {
                this.connections[fullResource].ws.onmessage = (message) => {};
                try{
                    this.connections[fullResource].ws.close();
                }catch(e){}
            }
            this.connections[fullResource] = {
                version,
                subscription,
                ws: new WebSocket(subscription.ws_href),
            };

            // NOTE this used to assign a plain property called `error`, which
            // is not an event handler — `ws` needs `onerror`. With no handler
            // attached, a socket error is emitted as an unhandled 'error'
            // event and takes the WHOLE SERVER down: a registry that moved or
            // closed its subscription websocket port crashed the process.
            // `ws` always emits 'close' after 'error', so the reconnect below
            // still drives retries; this handler only has to log.
            this.connections[fullResource].ws.onerror = (event: any) => {
                this.connections[fullResource].ws.onmessage = (message) => {};
                SyncLog.log("warning", "NMOS",
                    "Subscription websocket error for Registry: " + nmosRegistryUrl + ", " + resource + ", " + version +
                    (event && event.message ? " (" + event.message + ")" : ""));
            };

            this.connections[fullResource].ws.onclose = () => {
                this.connections[fullResource].ws.onmessage = (message) => {};
                
                SyncLog.log("error",  "NMOS","Closed subscription to Registry: " + nmosRegistryUrl + ", " + resource + ", " + version );
                setTimeout(()=>{
                    this.getVersionSubscription(nmosRegistryUrl,resource,version );
                },1000)
                this.updateSyncConnectionState();
            };
            this.connections[fullResource].ws.onopen = () => {
                this.updateSyncConnectionState();
            };

            this.connections[fullResource].ws.onmessage = (message) => {
                this.updateState(JSON.parse(message.data),version);
            };
            
            SyncLog.log("info",  "NMOS","Subscribed to Registry: " + nmosRegistryUrl + ", " + resource + ", " + version );
        }).catch((error) => {
            
            //console.log(error);
            	setTimeout(()=>{
                    this.getVersionSubscription(nmosRegistryUrl,resource,version );
                },20000)
                if(this.logReset){
                    this.logReset = false;
                    SyncLog.log("error",  "NMOS","Error While creating NMOS Subscription on Registry: " + nmosRegistryUrl + ", " + resource + ", " + version, {message:error.message});
                }
        });
    }

    private versionIsPrefered(oldVersion:string, newVersion:string, registry=true){
        let list = this.registryVersionList;
        if(!registry){
            list = this.connectVersionList
        }
        let newIndex = list.indexOf(newVersion);
        let oldIndex = list.indexOf(oldVersion)
        if(newIndex <= oldIndex){
            return true;
        }
        return false;

    }

    updateNewNmosItemTimer:any|null = null;
    private updateState(message: any, version:string) {
        //console.log("updates from registry: " + message.type)
        let newItem = false;
        let type = "";
        let changes = false;
        let changesConnect = false;
        try {
            type = (message.grain.topic as string).split("/").join("");
        } catch (e) {}
        
        SyncLog.log("debug", "atomic_nmos", `Processing state update for type: ${type}`);
        
        if (this.nmosState[type]) {
            message.grain.data.forEach((g: any) => {
                if (g.hasOwnProperty("path") && typeof g.path == "string") {
                    if (g.hasOwnProperty("post")) {
                        // add or update element
                        if (typeof g.post == "object") {
                            if(this.nmosState[type][g.path] && !this.versionIsPrefered(this.nmosState[type][g.path]["_sourceVersion"], version)){
                                // do not update - version preference check failed
                                return;
                            }

                            let postData = g.post;
                            NmosRegistryConnector.modifierCallbackList[type].forEach((f)=>{
                                postData = f(g.path, postData);
                            })
                            
                            const isNewItem = !this.nmosState[type].hasOwnProperty(g.path);
                            if(isNewItem){
                                newItem = true;
                                changes = true;
                            }

                            postData["_sourceVersion"] = version;
                            let diff: jsonpatch.Operation[] = [];
                            let isVersionOnlyChange = false;
                            if(!isNewItem && type !== "sources" && type !== "flows"){
                                diff = jsonpatch.compare(this.nmosState[type][g.path], postData);
                                isVersionOnlyChange = diff.length === 0 || diff.every((d)=>
                                    d.op === "replace" && (d.path === "/version" || d.path === "/_sourceVersion")
                                );
                            }

                            // **ATOMIC STATE MANAGEMENT**: Route updates through atomic state manager
                            try {
                                if (type === "sources") {
                                    // Immutable sources - create new version if changed
                                    const atomicSourceId = this.atomicStateManager.createImmutableSource(
                                        g.path, postData, version
                                    );
                                    SyncLog.log("debug", "atomic_nmos", 
                                        `Atomic source update: ${g.path} -> ${atomicSourceId}`);
                                } else if (type === "flows") {
                                    // Immutable flows - create new version if changed
                                    const parentSources = postData.parents || [];
                                    const atomicFlowId = this.atomicStateManager.createImmutableFlow(
                                        g.path, postData, version, parentSources
                                    );
                                    SyncLog.log("debug", "atomic_nmos", 
                                        `Atomic flow update: ${g.path} -> ${atomicFlowId}`);
                                } else if (type === "senders") {
                                    // Mutable senders - can be updated in place
                                    this.atomicStateManager.updateMutableSender(g.path, postData, version);
                                    SyncLog.log("debug", "atomic_nmos", 
                                        `Atomic sender update: ${g.path}`);
                                } else if (type === "receivers") {
                                    // Mutable receivers - can be updated in place
                                    this.atomicStateManager.updateMutableReceiver(g.path, postData, version);
                                    
                                    // Check for connection changes for performance optimization
                                    if (!isNewItem) {
                                        const oldData = this.nmosState[type][g.path];
                                        const oldSenderId = oldData?.subscription?.sender_id;
                                        const newSenderId = postData?.subscription?.sender_id;
                                        if (oldSenderId !== newSenderId) {
                                            changesConnect = true;
                                            changes = true;
                                            SyncLog.log("info", "atomic_nmos", 
                                                `Connection change detected: receiver ${g.path} from ${oldSenderId} to ${newSenderId}`);
                                        }
                                    }
                                    
                                    SyncLog.log("debug", "atomic_nmos", 
                                        `Atomic receiver update: ${g.path}`);
                                }
                                
                                // Continue with legacy state management for backward compatibility
                                const shouldInvokeHooks = type !== "nodes" || isNewItem || !isVersionOnlyChange;
                                if (shouldInvokeHooks) {
                                    NmosRegistryConnector.hookCallbackList[type].forEach((f)=>{
                                        f(g.path, postData);
                                    })
                                }

                                if(!isNewItem && type !== "sources" && type !== "flows"){
                                    // For mutable resources, check for changes (sources/flows are always immutable)
                                    if(!isVersionOnlyChange){
                                        changes = true;
                                    }
                                }

                                if(changes && type == "devices"){
                                    this.loadChannelMaping(postData);
                                }

                                // Maintain legacy state for compatibility
                                this.nmosState[type][g.path] = postData;
                                
                            } catch (atomicError) {
                                SyncLog.log("error", "atomic_nmos", 
                                    `Atomic state update failed for ${type}/${g.path}: ${atomicError.message}`);
                                // Fallback to legacy state management
                                this.nmosState[type][g.path] = postData;
                            }
                        }
                    } else {
                        // remove element
                        try {
                            if(this.nmosState[type][g.path]["_sourceVersion"] == version){
                                delete this.nmosState[type][g.path];
                                changes = true;
                                SyncLog.log("debug", "atomic_nmos", 
                                    `Removed ${type} resource: ${g.path}`);
                            }
                        } catch (e) {}
                    }
                }
            });
        }
        // TODO
        //fs.writeFileSync("./state/devnmosstate/devnmosstate.json", JSON.stringify(this.nmosState));
        this.scheduleSyncNmos();
        if(newItem){
            if(this.updateNewNmosItemTimer){
                clearTimeout(this.updateNewNmosItemTimer);
            }
            this.updateNewNmosItemTimer = setTimeout(() => {
                this.updateNewNmosItemTimer = null;
                this.updateCrosspoint();
            }, 1000);
            
        }else{
            if(changes){
                if(this.updateNewNmosItemTimer){

                }else{
                    this.updateCrosspoint();
                }
            }
        }

        
                message.grain.data.forEach((g: any) => {


                    if (type == "senders" || type == "flows") {
                        setTimeout(()=>{
                            this.getSenderManifestData(type, g);
                        },200);
                        setTimeout(()=>{
                            this.getSenderManifestData(type, g);
                        },5000);
                    }

                    if(type == "senders"){
                        setTimeout(()=>{
                            this.getSenderActive(type, g);
                        },100);
                    }
                });


        

    }

    async loadChannelMaping(postData:any){
        let cmLoaded = false;
        for(let c of postData.controls){
            // TODO: other versions
            if(c.type=="urn:x-nmos:control:cm-ctrl/v1.0"){
                try{
                    let io = await axios.get(c.href + "/io");
                    let map = await axios.get(c.href + "/map/active");

                    for(let k in io.data.outputs){

                        let data = io.data.outputs[k];
                        if(data.source_id == null){
                            data["receivers"] = [];

                            
                            for(let inId of io.data.outputs[k].caps.routable_inputs){
                                try{
                                    if(io.data.inputs[inId].parent.type = "receiver"){
                                        data["receivers"].push(io.data.inputs[inId].parent.id)
                                    }
                                }catch(e){}
                            }
                            
                            if(data.receivers.length > 0){
                                this.nmosState.channelmapping[k] = data;
                            }
                        }
                    }

                
                    cmLoaded = true;
                    

                }catch(e){
                    //console.log(e);
                }
            }
        }

        this.scheduleSyncNmos();
        this.updateCrosspoint();

    }



    /** Fetch and store one sender's SDP manifest.
     *  A single retry after 5 s covers the common case of a device that has
     *  only just announced its sender and is not serving the manifest yet;
     *  without it that sender stayed without an SDP until its next update. */
    private fetchSenderManifest(href: string, senderId: string, label: string, allowRetry: boolean) {
        axios.get(href).then(response => {
            if (response.data.length > 10) {
                // TODO Check for BAD SDP Files, is this already enough, more than 10 chars and more than 0 flows
                let sdp = sdpTransform.parse(response.data);
                sdp["_RAWSDP"] = response.data;
                if (sdp.media.length == 0) {
                    SyncLog.log("warning", "NMOS", "Got BAD SDP File for Flow: " + label + " ( ID: " + senderId + " )")
                    try {
                        // TODO Test
                        delete this.nmosState["sendersManifestDetail"][senderId];
                        this.scheduleSyncNmos();
                    } catch (e) {}
                } else {
                    if (this.nmosState["sendersManifestDetail"][senderId] && this.nmosState["sendersManifestDetail"][senderId]._RAWSDP && this.nmosState["sendersManifestDetail"][senderId]._RAWSDP.length > 10) {
                        if (this.nmosState["sendersManifestDetail"][senderId]._RAWSDP != sdp["_RAWSDP"]) {
                            this.reconnectOnChanges(senderId);
                        }
                    }
                    this.nmosState["sendersManifestDetail"][senderId] = sdp;
                    this.scheduleSyncNmos();
                    this.updateCrosspoint();
                }
            } else {
                SyncLog.log("warning", "NMOS", "Got BAD SDP File for Flow: " + label + " ( ID: " + senderId + " )")
                try {
                    // TODO Test
                    delete this.nmosState["sendersManifestDetail"][senderId];
                } catch (e) {}
            }
        }).catch(e => {
            if (allowRetry) {
                SyncLog.log("verbose", "NMOS", "SDP fetch failed for Flow: " + label + " ( ID: " + senderId + " ) - retrying once in 5s.");
                setTimeout(() => {
                    this.fetchSenderManifest(href, senderId, label, false);
                }, 5000);
                return;
            }
            SyncLog.log("warning", "NMOS", "Can not get SDP File for Flow: " + label + " ( ID: " + senderId + " )")
        });
    }

    getSenderManifestData(type:string, g:any){
        if (g.hasOwnProperty("path") && typeof g.path == "string") {
            if (g.hasOwnProperty("post")) {
                // add or update element
                if (typeof g.post == "object") {

                    let manifest_href = "";
                    let active = false;
                    let senderId = "";
                    let label = "";

                    let source:any = null;
                    try{

                        if (type == "senders") {
                            source = g.post;
                            senderId = g.path;
                        }
                        if (type == "flows") {
                            source = this.nmosState.senders[g.post.source_id];
                            senderId = g.post.source_id;
                        }

                    
                        if(source && source.hasOwnProperty("manifest_href")){
                            manifest_href = source.manifest_href;
                            active = source.subscription?.active;
                            senderId = g.path;
                            label = g.post.label
                        }
                        
                    }catch(e){}

                    
                    if (manifest_href && active && senderId) {
                        // NOTE this used to fetch g.post.manifest_href. For
                        // type == "flows" the manifest_href lives on the
                        // referenced SENDER, not on the flow, so g.post had no
                        // such field and every flow-triggered refresh fetched
                        // undefined and failed. Use the resolved href.
                        this.fetchSenderManifest(manifest_href, senderId, label, true);
                    }
                }
            } else {
                if (type == "senders") {
                    // remove element
                    try {
                        delete this.nmosState["sendersManifestDetail"][g.path];
                        this.scheduleSyncNmos();
                        this.updateCrosspoint();
                    } catch (e) {}
                    
                }
            }
        }
    }


    async getSenderActive(type:string, g:any){
        if (g.hasOwnProperty("path") && typeof g.path == "string") {
            if (g.hasOwnProperty("post")) {
                // add or update element
                if (typeof g.post == "object") {

                    let active_href = [];
                    let senderId = "";
                    let sender = null;
                    let device = null;


                    try{
                        senderId = g.path;
                        sender = g.post;
                        device = this.nmosState.devices[sender.device_id];

                        // Prefer v1.1 and fall back to v1.0, the same order
                        // setFlowMulticast uses. This only accepted v1.0, so a
                        // device advertising both was pinned to the older API
                        // for reads while being written through the newer one.
                        for(const wanted of ["urn:x-nmos:control:sr-ctrl/v1.1", "urn:x-nmos:control:sr-ctrl/v1.0"]){
                            device.controls.forEach((c)=>{
                                if(c.type == wanted){
                                    let href = c.href;
                                    if(href[href.length-1] != "/"){
                                        href += "/";
                                    }
                                    href += "single/senders/"+senderId+"/active/";
                                    active_href.push(href)
                                }
                            });
                        }
                        
                        
                    }catch(e){}

                    if(active_href.length == 0){
                        SyncLog.log("warn", "NMOS", "Can not get active configuration of sender, no controls available.")
                    }

                    let gotActive = false;
                    for(let href of active_href){
                        try{
                            let response = await axios.get(href);
                            this.nmosState.senderActiveData[senderId] = response.data;
                            // Now that we know what the sender is really
                            // transmitting on, it can be compared with its lease.
                            try{ this.reconcileSenderWithLease(senderId); }catch(e){}
                            // NOTE this used to `return` here, so a SUCCESSFUL
                            // fetch skipped the publish below and the new active
                            // data sat unpublished until some unrelated event
                            // came along. Break instead, so the store is always
                            // followed by a publish.
                            gotActive = true;
                            break;
                        }catch(e:any){
                            // 409 Conflict means the device is mid-activation —
                            // which this controller itself causes when a lease
                            // sweep PATCHes several senders at once. Treating it
                            // as fatal left those senders with no active data
                            // until some unrelated event came along, so retry
                            // transient failures a few times before giving up.
                            const status = e?.response?.status;
                            const transient = (status === 409 || status === 423 || status === 503 || status === undefined);
                            SyncLog.log(transient ? "verbose" : "warning", "NMOS",
                                "Can not get active configuration of sender:",
                                {error: e.message, status, href});
                        }
                    }
                    if(!gotActive && active_href.length > 0){
                        this.scheduleActiveRetry(senderId, active_href, 1);
                    }

                    this.scheduleSyncNmos();
                    this.updateCrosspoint();
                }
            } else {
                if (type == "senders") {
                    // remove element
                    try {
                        delete this.nmosState.senderActiveData[g.path];
                        this.scheduleSyncNmos();
                        this.updateCrosspoint();
                    } catch (e) {}
                    
                }
            }
        }
    }

    updateSyncConnectionState() {
        let list = [];
        this.nmosRegistryList.forEach((registry) => {
            let entry:any = structuredClone(registry);
            //let entry = JSON.parse(JSON.stringify(registry));
            entry.connected = [];
            try {
                const url = "http://" + registry.ip + ":" + registry.port + "";
                let endpoints = ["nodes", "devices", "sources", "senders", "receivers", "flows"];
                endpoints.forEach((e) => {
                    Object.keys(this.connections).forEach((c)=>{
                        if(c.startsWith(url + "_/" + e )){
                            if (this.connections[c].ws.readyState == WebSocket.OPEN) {
                                entry.connected.push({endpoint:e, version:this.connections[c].version, connected:true});
                            }else{
                                entry.connected.push({endpoint:e, version:this.connections[c].version, connected:false});
                            }
                        }
                    })
                });
            } catch (e) {}
            list.push(entry);
        });
        this.syncConnectionState.setState({
            registries: list,
            // What unicast DNS-SD is searching, so the Setup page can explain
            // "no registry found" without the operator guessing.
            discovery: {
                unicastDnssd: this.settings?.registryDiscovery?.unicastDnssd !== false,
                domains: this.lastDnssdDomains
            }
        });
        setTimeout(()=>{
            this.updateSyncConnectionState();
        },2000)
    }


    reconnectOnChanges(senderId:string){
        CrosspointAbstraction.instance.reconnectOnChangesFromNmos(senderId);
    }

    /**
     * Extract the TCP server endpoint(s) of a Matrox USB sender from its SDP transport file.
     *
     * Per Matrox "NMOS With USB" the media line is 'm=application <port> TCP usb ...' and the
     * connection address is the sender's TCP server IP, either per media descriptor or at
     * session level. Redundant senders expose one media descriptor per leg, in leg order.
     */
    private usbSenderLegsFromSdp(manifestFile:string): {source_ip:string, source_port:number}[]{
        const legs: {source_ip:string, source_port:number}[] = [];
        if(typeof manifestFile != "string" || manifestFile.trim() == ""){ return legs; }
        let parsed:any;
        try{
            parsed = sdpTransform.parse(manifestFile);
        }catch(e){
            SyncLog.log("warning", "NMOS Connect", `Can not parse USB sender SDP: ${e?.message || e}`);
            return legs;
        }
        const sessionIp = this.stripSdpAddress(parsed?.connection?.ip);
        const media = Array.isArray(parsed?.media) ? parsed.media : [];
        media.forEach((m:any)=>{
            if(m?.type != "application"){ return; }
            if(typeof m?.protocol != "string" || !m.protocol.toUpperCase().includes("TCP")){ return; }
            const ip = this.stripSdpAddress(m?.connection?.ip) || sessionIp;
            const port = Number(m?.port);
            if(!ip || !Number.isFinite(port) || port <= 0){ return; }
            legs.push({source_ip: ip, source_port: port});
        });
        return legs;
    }

    // SDP connection addresses may carry a TTL or multicast count suffix ("192.0.2.1/127").
    private stripSdpAddress(ip:any): string{
        if(typeof ip != "string"){ return ""; }
        return ip.split("/")[0].trim();
    }

    // ----- Multicast leases -----

    /**
     * Destination IPs currently on the wire, excluding one sender's own.
     *
     * Handed to the lease manager so it never allocates an address a device is
     * already transmitting on, even when that device has no lease (a static
     * configuration, or a sender belonging to another controller).
     */
    public getActiveSenderIps(excludeSenderId: string): Set<string> {
        const out = new Set<string>();
        try {
            const active = this.nmosState.senderActiveData || {};
            for (const senderId in active) {
                if (senderId === excludeSenderId) continue;
                const params = active[senderId]?.transport_params;
                if (!Array.isArray(params)) continue;
                for (const p of params) {
                    const ip = this.stripSdpAddress(p?.destination_ip);
                    if (ip && ip !== "auto") { out.add(ip); }
                }
            }
        } catch (e) {}
        return out;
    }

    /** Everything the lease manager needs to classify and label one sender. */
    private leaseArgsFor(senderId: string): any | null {
        const sender = this.nmosState.senders?.[senderId];
        if (!sender) return null;
        // Only RTP carries a multicast destination address. Guarding on USB
        // alone was not enough: an MXL sender's flow still reports
        // format urn:x-nmos:format:video, so it was being classified as video
        // and handed a lease, and websocket/MQTT senders were consuming the
        // "other" pool — addresses none of them can ever use.
        if (!isMulticastTransport(sender.transport)) return null;

        const flow = this.nmosState.flows?.[sender.flow_id];
        if (!flow) return null;
        const source = this.nmosState.sources?.[flow.source_id];

        let channels = 0;
        try { if (Array.isArray(source?.channels)) { channels = source.channels.length; } } catch (e) {}

        let deviceLabel = "", nodeId = "";
        try {
            const dev = this.nmosState.devices?.[sender.device_id];
            if (dev) { deviceLabel = dev.label || ""; nodeId = dev.node_id || ""; }
        } catch (e) {}

        // Reuse whatever port the sender is already using; 5004 is the ST 2110
        // default and the only sane fallback.
        let port = 5004;
        try {
            const tp = this.nmosState.senderActiveData?.[senderId]?.transport_params?.[0];
            if (tp && typeof tp.destination_port === "number" && tp.destination_port > 0) { port = tp.destination_port; }
        } catch (e) {}

        return {
            senderId,
            mediaType: flow.media_type || "",
            format: flow.format || "",
            channels,
            width: flow.frame_width,
            height: flow.frame_height,
            deviceLabel,
            nodeId,
            port,
            isActive: !!(sender.subscription && sender.subscription.active)
        };
    }

    // How many times in a row we will try to move one sender onto its leased
    // address before backing off, and how long we then wait.
    //
    // A device can refuse to converge for reasons we cannot fix from here: it
    // rejects the PATCH, or accepts it and keeps reporting a different
    // destination_ip. Without a limit the 30 s sweep re-PATCHes such a sender
    // forever, and every apparent success also re-executes all its receivers.
    // The back-off is a long retry rather than a permanent stop, so a device
    // that recovers (reboot, firmware fix, config change) heals on its own
    // without needing a server restart.
    private static readonly LEASE_APPLY_MAX_ATTEMPTS = 5;
    private static readonly LEASE_APPLY_COOLDOWN_MS = 10 * 60 * 1000;

    // Per sender: which address pair we were driving towards, how many
    // consecutive attempts have failed to stick, and when to try again.
    private leaseApplyState: { [senderId: string]: { key: string, attempts: number, nextAttemptAt: number } } = {};

    /**
     * Bring one sender's addresses in line with its lease.
     *
     * Only ever PATCHes when the effective lease addresses differ from what is
     * actually active, so a steady state produces no traffic. Receivers are
     * re-executed afterwards, because a receiver pointed at the old address
     * would otherwise sit on a dead group.
     */
    public reconcileSenderWithLease(senderId: string) {
        const manager = MulticastLeaseManager.instance;
        if (!manager || !manager.isEnabled()) return;

        const args = this.leaseArgsFor(senderId);
        if (!args) return;

        const lease = manager.ensureLease(args);
        if (!lease) return;

        const desired = manager.getDesiredAddresses(senderId);
        if (!desired) return;

        const active = this.nmosState.senderActiveData?.[senderId];
        if (!active || !Array.isArray(active.transport_params)) return;

        const legs: any[] = [];
        active.transport_params.forEach((p: any, index: number) => {
            // Only the two legs a lease covers; a disabled leg is left alone.
            if (index > 1) return;
            if (p?.rtp_enabled === false) return;
            const want = index === 0 ? desired.primaryIp : desired.secondaryIp;
            if (!want) return;
            const have = this.stripSdpAddress(p?.destination_ip);
            if (have !== want) { legs.push({ index, multicast: want }); }
        });

        if (legs.length === 0) {
            // Converged. Forget any past trouble so a future change to this
            // sender starts with a clean budget.
            delete this.leaseApplyState[senderId];
            return;
        }

        // The target is the pair we are trying to reach. A manual override, a
        // release or a re-allocation changes it, and that is a new intent —
        // it must not inherit the previous target's exhausted budget.
        const key = desired.primaryIp + "|" + desired.secondaryIp;
        let st = this.leaseApplyState[senderId];
        if (!st || st.key !== key) {
            st = { key, attempts: 0, nextAttemptAt: 0 };
            this.leaseApplyState[senderId] = st;
        }

        const now = Date.now();
        if (st.nextAttemptAt > now) { return; }

        st.attempts++;
        if (st.attempts >= NmosRegistryConnector.LEASE_APPLY_MAX_ATTEMPTS) {
            st.nextAttemptAt = now + NmosRegistryConnector.LEASE_APPLY_COOLDOWN_MS;
            // Logged once per back-off, not once per sweep.
            SyncLog.log("warning", "Multicast Lease",
                "Sender " + senderId + " has not taken its leased address after " +
                st.attempts + " attempts (wanted " + key.replace("|", " / ") +
                "). Backing off for " + Math.round(NmosRegistryConnector.LEASE_APPLY_COOLDOWN_MS / 60000) +
                " minutes. Check whether the device accepts the IS-05 patch, or set the address manually.");
            // Reset the counter so the next window is a fresh burst rather
            // than a single attempt every cooldown forever.
            st.attempts = 0;
        }

        SyncLog.log("info", "Multicast Lease",
            "Applying leased address(es) to sender " + senderId + ": " +
            legs.map((l) => "leg" + l.index + "=" + l.multicast).join(", "));

        this.setFlowMulticast(senderId, { legs })
            .then(() => { try { this.reconnectOnChanges(senderId); } catch (e) {} })
            .catch((e: any) => {
                SyncLog.log("warning", "Multicast Lease",
                    "Could not apply leased address to sender " + senderId, e);
            });
    }

    /**
     * First-enable sweep.
     *
     * `adoptExisting` decides the migration story for a live network: adopting
     * records whatever each sender is already transmitting on, so nothing is
     * repointed and no stream breaks. Otherwise every active sender is given a
     * fresh pair from its range, which is a deliberate re-address of the whole
     * plant.
     */
    public seedLeasesFromActive(adoptExisting: boolean) {
        const manager = MulticastLeaseManager.instance;
        if (!manager || !manager.isEnabled()) return;

        let adopted = 0, allocated = 0;
        for (const senderId in (this.nmosState.senders || {})) {
            const args = this.leaseArgsFor(senderId);
            if (!args || !args.isActive) continue;

            if (adoptExisting) {
                const params = this.nmosState.senderActiveData?.[senderId]?.transport_params;
                const primary = Array.isArray(params) ? this.stripSdpAddress(params[0]?.destination_ip) : "";
                const secondary = Array.isArray(params) && params.length > 1 ? this.stripSdpAddress(params[1]?.destination_ip) : "";
                if (primary && primary !== "auto") {
                    if (manager.adoptLease({ ...args, primaryIp: primary, secondaryIp: secondary || undefined })) {
                        adopted++;
                        continue;
                    }
                }
            }
            if (manager.ensureLease(args)) { allocated++; }
        }

        SyncLog.log("info", "Multicast Lease",
            "Multicast DHCP enabled: " + adopted + " sender(s) adopted at their current address, " +
            allocated + " allocated fresh.");

        // Only the freshly allocated ones can actually differ from the wire.
        if (!adoptExisting || allocated > 0) { this.sweepLeases(); }
    }

    /** Reconcile every active sender. Cheap when nothing has drifted. */
    public sweepLeases() {
        const manager = MulticastLeaseManager.instance;
        if (!manager || !manager.isEnabled()) return;
        const senders = this.nmosState.senders || {};
        for (const senderId in senders) {
            try { this.reconcileSenderWithLease(senderId); } catch (e) {}
        }
        // Drop back-off state for senders that are gone, so the map tracks the
        // live network rather than growing for the lifetime of the process. A
        // sender that returns is treated as new and gets a fresh budget.
        for (const senderId in this.leaseApplyState) {
            if (!senders[senderId]) { delete this.leaseApplyState[senderId]; }
        }
    }

    /**
     * Multicast addresses in use by more than one active sender leg.
     *
     * Two senders on the same group address is a real fault that is otherwise
     * invisible until a receiver shows the wrong picture, so it is computed
     * from the IS-05 ACTIVE transport parameters rather than from the SDP:
     * the active params are what the device is really transmitting on.
     *
     * Returns a map of address -> the sender ids claiming it, only for
     * addresses claimed more than once. Cheap enough to recompute on publish
     * (one pass over active senders), so there is no cache to invalidate.
     */
    public getMulticastConflicts(): { [address: string]: string[] } {
        const byAddress: { [address: string]: string[] } = {};
        try {
            const active = this.nmosState.senderActiveData || {};
            for (const senderId in active) {
                // An inactive sender is not transmitting, so it cannot conflict.
                if (active[senderId]?.master_enable === false) { continue; }
                const params = active[senderId]?.transport_params;
                if (!Array.isArray(params)) { continue; }
                for (const p of params) {
                    // rtp_enabled === false marks a disabled 2022-7 leg.
                    if (p?.rtp_enabled === false) { continue; }
                    const ip = this.stripSdpAddress(p?.destination_ip);
                    // "auto" means the device has not been told an address yet.
                    if (!ip || ip === "auto") { continue; }
                    if (!byAddress[ip]) { byAddress[ip] = []; }
                    if (!byAddress[ip].includes(senderId)) { byAddress[ip].push(senderId); }
                }
            }
        } catch (e) { return {}; }

        const conflicts: { [address: string]: string[] } = {};
        for (const ip in byAddress) {
            // Several legs of the SAME sender on one address is odd but not a
            // cross-device clash, so only report distinct senders.
            if (byAddress[ip].length > 1) { conflicts[ip] = byAddress[ip]; }
        }
        return conflicts;
    }

    /**
     * Fallback endpoint source: the sender's IS-05 active transport parameters. Only populated
     * for devices advertising urn:x-nmos:control:sr-ctrl/v1.0, so this is best effort.
     */
    private usbSenderLegsFromActive(senderId:string): {source_ip:string, source_port:number}[]{
        const legs: {source_ip:string, source_port:number}[] = [];
        const params = this.nmosState.senderActiveData?.[senderId]?.transport_params;
        if(!Array.isArray(params)){ return legs; }
        params.forEach((p:any)=>{
            const ip = this.stripSdpAddress(p?.source_ip);
            const port = Number(p?.source_port);
            if(!ip || !Number.isFinite(port) || port <= 0){ return; }
            legs.push({source_ip: ip, source_port: port});
        });
        return legs;
    }

    async connectionGetSenderInfo(senderId:string){
        let info:CrosspointConnectionSenderInfo = {
            senderId: senderId,
            interfaces:[],
            manifestFile:"",
            active:false,
            error:"",
            transport:""
        }
        let deviceId
        let device 
        let nodeId 
        let node 
        let flowId
        let sender
        let flow 
        let manifest
        try{
            sender = this.nmosState.senders[senderId]
            flowId = sender.flow_id
            deviceId = sender.device_id;
            device = this.nmosState.devices[deviceId];
            nodeId = device.node_id;
            node = this.nmosState.nodes[nodeId];
        }catch(e){
            info.error = "Sender not available in NMOS";
            return info;
        }

        // TODO: need to load manifest always
        // Now: Always load manifest
        //if(this.nmosState.sendersManifestDetail.hasOwnProperty(senderId)){
        //    manifest = this.nmosState.sendersManifestDetail[senderId]
        //    info.manifestFile = manifest._RAWSDP;
        //}else{
            // Load manifest
            try{
                let sdp = await axios.get(sender.manifest_href)
                info.manifestFile = sdp.data;
            }catch(e){
                info.error = "Can not load Manifest from sender: " + e.code;
                return info;
            }
        //}

        sender.interface_bindings.forEach((name:any)=>{
            node.interfaces.forEach((inter:any)=>{
                if(inter.name == name){
                    info.interfaces.push({name:name,mac:inter.port_id});
                }
            })
        });

        info.transport = transportShortCode(sender.transport);

        if(info.transport == "usb"){
            // A USB receiver must be told the sender's TCP server endpoint (source_ip/source_port);
            // the sender is 'a=setup:passive' so there is nothing to guess and "auto" is not valid.
            info.senderLegs = this.usbSenderLegsFromSdp(info.manifestFile);
            if(info.senderLegs.length == 0){
                info.senderLegs = this.usbSenderLegsFromActive(senderId);
            }
            if(info.senderLegs.length == 0){
                info.error = "USB sender has no usable TCP endpoint in its SDP or active transport parameters";
                return info;
            }
        }

        info.active = sender.subscription.active;

        return info
    }

    async makeConnection(receiverId:string, senderInfo: CrosspointConnectionSenderInfo, prepareOnly: boolean = false){

        if(senderInfo.error != ""){
            SyncLog.log("warning", "NMOS Connect", "No valid sender Info: " + senderInfo.error);
            throw new Error(senderInfo.error);
        }

        // **ADVANCED COMPATIBILITY PRE-VALIDATION**: Validate stream compatibility before attempting connection
        const connectionStartTime = Date.now();
        let atomicOperationId: string | null = null;
        let compatibilityResult: any = null;
        
        try {
            if (senderInfo.senderId !== "disconnect") {
                // Pre-validate stream compatibility to eliminate retry latency from failed connections
                compatibilityResult = await this.advancedCompatibility.validateStreamCompatibility(
                    senderInfo.senderId, 
                    receiverId
                );
                
                if (!compatibilityResult.compatible) {
                    const compatibilityError = `Stream incompatible: ${compatibilityResult.reason}`;
                    SyncLog.log("warning", "compatibility", compatibilityError, {
                        senderId: senderInfo.senderId,
                        receiverId: receiverId,
                        confidence: compatibilityResult.confidence,
                        warnings: compatibilityResult.warnings
                    });
                    throw new Error(compatibilityError);
                }
                
                SyncLog.log("info", "compatibility", 
                    `Stream compatibility validated: ${senderInfo.senderId} -> ${receiverId}`,
                    { 
                        confidence: compatibilityResult.confidence, 
                        warnings: compatibilityResult.warnings.length,
                        validationLatency: Date.now() - connectionStartTime 
                    });
            }
        } catch (compatibilityError) {
            SyncLog.log("error", "compatibility", 
                `Stream compatibility validation failed: ${compatibilityError instanceof Error ? compatibilityError.message : String(compatibilityError)}`);
            throw compatibilityError;
        }

        // **DYNAMIC STREAM RECONFIGURATION**: Check if we can update parameters without full reconnection
        let dynamicReconfigUsed = false;
        try {
            // USB is excluded: performDynamicReconfiguration stages { interface_ip: "auto" } only,
            // which omits the source_ip/source_port a USB receiver requires. USB always takes the
            // full path below, which builds complete parameters.
            if (!prepareOnly && senderInfo.senderId !== "disconnect" && senderInfo.transport !== "usb") {
                // Get optimized transport parameters for comparison
                const optimizedTransportParams = await this.advancedCompatibility.getOptimizedTransportParams(
                    senderInfo.senderId, 
                    receiverId
                );
                
                // Check if dynamic reconfiguration is possible (same sender, only transport changes)
                const canReconfigure = await this.advancedCompatibility.canUseReconfiguration(
                    senderInfo.senderId, 
                    receiverId, 
                    optimizedTransportParams
                );
                
                if (canReconfigure) {
                    // Attempt dynamic reconfiguration to avoid full disconnect/reconnect
                    SyncLog.log("info", "dynamic_reconfig", 
                        `Attempting dynamic reconfiguration: ${senderInfo.senderId} -> ${receiverId}`);
                    
                    const reconfigSuccess = await this.advancedCompatibility.performDynamicReconfiguration(
                        senderInfo.senderId,
                        receiverId,
                        optimizedTransportParams,
                        senderInfo.manifestFile
                    );
                    
                    if (reconfigSuccess) {
                        dynamicReconfigUsed = true;
                        const totalLatency = Date.now() - connectionStartTime;
                        SyncLog.log("success", "dynamic_reconfig", 
                            `Dynamic reconfiguration completed successfully: ${senderInfo.senderId} -> ${receiverId}`,
                            { totalLatency, optimization: "parameter_update_only" });
                        
                        // Return early - no need for full connection process
                        return `Dynamic reconfiguration completed in ${totalLatency}ms`;
                    } else {
                        SyncLog.log("info", "dynamic_reconfig", 
                            `Dynamic reconfiguration failed, falling back to full connection method`);
                    }
                }
            }
        } catch (reconfigError) {
            SyncLog.log("warning", "dynamic_reconfig", 
                `Dynamic reconfiguration check failed, using standard method: ${reconfigError instanceof Error ? reconfigError.message : String(reconfigError)}`);
            // Continue with standard connection method
        }

        // **ATOMIC STATE OPTIMIZATION**: Pre-check for atomic connection switching (if not using dynamic reconfig)
        if (!dynamicReconfigUsed) {
            try {
                if (!prepareOnly && senderInfo.senderId !== "disconnect") {
                    // Check if we can perform atomic connection switching
                    const atomicState = this.atomicStateManager.getState();
                    const targetReceiver = atomicState.receivers[receiverId];
                    const targetSender = atomicState.senders[senderInfo.senderId];
                    
                    if (targetReceiver && targetSender) {
                        // Atomic connection switch available - perform optimized switching
                        SyncLog.log("info", "atomic_nmos", 
                            `Attempting atomic connection switch: receiver ${receiverId} to sender ${senderInfo.senderId}`);
                        
                        atomicOperationId = await this.atomicStateManager.performAtomicConnectionSwitch(
                            [receiverId],
                            senderInfo.senderId,
                            targetSender.flow_id,
                            [] // Source IDs would be resolved from flow hierarchy
                        );
                        
                        SyncLog.log("info", "atomic_nmos", 
                            `Atomic connection switch prepared: ${atomicOperationId}`,
                            { latency: Date.now() - connectionStartTime });
                    }
                }
            } catch (atomicError) {
                SyncLog.log("warning", "atomic_nmos", 
                    `Atomic connection optimization failed, falling back to standard method: ${atomicError instanceof Error ? atomicError.message : String(atomicError)}`);
                // Continue with standard connection method
            }
        }

        let patch: any = {
            transport_params: [],
        };
        if(!prepareOnly){
            patch.activation = {
                mode: "activate_immediate",
                requested_time: null,
            };
        }

        

        if(senderInfo.senderId == "disconnect"){
            //
        }else{
            patch.sender_id = senderInfo.senderId;
        }

        let deviceId
        let device 
        let nodeId 
        let node 
        let receiver
        try{
            receiver = this.nmosState.receivers[receiverId]
            deviceId = receiver.device_id;
            device = this.nmosState.devices[deviceId];
            nodeId = device.node_id;
            node = this.nmosState.nodes[nodeId];
        }catch(e){
            SyncLog.log("warning", "NMOS Connect", "Receiver with ID: "+receiverId+" is not available in NMOS");
            throw new Error("NMOS: Receiver not available. (Offline?)");
        }

        let interfaces = [];
        receiver.interface_bindings.forEach((name:any)=>{
            node.interfaces.forEach((inter:any)=>{
                if(inter.name == name){
                    interfaces.push({name:name,mac:inter.port_id});
                }
            })
        });

        


        let interfaceCount = Math.min(senderInfo.interfaces.length, interfaces.length);
        let i = 0;

        // **ADVANCED TRANSPORT PARAMETER OPTIMIZATION**: Use optimized parameters for faster connection establishment
        let optimizedTransportParams: any = null;
        if (compatibilityResult && compatibilityResult.optimizedTransportParams && senderInfo.senderId !== "disconnect") {
            try {
                optimizedTransportParams = await this.advancedCompatibility.getOptimizedTransportParams(
                    senderInfo.senderId, 
                    receiverId
                );
                SyncLog.log("info", "compatibility", 
                    `Using optimized transport parameters for ${senderInfo.senderId} -> ${receiverId}`,
                    optimizedTransportParams);
            } catch (error) {
                SyncLog.log("warning", "compatibility", 
                    `Failed to get optimized transport params, using defaults: ${error instanceof Error ? error.message : String(error)}`);
            }
        }

        for (i = 0; i < interfaceCount; i++) {
            if(senderInfo.transport == "rtp.mcast" || senderInfo.transport == "rtp"){
                const baseParams = { interface_ip: "auto" };
                // Receiver staged patches must not include sender-only fields.
                // Always use minimal receiver-side params to satisfy schema.
                patch.transport_params.push(baseParams);
            } else if(senderInfo.transport == "usb"){
                // Matrox USB is TCP based: the receiver dials the sender's passive TCP server, so
                // source_ip/source_port are required alongside interface_ip.
                const leg = senderInfo.senderLegs?.[i] ?? senderInfo.senderLegs?.[0];
                if(!leg){
                    SyncLog.log("error", "NMOS Connect", `USB sender has no endpoint for leg ${i}`);
                    throw new Error("USB sender endpoint missing.");
                }
                patch.transport_params.push({
                    interface_ip: "auto",
                    source_ip: leg.source_ip,
                    source_port: leg.source_port,
                });
            } else if(senderInfo.transport == "websocket" || senderInfo.transport == "mqtt"){
                // Explicitly reject unsupported transports to avoid invalid schema patches
                SyncLog.log("error", "NMOS Connect", `Unsupported transport '${senderInfo.transport}' for IS-05 patch`);
                throw new Error(`Unsupported transport '${senderInfo.transport}'`);
            }else{
                SyncLog.log("warning", "NMOS Connect", "Sender has no transport Information.");
                throw new Error("Transport Type missing.");
            }
        }

        interfaceCount = receiver.interface_bindings.length;
        for (i = i; i < interfaceCount; i++) {
            // Receiver-side minimal valid params. A USB receiver leg with no matching sender leg
            // is unused, and the spec requires its source fields to be explicitly null.
            if(senderInfo.transport == "usb"){
                patch.transport_params.push({ interface_ip: "auto", source_ip: null, source_port: null });
            }else{
                patch.transport_params.push({ interface_ip: "auto" });
            }
        }

        if(senderInfo.transport == "rtp.mcast" || senderInfo.transport == "rtp" || senderInfo.transport == "usb"){
            let manifest = senderInfo.manifestFile;

            if(senderInfo.transport != "usb" && this.settings.fixSdpBugs){
                // Video colorimetry workarounds, not applicable to a USB SDP
                manifest = manifest.replace("colorimetry=UNSPECIFIED;", "colorimetry=BT709;");
                manifest = manifest.replace("TCS=UNSPECIFIED;", "TCS=SDR;");
            }

            // Only include transport_file if manifest data is valid (non-empty)
            if(manifest && manifest.trim().length > 0){
                patch.transport_file = {
                    type: "application/sdp",
                    data: manifest,
                };
            }
        }

        // Only include master_enable on immediate connect; omit on prepare/stage
        if(!prepareOnly){
            if(senderInfo.senderId == "disconnect"){
                patch.master_enable = false;
            }else{
                patch.master_enable = true;
            }
        }
        // Warum ????

        //if (receiver.subscription.active) {
        //if (!receiverInformation.active.master_enable) {
            //if(senderInfo.senderId == "disconnect"){
            //    patch.master_enable = false;
            //}else{
            //
            //}
        //}else{
            //if(senderInfo.senderId == "disconnect"){
            //    
            //}else{
            //    patch.master_enable = true;
            //}
        //}

        let versionFound = false;
        let controlHrefs = [];
        // Prefer highest supported Connection API versions first
        let controlTypes = [
            {type:"urn:x-nmos:control:sr-ctrl/v1.3",version:"v1.3"},
            {type:"urn:x-nmos:control:sr-ctrl/v1.2",version:"v1.2"},
            {type:"urn:x-nmos:control:sr-ctrl/v1.1",version:"v1.1"},
            {type:"urn:x-nmos:control:sr-ctrl/v1.0",version:"v1.0"},
        ]

        for(let type of controlTypes){
            device.controls.forEach((control)=>{
                if(control.type == type.type){
                    controlHrefs.push({href:control.href, version:type.version});
                    versionFound = true;
                }
            })
            if(versionFound){
                break;
            }
        }

        let done = false;

        // TODO Check control hrefs for first response....

        for(let href of controlHrefs){
            // TODO, version specific things
            let fixSlash = ""
            if(href.href[href.href.length-1] == "/"){
                fixSlash = ""
            }else{
                fixSlash = "/"
            }
            let patchHref = href.href + fixSlash + "single/receivers/" + receiverId + "/staged"
            // Concise summary for debugging without logging full SDP
            const patchSummary = {
                prepareOnly,
                senderId: (patch as any).sender_id ?? null,
                hasTransportFile: !!(patch as any).transport_file,
                transportParams: Array.isArray((patch as any).transport_params) ? (patch as any).transport_params.length : 0,
                includesActivation: !!(patch as any).activation,
                includesMasterEnable: Object.prototype.hasOwnProperty.call(patch, 'master_enable'),
            };
            SyncLog.log("info", "nmos_connect", "Attempting PATCH", { href: patchHref, ...patchSummary });
            try{
                let result = await axios.patch(patchHref, patch, {
                    timeout: 10000,  // Increased timeout to handle slower NMOS devices
                    maxRedirects: 0,  // Disable redirects for faster response
                    headers: {
                        'Connection': 'keep-alive',  // Enable connection reuse
                        'Keep-Alive': 'timeout=10, max=1000',  // More aggressive keep-alive
                        'Cache-Control': 'no-cache',  // Prevent caching delays
                        'User-Agent': 'NMOS-Crosspoint/2.0'  // Identify ourselves
                    },
                    // Enable HTTP/2 and compression
                    httpAgent: false,
                    httpsAgent: false,
                    // Disable response validation for speed
                    validateStatus: (status) => status >= 200 && status < 300
                });
                return SyncLog.log("success", "nmos_connect", "Successfully patched: "+receiverId, {href:patchHref, data:patch})
            }catch(e){
                if (axios.isAxiosError(e)) {
                    if(e.code == "ETIMEDOUT"){
                        // NEXT
                        let id = SyncLog.log("info", "nmos_connect", "Patch on "+patchHref+" timed out, trying next.");
                    }else{
                        // TODO....
                        if(e.code == "ERR_BAD_REQUEST"){
                            let id = SyncLog.log("error", "nmos_connect", "Receiver "+receiverId+" returned Error: "+e.code,{controlHrefs,failedControl:patchHref,patch, error:e.response.data,});
                            throw new LoggedError("Patch failed: "+e.response.data.error + " / " +e.response.data.debug , id);
                        }
                        let id = SyncLog.log("error", "nmos_connect", "Receiver "+receiverId+" returned Error: "+e.code,{controlHrefs,failedControl:patchHref,patch, message:e.message});
                        throw new LoggedError("Receiver returned Error: "+e.code, id);
                    }
                }else{
                    throw new LoggedError("Patch Failed: "+e.message);
                }
                
            }
        }
        const availableControls = (device && Array.isArray(device.controls)) ? device.controls.map((c:any)=>({type:c.type, href:c.href})) : [];
        const finalPatchSummary = {
            senderId: (patch as any).sender_id ?? null,
            hasTransportFile: !!(patch as any).transport_file,
            transportParams: Array.isArray((patch as any).transport_params) ? (patch as any).transport_params.length : 0,
            includesActivation: !!(patch as any).activation,
            includesMasterEnable: Object.prototype.hasOwnProperty.call(patch, 'master_enable'),
        }
        let id = SyncLog.log("error", "nmos_connect", "Receiver Control unreachable.",{controlHrefs, availableControls, patchSummary: finalPatchSummary});
        throw new LoggedError("Receiver Control unreachable.", id);
    }



    async enableFlow(senderId:string, disable=false){

        try{
            let versionFound = false;
            let controlHrefs = [];

            let sender = this.nmosState.senders[senderId];
            let device = this.nmosState.devices[sender.device_id];

            let controlTypes = [{type:"urn:x-nmos:control:sr-ctrl/v1.1",version:"v1.1"}, {type:"urn:x-nmos:control:sr-ctrl/v1.0",version:"v1.0"}]

            for(let type of controlTypes){
                device.controls.forEach((control)=>{
                    if(control.type == type.type){
                        controlHrefs.push({href:control.href, version:type.version});
                        versionFound = true;
                    }
                })
                if(versionFound){
                    break;
                }
            }

            let patch:any = {
                "receiver_id": null,
                "master_enable": true,
                "activation": {
                    "mode": "activate_immediate",
                    "requested_time": null,
                },
                "transport_params": [
                    {
                        "rtp_enabled": true,
                    },
                    {
                        "rtp_enabled": true,
                    }
                ]
            };

            if(disable){
                patch = {
                    "receiver_id": null,
                    "master_enable": false,
                    "activation": {
                        "mode": "activate_immediate",
                        "requested_time": null,
                    },
                    "transport_params": [
                        {
                            "rtp_enabled": false,
                        },
                        {
                            "rtp_enabled": false,
                        }
                    ]
                };
            }

            if(isUsbTransport(sender.transport)){
                // rtp_enabled is not part of a USB sender's transport parameters, and the leg count
                // is device specific. master_enable alone is enough to enable/disable the stream.
                delete patch.transport_params;
            }


            for(let href of controlHrefs){
                // TODO, version specific things
                let fixSlash = ""
                if(href.href[href.href.length-1] == "/"){
                    fixSlash = ""
                }else{
                    fixSlash = "/"
                }
                let patchHref = href.href + fixSlash + "single/senders/" + senderId + "/staged";
                try{
                    await axios.patch(patchHref, patch, {timeout:30000});
                    SyncLog.log("success", "nmos", "Successfully enabled: "+senderId, {href:patchHref, data:patch})
                    return;
                }catch(e){
                    if (axios.isAxiosError(e)) {
                        if(e.code == "ETIMEDOUT"){
                            // NEXT
                            SyncLog.log("info", "nmos", "Patch on "+senderId+" timed out, trying next.");
                        }else{
                            // TODO....
                            if(e.code == "ERR_BAD_REQUEST"){
                                SyncLog.log("error", "nmos", "Sender "+senderId+" returned Error: "+e.code,{controlHrefs,failedControl:patchHref,patch, error:e.response.data,});
                            }else{
                                SyncLog.log("error", "nmos", "Sender "+senderId+" returned Error: "+e.code,{controlHrefs,failedControl:patchHref,patch, message:e.message});
                            }
                            return;
                        }
                    }else{
                        return;
                    }
                }
            }
        }catch(e){

        }

    }


    /**
     * Update the description field of an NMOS resource to store persistent alias
     * @param resourceType - Type of resource (devices, sources, senders, receivers, flows)
     * @param resourceId - NMOS ID of the resource
     * @param alias - Alias to store in description field
     */
    async updateNmosDescription(resourceType: "devices"|"sources"|"senders"|"receivers"|"flows", resourceId: string, alias: string): Promise<void> {
        try {
            const resource = this.nmosState[resourceType][resourceId];
            if (!resource) {
                SyncLog.log("debug", "nmos_alias", `Resource ${resourceType}/${resourceId} not found for alias update`);
                return;
            }

            // Try IS-13 NMOS Annotation API first (proper NMOS way)
            const is13Success = await this.tryIs13AnnotationUpdate(resourceType, resourceId, alias);
            if (is13Success) {
                return;
            }

            // Fallback: Try device-specific APIs for Matrox devices
            if (resourceType === "devices" && resource.controls && resource.controls.length > 0) {
                // Try Matrox CIP device API directly
                const matroxWebUI = resource.controls.find(c => c.type === "urn:x-matrox:cip:webui");
                if (matroxWebUI) {
                    try {
                        // Extract device IP from Matrox web UI URL (https://MTXCIP-YXA00638/)
                        const urlMatch = matroxWebUI.href.match(/https?:\/\/([^\/]+)/);
                        if (urlMatch) {
                            const deviceHost = urlMatch[1];
                            // Try Matrox device API endpoint for description update
                            const matroxApiUrl = `http://${deviceHost}:5050/api/device/description`;
                            
                            await axios.put(matroxApiUrl, { description: alias || "" }, {
                                timeout: 5000,
                                headers: {
                                    'Content-Type': 'application/json',
                                    'User-Agent': 'NMOS-Crosspoint/2.0'
                                }
                            });
                            
                            SyncLog.log("success", "nmos_alias", `Updated Matrox device description: ${resourceId}`, { alias, deviceHost });
                            return;
                        }
                    } catch (error) {
                        SyncLog.log("debug", "nmos_alias", `Matrox device API failed for ${resourceId}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }
                
                // Try NMOS registry PATCH if writable
                for (const registry of this.nmosRegistryList) {
                    const registryUrl = `http://${registry.ip}:${registry.port}`;
                    
                    for (const version of this.registryVersionList) {
                        try {
                            const registryPatchUrl = `${registryUrl}/x-nmos/registration/${version}/resource/devices/${resourceId}`;
                            
                            await axios.patch(registryPatchUrl, {
                                description: alias || ""
                            }, {
                                timeout: 5000,
                                headers: {
                                    'Content-Type': 'application/json',
                                    'User-Agent': 'NMOS-Crosspoint/2.0'
                                }
                            });
                            
                            SyncLog.log("success", "nmos_alias", `Updated device description via registry: ${resourceId}`, { alias, registryUrl, version });
                            return;
                        } catch (error) {
                            SyncLog.log("debug", "nmos_alias", `Registry PATCH failed for ${resourceId} on ${registryUrl}/${version}: ${error instanceof Error ? error.message : String(error)}`);
                            continue;
                        }
                    }
                }
            }

            // Final fallback: Local storage only
            SyncLog.log("debug", "nmos_alias", `NMOS alias persistence not supported for ${resourceType}/${resourceId} - using local storage only`);
            
        } catch (error) {
            SyncLog.log("debug", "nmos_alias", `NMOS alias update failed for ${resourceType}/${resourceId}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * Try to update alias using IS-13 NMOS Annotation API
     */
    private async tryIs13AnnotationUpdate(resourceType: string, resourceId: string, alias: string): Promise<boolean> {
        try {
            // Find devices/nodes that advertise IS-13 annotation service
            const annotationServices = await this.findIs13AnnotationServices();
            
            for (const service of annotationServices) {
                try {
                    // IS-13 endpoint format: /x-nmos/annotation/{version}/{resource_type}/{resource_id}
                    const annotationUrl = `${service.baseUrl}/x-nmos/annotation/${service.version}/${resourceType}/${resourceId}`;
                    
                    const annotationData = {
                        description: alias || ""
                    };
                    
                    await axios.put(annotationUrl, annotationData, {
                        timeout: 5000,
                        headers: {
                            'Content-Type': 'application/json',
                            'User-Agent': 'NMOS-Crosspoint/2.0'
                        }
                    });
                    
                    SyncLog.log("success", "nmos_alias", `Updated alias via IS-13 annotation API: ${resourceType}/${resourceId}`, { alias, service: service.baseUrl });
                    return true;
                    
                } catch (error) {
                    SyncLog.log("debug", "nmos_alias", `IS-13 annotation failed on ${service.baseUrl}: ${error instanceof Error ? error.message : String(error)}`);
                    continue;
                }
            }
            
            return false;
            
        } catch (error) {
            SyncLog.log("debug", "nmos_alias", `IS-13 annotation discovery failed: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    /**
     * Find NMOS nodes that advertise IS-13 annotation services
     */
    private async findIs13AnnotationServices(): Promise<Array<{baseUrl: string, version: string, deviceId: string, deviceLabel: string}>> {
        const services: Array<{baseUrl: string, version: string, deviceId: string, deviceLabel: string}> = [];
        
        try {
            // Look through discovered NMOS nodes for IS-13 annotation services
            if (this.nmosState && this.nmosState.devices) {
                for (const [deviceId, device] of Object.entries(this.nmosState.devices)) {
                    if ((device as any).services) {
                        for (const service of (device as any).services) {
                            if (service.type === "urn:x-nmos:service:annotation") {
                                const deviceLabel = (device as any).label || (device as any).description || deviceId;
                                services.push({
                                    baseUrl: service.href,
                                    version: "v1.0", // Default to v1.0, could be made configurable
                                    deviceId: deviceId,
                                    deviceLabel: deviceLabel
                                });
                                SyncLog.log("info", "nmos_alias", `Found IS-13 annotation support on device: ${deviceLabel} (${deviceId})`, { service: service.href });
                            }
                        }
                    }
                }
            }
            
            if (services.length === 0) {
                SyncLog.log("info", "nmos_alias", "No IS-13 annotation services found - using local storage only for alias persistence");
            } else {
                SyncLog.log("info", "nmos_alias", `Found ${services.length} IS-13 annotation service(s) for NMOS alias persistence`);
            }
        } catch (error) {
            SyncLog.log("debug", "nmos_alias", `Error discovering IS-13 services: ${error instanceof Error ? error.message : String(error)}`);
        }
        
        return services;
    }

    /**
     * Check which devices support IS-13 annotation and return summary
     */
    public getIs13SupportSummary(): {supportedDevices: Array<{id: string, label: string, serviceUrl: string}>, totalDevices: number} {
        const supportedDevices: Array<{id: string, label: string, serviceUrl: string}> = [];
        let totalDevices = 0;
        
        try {
            if (this.nmosState && this.nmosState.devices) {
                totalDevices = Object.keys(this.nmosState.devices).length;
                
                for (const [deviceId, device] of Object.entries(this.nmosState.devices)) {
                    if ((device as any).services) {
                        for (const service of (device as any).services) {
                            if (service.type === "urn:x-nmos:service:annotation") {
                                const deviceLabel = (device as any).label || (device as any).description || deviceId;
                                supportedDevices.push({
                                    id: deviceId,
                                    label: deviceLabel,
                                    serviceUrl: service.href
                                });
                                break; // Only need to find one IS-13 service per device
                            }
                        }
                    }
                }
            }
        } catch (error) {
            SyncLog.log("debug", "nmos_alias", `Error checking IS-13 support: ${error instanceof Error ? error.message : String(error)}`);
        }
        
        return { supportedDevices, totalDevices };
    }

    /**
     * Find which registry hosts a specific resource
     */
    private async findResourceRegistry(resourceType: string, resourceId: string): Promise<string | null> {
        // Check each connected registry to find the one hosting this resource
        for (const registry of this.nmosRegistryList) {
            const registryUrl = `http://${registry.ip}:${registry.port}`;
            
            for (const version of this.registryVersionList) {
                try {
                    const queryUrl = `${registryUrl}/x-nmos/query/${version}/${resourceType}/${resourceId}`;
                    await axios.get(queryUrl, { timeout: 5000 });
                    return registryUrl; // Found it
                } catch (error) {
                    // Resource not found in this registry/version, try next
                    continue;
                }
            }
        }
        return null;
    }

    async setFlowMulticast(senderId:string, data:any){

        try{
            let versionFound = false;
            let controlHrefs = [];

            let sender = this.nmosState.senders[senderId];
            let device = this.nmosState.devices[sender.device_id];

            if(isUsbTransport(sender.transport)){
                // Multicast has no meaning for a point-to-point TCP transport.
                SyncLog.log("info", "NMOS Connect", `Skipping multicast assignment for USB sender ${senderId}`);
                return;
            }

            let controlTypes = [{type:"urn:x-nmos:control:sr-ctrl/v1.1",version:"v1.1"}, {type:"urn:x-nmos:control:sr-ctrl/v1.0",version:"v1.0"}]

            for(let type of controlTypes){
                device.controls.forEach((control)=>{
                    if(control.type == type.type){
                        controlHrefs.push({href:control.href, version:type.version});
                        versionFound = true;
                    }
                })
                if(versionFound){
                    break;
                }
            }

            let patch:any = {
                "receiver_id": null,
                "activation": {
                    "mode": "activate_immediate",
                    "requested_time": null,
                },
                // Initialize legs with minimal valid sender-side params to avoid empty objects
                "transport_params": [
                    {
                        destination_ip: "auto",
                        source_ip: "auto",
                    },
                    {
                        destination_ip: "auto",
                        source_ip: "auto",
                    }
                ]
            };

            data.legs.forEach((l)=>{
                patch.transport_params[l.index] = {destination_ip:l.multicast, source_ip:"auto"}
            });

            

            for(let href of controlHrefs){
                // TODO, version specific things
                let fixSlash = ""
                if(href.href[href.href.length-1] == "/"){
                    fixSlash = ""
                }else{
                    fixSlash = "/"
                }
                let patchHref = href.href + fixSlash + "single/senders/" + senderId + "/staged";
                try{
                    await axios.patch(patchHref, patch, {timeout:30000});
                    SyncLog.log("success", "nmos", "Successfully set multicast: "+senderId, {href:patchHref, data:patch});


                    setTimeout(()=>{
                        this.getSenderActive("senders", {path:senderId, post:sender});
                        this.getSenderManifestData("senders", {path:senderId, post:sender});
                    },1000);


                    return;
                }catch(e){
                    if (axios.isAxiosError(e)) {
                        if(e.code == "ETIMEDOUT"){
                            // NEXT
                            SyncLog.log("info", "nmos", "Patch on "+senderId+" timed out, trying next.");
                        }else{
                            // TODO....
                            if(e.code == "ERR_BAD_REQUEST"){
                                SyncLog.log("error", "nmos", "Sender "+senderId+" returned Error: "+e.code,{controlHrefs,failedControl:patchHref,patch, error:e.response.data,});
                            }else{
                                SyncLog.log("error", "nmos", "Sender "+senderId+" returned Error: "+e.code,{controlHrefs,failedControl:patchHref,patch, message:e.message});
                            }
                            return;
                        }
                    }else{
                        return;
                    }
                }
            }
        }catch(e){

        }

    }


    private getOne(hrefList: string[]) {
        return new Promise((resolve, reject) => {
            let promises = [];
            hrefList.forEach((href) => {
                promises.push(axios.get(href));
                axios.get(href).then(response=>{
                
                }).catch(e=>{
                    // TODO Logging
                    //console.log(e)
                });
            });
            
            Promise.any(promises)
                .then((response) => {
                    resolve(response);
                })
                .catch((error) => {
                    // TODO: Logging
                    //console.log(error);
                    reject(error);
                });
        });
    }
}

interface Connection {
    subscription: any;
    ws: WebSocket;
}

interface NmosRegistry {
    ip: string;
    port: number;
    domain: string;
    priority: number;
    source: "mdns" | "dnssd" | "static" | "manual";
}

interface ConnectionList {
    [name: string]: Connection;
}

interface CrosspointList {
    [name: string]: any;
}
export interface CrosspointState {
    [name: string]: CrosspointList;
}



interface CrosspointSender {
    name:string;
    type:string;
    resolution:string;
}



