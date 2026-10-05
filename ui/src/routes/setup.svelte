<script lang="ts">
    import ServerConnector from "../lib/ServerConnector/ServerConnectorService";
    import type { Subject } from "rxjs";
    import { onDestroy, onMount } from "svelte";
    import sha256 from "js-sha256";
    import OverlayMenuService from "../lib/OverlayMenu/OverlayMenuService";

    // Server-held snapshot, replaced wholesale on every sync push.
    let state: any = null;
    let sync: Subject<any>;

    // Local edit buffer. Kept separate from `state` so a background push
    // does not overwrite half-typed input; `loadForm` copies across only
    // when the user is not mid-edit.
    let form: any = {
        registryIp: "",
        registryPort: 80,
        reconnectOnSdpChanges: false,
        fixSdpBugs: false,
        autoMulticast: false,
        firstDynamicNumber: 1000,
        predictiveEnabled: false,
        predictiveCooldownMs: 10000,
        bcp008Enabled: true,
        audioMonitorEnabled: false,
        dnssdEnabled: true,
        dnssdDomain: "",
        debugLogs: false,
    };
    let dirty = false;
    let saving = false;
    let restartRequired = false;

    // Device Web-UI link profiles. Edited as a list rather than folded into
    // `form`, because rows are added and removed as well as changed.
    let profiles: any[] = [];

    // Multicast probe status, so the operator can see whether a probe is
    // actually attached before wondering why the monitor is silent.
    let probeState: any = { probes: [] };
    let probeSync: Subject<any>;
    // Fetched separately: the probeState channel is readable by every user,
    // the token only by users allowed to change setup.
    let probeToken = "";

    // Multicast lease inventory.
    let leaseState: any = { leases: {}, stats: {} };
    let leaseSync: Subject<any>;
    let leaseFilter = "";
    let adoptModal: any;

    const CATEGORY_LABEL: any = {
        video: "Video", videoUhd: "Video UHD", jxsv: "JPEG-XS", audio: "Audio", other: "Other",
    };

    $: leaseRows = Object.values(leaseState.leases ?? {})
        .filter((l: any) => {
            if (!leaseFilter) return true;
            const t = leaseFilter.toLowerCase();
            return (l.senderLabel ?? "").toLowerCase().includes(t)
                || (l.deviceLabel ?? "").toLowerCase().includes(t)
                || (l.primaryIp ?? "").includes(t)
                || (l.category ?? "").toLowerCase().includes(t);
        })
        .sort((a: any, b: any) => (a.deviceLabel + a.senderLabel).localeCompare(b.deviceLabel + b.senderLabel));

    // Credential form is deliberately not part of `form` — it posts to its
    // own route and must never be included in a settings save.
    let cred = { currentUsername: "", currentPassword: "", newUsername: "", newPassword: "", newPassword2: "" };
    let credSaving = false;

    function loadForm(s: any) {
        if (!s) return;
        form = {
            registryIp: s.registry?.ip ?? "",
            registryPort: s.registry?.port ?? 80,
            reconnectOnSdpChanges: !!s.reconnectOnSdpChanges,
            fixSdpBugs: !!s.fixSdpBugs,
            autoMulticast: !!s.autoMulticast?.enabled,
            firstDynamicNumber: s.firstDynamicNumber ?? 1000,
            predictiveEnabled: !!s.predictiveStaging?.enabled,
            predictiveCooldownMs: s.predictiveStaging?.cooldownMs ?? 10000,
            bcp008Enabled: s.bcp008?.enabled !== false,
            audioMonitorEnabled: !!s.audioMonitor?.enabled,
            dnssdEnabled: s.registryDiscovery?.unicastDnssd !== false,
            dnssdDomain: s.registryDiscovery?.domain ?? "",
            debugLogs: !!s.debugLogs,
        };
        if (!cred.currentUsername && Array.isArray(s.auth?.users) && s.auth.users.length > 0) {
            cred.currentUsername = s.auth.users[0];
        }
        // Deep copy so edits do not mutate the synced state in place.
        profiles = (s.vendorProfiles ?? []).map((v: any) => ({ ...v }));
        dirty = false;
    }

    // Live discovery status, so the page can show which domains DNS-SD is
    // actually querying — the usual reason "no registry found" is a surprise.
    let searchedDomains: string[] = [];
    let connSync: Subject<any>;

    onMount(async () => {
        sync = ServerConnector.sync("setupConfig");
        sync.subscribe((obj: any) => {
            state = obj;
            restartRequired = !!obj?.restartRequired;
            // Never clobber in-progress edits.
            if (!dirty) loadForm(obj);
        });
        connSync = ServerConnector.sync("nmosConnectionState");
        connSync.subscribe((obj: any) => {
            searchedDomains = obj?.discovery?.domains ?? [];
        });
        probeSync = ServerConnector.sync("probeState");
        probeSync.subscribe((obj: any) => {
            probeState = obj ?? { probes: [] };
        });
        ServerConnector.post("probeToken", {})
            .then((r: any) => { probeToken = r?.data?.token || ""; })
            .catch(() => {});
        leaseSync = ServerConnector.sync("multicastLeases");
        leaseSync.subscribe((obj: any) => {
            leaseState = obj ?? { leases: {}, stats: {} };
        });
    });
    onDestroy(() => {
        if (sync) sync.unsubscribe();
        ServerConnector.unsync("setupConfig");
        if (connSync) connSync.unsubscribe();
        ServerConnector.unsync("nmosConnectionState");
        if (probeSync) probeSync.unsubscribe();
        ServerConnector.unsync("probeState");
        if (leaseSync) leaseSync.unsubscribe();
        ServerConnector.unsync("multicastLeases");
    });

    function touch() {
        dirty = true;
    }

    async function save() {
        if (saving) return;
        saving = true;
        ServerConnector.startLoad();
        try {
            const payload = {
                registry: { ip: form.registryIp.trim(), port: Number(form.registryPort) },
                reconnectOnSdpChanges: !!form.reconnectOnSdpChanges,
                fixSdpBugs: !!form.fixSdpBugs,
                // adoptExisting only matters on the first enable; the server
                // ignores it otherwise.
                autoMulticast: { enabled: !!form.autoMulticast, adoptExisting: adoptExisting },
                firstDynamicNumber: Number(form.firstDynamicNumber),
                predictiveStaging: {
                    enabled: !!form.predictiveEnabled,
                    cooldownMs: Number(form.predictiveCooldownMs),
                },
                bcp008: { enabled: !!form.bcp008Enabled },
                audioMonitor: { enabled: !!form.audioMonitorEnabled },
                registryDiscovery: {
                    unicastDnssd: !!form.dnssdEnabled,
                    domain: form.dnssdDomain.trim(),
                },
                debugLogs: !!form.debugLogs,
                vendorProfiles: profiles.map((v) => ({
                    id: v.id,
                    name: v.name ?? "",
                    labels: v.labels ?? "",
                    protocol: v.protocol === "https" ? "https" : "http",
                    port: Number(v.port) || 80,
                    path: v.path || "/",
                })),
            };
            const res: any = await ServerConnector.post("setupConfig", payload);
            dirty = false;
            restartRequired = !!res?.data?.restartRequired;
            ServerConnector.addFeedback({
                level: "success",
                message: restartRequired
                    ? "Settings saved. A server restart is needed for some changes to take effect."
                    : "Settings saved.",
            });
        } catch (e: any) {
            ServerConnector.addFeedback({ level: "error", message: "Could not save settings: " + (e?.message ?? e) });
        } finally {
            saving = false;
            ServerConnector.endLoad();
        }
    }

    function revert() {
        loadForm(state);
    }

    // Turning Multicast DHCP on for the first time is the one destructive
    // moment: either we record what devices already transmit on, or we hand
    // everything a fresh address and every stream re-establishes. Default to
    // the safe one and make the other an explicit choice.
    let adoptExisting = true;

    // The click is intercepted with preventDefault so that enabling can ask the
    // adopt-or-renew question BEFORE the toggle moves. That means this handler
    // owns the state in both directions: the browser will not flip the checkbox
    // for us, so forgetting to assign here left the toggle permanently stuck on.
    function askEnableMulticast() {
        if (form.autoMulticast) {
            // Turning it OFF repoints nothing, so it needs no question — but it
            // does still need the assignment the preventDefault suppressed.
            form.autoMulticast = false;
            touch();
            return;
        }
        adoptModal.showModal();
    }

    function confirmEnableMulticast(adopt: boolean) {
        adoptExisting = adopt;
        form.autoMulticast = true;
        touch();
    }

    async function releaseLease(senderId: string) {
        try {
            await ServerConnector.post("releaseLease", { senderId });
            ServerConnector.addFeedback({ level: "success", message: "Lease released." });
        } catch (e: any) {
            ServerConnector.addFeedback({ level: "error", message: "Could not release: " + (e?.message ?? e) });
        }
    }

    async function releaseAllLeases() {
        try {
            const r: any = await ServerConnector.post("releaseAllLeases", {});
            ServerConnector.addFeedback({ level: "success", message: "Released " + (r?.data?.released ?? 0) + " lease(s)." });
        } catch (e: any) {
            ServerConnector.addFeedback({ level: "error", message: "Could not release: " + (e?.message ?? e) });
        }
    }

    async function exportLeases() {
        try {
            const r: any = await ServerConnector.get("exportLeases");
            const blob = new Blob([JSON.stringify(r?.data ?? {}, null, 2)], { type: "application/json" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "multicast-leases.json";
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (e: any) {
            ServerConnector.addFeedback({ level: "error", message: "Export failed: " + (e?.message ?? e) });
        }
    }

    function importLeases(ev: Event) {
        const input = ev.target as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async () => {
            try {
                const parsed = JSON.parse("" + reader.result);
                const r: any = await ServerConnector.post("importLeases", parsed);
                ServerConnector.addFeedback({
                    level: "success",
                    message: "Imported " + (r?.data?.imported ?? 0) + " lease(s)"
                        + (r?.data?.dropped ? ", " + r.data.dropped + " dropped" : "") + ".",
                });
            } catch (e: any) {
                ServerConnector.addFeedback({ level: "error", message: "Import failed: " + (e?.message ?? e) });
            } finally {
                input.value = "";
            }
        };
        reader.readAsText(file);
    }

    async function copyProbeCommand() {
        const cmd = probeRunCommand(probeToken);
        try {
            await navigator.clipboard.writeText(cmd);
            ServerConnector.addFeedback({ level: "success", message: "Probe command copied." });
        } catch (e) {
            ServerConnector.addFeedback({ level: "error", message: "The browser refused clipboard access." });
        }
    }

    // Ready-to-paste command for the probe sidecar. Host networking is required
    // so it can actually join the media network's multicast groups.
    function probeRunCommand(token: string): string {
        const origin = window.location.host || "crosspoint";
        return "docker run -d --restart unless-stopped --network host \\\n" +
            "  -e MODE=probe \\\n" +
            "  -e CROSSPOINT_URL=ws://" + origin + " \\\n" +
            "  -e PROBE_TOKEN=" + (token || "<token>") + " \\\n" +
            '  -e PROBE_NAME="Studio A" \\\n' +
            "  ghcr.io/avassdal/nmos_crosspoint_registry_router:latest";
    }

    function addProfile() {
        profiles = [...profiles, {
            id: "v_" + Math.random().toString(36).slice(2, 8),
            name: "", labels: "", protocol: "http", port: 80, path: "/",
        }];
        touch();
    }

    function removeProfile(id: string) {
        profiles = profiles.filter((p) => p.id !== id);
        touch();
    }

    // Order is priority — first match wins on the server — so rows need to be
    // movable, not just editable.
    function moveProfile(index: number, delta: number) {
        const next = index + delta;
        if (next < 0 || next >= profiles.length) return;
        const copy = [...profiles];
        [copy[index], copy[next]] = [copy[next], copy[index]];
        profiles = copy;
        touch();
    }

    async function saveCredentials() {
        if (credSaving) return;
        if (!cred.currentUsername || !cred.currentPassword) {
            ServerConnector.addFeedback({ level: "error", message: "Current username and password are required." });
            return;
        }
        if (cred.newPassword !== cred.newPassword2) {
            ServerConnector.addFeedback({ level: "error", message: "The two new passwords do not match." });
            return;
        }
        if (!cred.newUsername && !cred.newPassword) {
            ServerConnector.addFeedback({ level: "error", message: "Nothing to change." });
            return;
        }
        credSaving = true;
        ServerConnector.startLoad();
        try {
            // Only hashes cross the wire — the server stores sha256(password)
            // and compares against the same, so the plaintext never leaves
            // the browser.
            await ServerConnector.post("changeCredentials", {
                currentUsername: cred.currentUsername.trim(),
                currentPasswordHash: sha256.sha256(cred.currentPassword),
                newUsername: cred.newUsername.trim(),
                newPasswordHash: cred.newPassword ? sha256.sha256(cred.newPassword) : "",
            });
            cred.currentPassword = "";
            cred.newPassword = "";
            cred.newPassword2 = "";
            ServerConnector.addFeedback({
                level: "success",
                message: "Credentials updated. Please sign in again with the new details.",
            });
            ServerConnector.doLogout();
        } catch (e: any) {
            ServerConnector.addFeedback({ level: "error", message: "Could not change credentials: " + (e?.message ?? e) });
        } finally {
            credSaving = false;
            ServerConnector.endLoad();
        }
    }
</script>

<dialog bind:this={adoptModal} class="modal">
    <div class="modal-box">
        <h3 class="font-bold text-lg">Enable Multicast DHCP</h3>
        <p>
            Senders on this network already have addresses. Choose what happens to them.
        </p>
        <ul class="adopt-list">
            <li>
                <strong>Keep current addresses</strong> — record what each sender is already
                transmitting on as its lease. Nothing is repointed and no stream is
                interrupted. Recommended on a live network.
            </li>
            <li>
                <strong>Renew from the pool</strong> — give every active sender a fresh pair
                from its essence range. Every affected stream re-establishes, and receivers
                follow. This re-addresses the plant.
            </li>
        </ul>
        <div class="modal-action">
            <form method="dialog">
                <button class="btn btn-sm btn-primary" on:click={()=>confirmEnableMulticast(true)}>Keep current addresses</button>
                <button class="btn btn-sm btn-error" on:click={()=>confirmEnableMulticast(false)}>Renew from pool</button>
                <button class="btn btn-sm">Cancel</button>
            </form>
        </div>
    </div>
</dialog>

<div class="setup-page">
    <div class="setup-header">
        <div>
            <h2>Setup</h2>
            <span class="setup-version">Version {state?.version ?? "…"}</span>
        </div>
        <div class="setup-actions">
            {#if restartRequired}
                <span class="badge badge-warning">Restart required</span>
            {/if}
            {#if dirty}
                <span class="badge badge-info">Unsaved changes</span>
            {/if}
            <button class="btn btn-sm" disabled={!dirty || saving} on:click={revert}>Revert</button>
            <button class="btn btn-sm btn-primary" disabled={!dirty || saving} on:click={save}>
                {saving ? "Saving…" : "Save"}
            </button>
        </div>
    </div>

    {#if !state}
        <div class="setup-container"><p>Loading settings…</p></div>
    {:else}
        <div class="setup-container">
            <section class="setup-section">
                <h3>Connection</h3>
                <p class="setup-hint">
                    The static NMOS registry. Changing it needs a restart — the connector builds
                    its registry list once at startup.
                </p>
                <div class="setup-row">
                    <label class="label" for="registryIp">Registry address</label>
                    <input id="registryIp" class="input input-bordered input-sm" type="text"
                        placeholder="10.0.0.1" bind:value={form.registryIp} on:input={touch} />
                </div>
                <div class="setup-row">
                    <label class="label" for="registryPort">Registry port</label>
                    <input id="registryPort" class="input input-bordered input-sm" type="number"
                        min="1" max="65535" bind:value={form.registryPort} on:input={touch} />
                </div>
                <div class="setup-row">
                    <label class="label" for="dnssdEnabled">Unicast DNS-SD discovery</label>
                    <input id="dnssdEnabled" class="toggle" type="checkbox"
                        bind:checked={form.dnssdEnabled} on:change={touch} />
                </div>
                <div class="setup-row">
                    <label class="label" for="dnssdDomain">Discovery domain</label>
                    <input id="dnssdDomain" class="input input-bordered input-sm" type="text"
                        placeholder="from resolv.conf" bind:value={form.dnssdDomain} on:input={touch} />
                </div>
                <p class="setup-hint">
                    Finds the registry over ordinary DNS, which works where mDNS cannot reach.
                    Leave the domain empty to use the system resolver's search list. A static
                    registry address always wins.
                    {#if searchedDomains.length > 0}
                        <br />Currently searching: <code>{searchedDomains.join(", ")}</code>
                    {/if}
                </p>
            </section>

            <section class="setup-section">
                <h3>Monitoring</h3>
                <div class="setup-row">
                    <label class="label" for="bcp008Enabled">BCP-008 status monitoring</label>
                    <input id="bcp008Enabled" class="toggle" type="checkbox"
                        bind:checked={form.bcp008Enabled} on:change={touch} />
                </div>
                <p class="setup-hint">
                    Subscribes to each device's IS-12 sender and receiver monitors and shows
                    live health per flow in the matrix. Read-only on the network. Applies
                    immediately — turning it off closes every control connection.
                </p>

                <div class="setup-row">
                    <label class="label" for="audioMonitorEnabled">Audio monitor</label>
                    <input id="audioMonitorEnabled" class="toggle" type="checkbox"
                        bind:checked={form.audioMonitorEnabled} on:change={touch} />
                </div>
                <p class="setup-hint">
                    Adds a listen button next to each audio sender on the Details page. The
                    server joins the multicast, transcodes to Opus and streams it to the
                    browser over WebRTC. It needs access to the media network — or a probe
                    below, which it then uses automatically.
                </p>

                <h4 class="setup-subhead">Multicast probe</h4>
                <p class="setup-hint">
                    Run this on a host that <em>is</em> attached to the media network. It
                    forwards multicast to the crosspoint as unicast over an authenticated
                    websocket, so the crosspoint container needs no multicast access at all.
                </p>
                <pre class="probe-cmd">{probeRunCommand(probeToken)}</pre>
                <div class="setup-row">
                    <button class="btn btn-sm" on:click={copyProbeCommand}>Copy command</button>
                </div>
                {#if probeState.probes && probeState.probes.length > 0}
                    <table class="mon-table">
                        <thead><tr><th>Probe</th><th>Address</th><th>Streams</th></tr></thead>
                        <tbody>
                            {#each probeState.probes as p}
                                <tr><td>{p.name}</td><td>{p.address}</td><td>{p.streams}</td></tr>
                            {/each}
                        </tbody>
                    </table>
                {:else}
                    <p class="setup-hint">No probe connected.</p>
                {/if}
            </section>

            <section class="setup-section">
                <h3>Switching</h3>
                <div class="setup-row">
                    <label class="label" for="reconnectOnSdpChanges">Receiver auto-reconnect on SDP change</label>
                    <input id="reconnectOnSdpChanges" class="toggle" type="checkbox"
                        bind:checked={form.reconnectOnSdpChanges} on:change={touch} />
                </div>
                <p class="setup-hint">
                    Re-execute a receiver when its sender's SDP changes. Off by default — many
                    devices renegotiate on their own.
                </p>
                <div class="setup-row">
                    <label class="label" for="fixSdpBugs">Work around known SDP bugs</label>
                    <input id="fixSdpBugs" class="toggle" type="checkbox"
                        bind:checked={form.fixSdpBugs} on:change={touch} />
                </div>
                <div class="setup-row">
                    <label class="label" for="firstDynamicNumber">First dynamic crosspoint number</label>
                    <input id="firstDynamicNumber" class="input input-bordered input-sm" type="number"
                        min="1" bind:value={form.firstDynamicNumber} on:input={touch} />
                </div>
            </section>

            <section class="setup-section setup-section-wide">
                <h3>Addressing</h3>
                <div class="setup-row">
                    <label class="label" for="autoMulticast">Multicast DHCP</label>
                    <input id="autoMulticast" class="toggle" type="checkbox"
                        checked={form.autoMulticast} on:click|preventDefault={askEnableMulticast} />
                </div>
                <p class="setup-hint">
                    Hands each active sender a reserved pair of addresses — odd and odd+1 so
                    ST 2022-7 legs stay adjacent — drawn from the range configured for its
                    essence type in <code>multicastRanges</code>. Manual edits on the Details
                    page win over the reservation; clearing the field returns the leg to it.
                </p>

                <table class="mon-table">
                    <thead><tr><th>Essence</th><th>Range</th><th>Used</th><th>Capacity</th></tr></thead>
                    <tbody>
                        {#each Object.keys(CATEGORY_LABEL) as cat}
                            <tr>
                                <td>{CATEGORY_LABEL[cat]}</td>
                                <td class="lease-ip">{state?.multicastRanges?.[cat]?.primary ?? "—"}</td>
                                <td class="mon-num">{leaseState.stats?.[cat]?.used ?? 0}</td>
                                <td class="mon-num">{leaseState.stats?.[cat]?.total ?? 0}</td>
                            </tr>
                        {/each}
                    </tbody>
                </table>

                <h4 class="setup-subhead">Lease inventory</h4>
                <div class="setup-row">
                    <input class="input input-bordered input-sm" type="text"
                        placeholder="filter by name, address or essence" bind:value={leaseFilter} />
                    <span class="lease-count">{leaseRows.length} lease{leaseRows.length === 1 ? "" : "s"}</span>
                </div>
                {#if leaseRows.length === 0}
                    <p class="setup-hint">No leases yet.</p>
                {:else}
                    <table class="mon-table lease-table">
                        <thead>
                            <tr>
                                <th>Status</th><th>Device</th><th>Sender</th><th>Essence</th>
                                <th>Leg 1</th><th>Leg 2</th><th>Allocated</th><th></th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each leaseRows as l (l.senderId)}
                                <tr>
                                    <td><span class="lease-dot lease-{l.liveStatus}"
                                        use:OverlayMenuService.tooltip data-tooltip={l.liveStatus}></span></td>
                                    <td>{l.deviceLabel || "—"}</td>
                                    <td>{l.senderLabel || l.senderId.slice(0, 8)}</td>
                                    <td>{CATEGORY_LABEL[l.category] ?? l.category}</td>
                                    <td class="lease-ip">
                                        {l.overrideIp?.["0"] ?? l.primaryIp}
                                        {#if l.overrideIp?.["0"]}<span class="lease-override">manual</span>{/if}
                                    </td>
                                    <td class="lease-ip">
                                        {l.overrideIp?.["1"] ?? l.secondaryIp}
                                        {#if l.overrideIp?.["1"]}<span class="lease-override">manual</span>{/if}
                                    </td>
                                    <td>{(l.createdAt ?? "").slice(0, 10)}</td>
                                    <td class="vp-actions">
                                        <button class="btn btn-xs btn-error"
                                            on:click={()=>releaseLease(l.senderId)} title="release this lease">✕</button>
                                    </td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                {/if}
                <div class="setup-row lease-actions">
                    <button class="btn btn-sm" on:click={exportLeases}>Export</button>
                    <label class="btn btn-sm">
                        Import
                        <input type="file" accept="application/json" class="hidden" on:change={importLeases} />
                    </label>
                    <button class="btn btn-sm btn-error" on:click={releaseAllLeases}>Release all</button>
                </div>
            </section>

            <section class="setup-section">
                <h3>Performance</h3>
                <div class="setup-row">
                    <label class="label" for="predictiveEnabled">Predictive connection staging</label>
                    <input id="predictiveEnabled" class="toggle" type="checkbox"
                        bind:checked={form.predictiveEnabled} on:change={touch} />
                </div>
                <div class="setup-row">
                    <label class="label" for="predictiveCooldownMs">Staging cooldown (ms)</label>
                    <input id="predictiveCooldownMs" class="input input-bordered input-sm" type="number"
                        min="0" bind:value={form.predictiveCooldownMs} on:input={touch} />
                </div>
                <p class="setup-hint">
                    Pre-stages the most likely next sender on a receiver so a take completes
                    faster. Enabling or disabling it needs a restart.
                </p>
            </section>

            <section class="setup-section">
                <h3>Diagnostics</h3>
                <div class="setup-row">
                    <label class="label" for="debugLogs">Debug and verbose logging</label>
                    <input id="debugLogs" class="toggle" type="checkbox"
                        bind:checked={form.debugLogs} on:change={touch} />
                </div>
                <p class="setup-hint">
                    Applies immediately. The <code>DEBUG_LOGS</code> environment variable
                    overrides this at startup.
                </p>
            </section>

            <section class="setup-section setup-section-wide">
                <h3>Device Web UI links</h3>
                <p class="setup-hint">
                    Builds the "open device web UI" link on the Details page. Labels are
                    matched as comma-separated substrings against the NMOS <em>node</em>
                    label, and the first matching row wins — so order is priority. A webui
                    control advertised by the device itself always takes precedence over
                    these.
                </p>
                <table class="vp-table">
                    <thead>
                        <tr>
                            <th>Name</th><th>Labels match</th><th>Proto</th>
                            <th>Port</th><th>Path</th><th></th>
                        </tr>
                    </thead>
                    <tbody>
                        {#each profiles as prof, i (prof.id)}
                            <tr>
                                <td><input class="input input-bordered input-xs" type="text"
                                    bind:value={prof.name} on:input={touch} /></td>
                                <td><input class="input input-bordered input-xs vp-labels" type="text"
                                    placeholder="Matrox, ConvertIP"
                                    bind:value={prof.labels} on:input={touch} /></td>
                                <td>
                                    <select class="select select-bordered select-xs"
                                        bind:value={prof.protocol} on:change={touch}>
                                        <option value="http">http</option>
                                        <option value="https">https</option>
                                    </select>
                                </td>
                                <td><input class="input input-bordered input-xs vp-port" type="number"
                                    min="1" max="65535" bind:value={prof.port} on:input={touch} /></td>
                                <td><input class="input input-bordered input-xs vp-path" type="text"
                                    bind:value={prof.path} on:input={touch} /></td>
                                <td class="vp-actions">
                                    <button class="btn btn-xs" disabled={i === 0}
                                        on:click={()=>moveProfile(i,-1)} title="move up">↑</button>
                                    <button class="btn btn-xs" disabled={i === profiles.length-1}
                                        on:click={()=>moveProfile(i,1)} title="move down">↓</button>
                                    <button class="btn btn-xs btn-error"
                                        on:click={()=>removeProfile(prof.id)} title="remove">✕</button>
                                </td>
                            </tr>
                        {/each}
                    </tbody>
                </table>
                <div class="setup-row">
                    <button class="btn btn-sm" on:click={addProfile}>Add profile</button>
                </div>
            </section>

            <section class="setup-section">
                <h3>Access</h3>
                <p class="setup-hint">
                    You can only change your own account, and you have to know the current
                    password. After a change the server signs you out.
                </p>
                <div class="setup-row">
                    <label class="label" for="curUser">Current username</label>
                    <input id="curUser" class="input input-bordered input-sm" type="text"
                        bind:value={cred.currentUsername} />
                </div>
                <div class="setup-row">
                    <label class="label" for="curPass">Current password</label>
                    <input id="curPass" class="input input-bordered input-sm" type="password"
                        autocomplete="current-password" bind:value={cred.currentPassword} />
                </div>
                <div class="setup-row">
                    <label class="label" for="newUser">New username (optional)</label>
                    <input id="newUser" class="input input-bordered input-sm" type="text"
                        placeholder="leave empty to keep" bind:value={cred.newUsername} />
                </div>
                <div class="setup-row">
                    <label class="label" for="newPass">New password (optional)</label>
                    <input id="newPass" class="input input-bordered input-sm" type="password"
                        autocomplete="new-password" placeholder="leave empty to keep"
                        bind:value={cred.newPassword} />
                </div>
                <div class="setup-row">
                    <label class="label" for="newPass2">Repeat new password</label>
                    <input id="newPass2" class="input input-bordered input-sm" type="password"
                        autocomplete="new-password" bind:value={cred.newPassword2} />
                </div>
                <div class="setup-row">
                    <button class="btn btn-sm btn-primary" disabled={credSaving} on:click={saveCredentials}>
                        {credSaving ? "Saving…" : "Change credentials"}
                    </button>
                </div>
            </section>
        </div>
    {/if}
</div>
