export function parseSettings(settings:any){


    if(!settings.hasOwnProperty("reconnectOnSdpChanges")){
        settings.reconnectOnSdpChanges = false;
    }else{
        if(typeof settings.reconnectOnSdpChanges != "boolean"){
            settings.reconnectOnSdpChanges = false;
        }
    }


    if(!settings.hasOwnProperty("fixSdpBugs")){
        settings.fixSdpBugs = false;
    }else{
        if(typeof settings.fixSdpBugs != "boolean"){
            settings.fixSdpBugs = false;
        }
    }


    // Multicast DHCP. This used to be a bare boolean; the lease manager needs
    // room for more than one flag, so a boolean is migrated in place rather
    // than reset — an operator who had it on keeps it on.
    if(!settings.hasOwnProperty("autoMulticast")){
        settings.autoMulticast = { enabled: false };
    }else if(typeof settings.autoMulticast === "boolean"){
        settings.autoMulticast = { enabled: settings.autoMulticast };
    }else if(typeof settings.autoMulticast !== "object" || settings.autoMulticast === null){
        settings.autoMulticast = { enabled: false };
    }else if(typeof settings.autoMulticast.enabled !== "boolean"){
        settings.autoMulticast.enabled = false;
    }

    // Per-essence multicast ranges. These select which pool a lease is drawn
    // from, so a missing or malformed entry means that essence type simply has
    // no capacity — which the Setup page shows rather than silently papering
    // over with a shared default.
    if(!settings.hasOwnProperty("multicastRanges") || typeof settings.multicastRanges !== "object" || settings.multicastRanges === null){
        settings.multicastRanges = {};
    }
    {
        /**
         * Validate a CIDR properly rather than by shape.
         *
         * A shape-only regex accepted "2399.120.0.0/16" and "239.1.1.1/99",
         * and the lease manager's address parser answered 0 for anything it
         * could not read — so a typo became a pool at 0.0.0.0 whose addresses
         * were then PATCHed onto real devices as multicast destinations.
         *
         * Also requires the range to sit inside the multicast space. These
         * values become destination_ip for multicast streams, so a unicast
         * range here is a configuration error however well-formed it looks.
         */
        const parseCidr = (value:string): { ok:boolean, reason?:string } => {
            const m = ("" + value).match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
            if(!m){ return { ok:false, reason:"not in a.b.c.d/len form" }; }
            const octets = [m[1], m[2], m[3], m[4]].map((o) => parseInt(o, 10));
            if(octets.some((o) => !Number.isFinite(o) || o < 0 || o > 255)){
                return { ok:false, reason:"an octet is outside 0-255" };
            }
            const bits = parseInt(m[5], 10);
            if(!Number.isFinite(bits) || bits < 4 || bits > 32){
                return { ok:false, reason:"prefix length must be between 4 and 32" };
            }
            // 224.0.0.0/4 is the multicast space.
            if(octets[0] < 224 || octets[0] > 239){
                return { ok:false, reason:"not a multicast address (expected 224-239 in the first octet)" };
            }
            return { ok:true };
        };
        const defaults:any = {
            video:    "239.120.0.0/16",
            videoUhd: "239.121.0.0/16",
            jxsv:     "239.122.0.0/16",
            audio:    "239.130.0.0/16",
            other:    "239.140.0.0/16"
        };
        for(const cat of Object.keys(defaults)){
            let e = settings.multicastRanges[cat];
            if(!e || typeof e !== "object"){
                e = {};
                settings.multicastRanges[cat] = e;
            }
            if(typeof e.primary !== "string"){
                e.primary = defaults[cat];
            }else{
                const check = parseCidr(e.primary);
                if(!check.ok){
                    // Say so loudly: falling back silently would leave the
                    // operator looking at a range in settings.json that the
                    // allocator is not using.
                    console.warn("[settings] multicastRanges." + cat + ".primary '" + e.primary +
                        "' is not a usable multicast CIDR (" + check.reason + "); using " + defaults[cat] + " instead.");
                    e.primary = defaults[cat];
                }
            }
            // `secondary` is retained for backwards compatibility but no longer
            // consulted: a lease's two legs must be adjacent for ST 2022-7, and
            // two independent ranges cannot express that.
            if(typeof e.secondary !== "string" || !parseCidr(e.secondary).ok){
                e.secondary = e.primary;
            }
        }
    }


    if(!settings.hasOwnProperty("firstDynamicNumber")){
        settings.firstDynamicNumber = 1000;
    }else{
        if(typeof settings.firstDynamicNumber != "number"){
            settings.firstDynamicNumber = 1000;
        }else{
            settings.firstDynamicNumber = Number.parseInt(settings.firstDynamicNumber);
        }

        if(settings.firstDynamicNumber < 1){
            settings.firstDynamicNumber = 1000;
        }
    }


    // Predictive staging configuration
    if(!settings.hasOwnProperty("predictiveStaging")){
        settings.predictiveStaging = { enabled: false, cooldownMs: 10000, perReceiver: {} };
    }else{
        const ps = settings.predictiveStaging;
        if(typeof ps !== 'object' || ps === null){
            settings.predictiveStaging = { enabled: false, cooldownMs: 10000, perReceiver: {} };
        }else{
            if(!ps.hasOwnProperty('enabled') || typeof ps.enabled !== 'boolean'){
                ps.enabled = false;
            }
            if(!ps.hasOwnProperty('cooldownMs')){
                ps.cooldownMs = 10000;
            }else{
                if(typeof ps.cooldownMs !== 'number'){
                    ps.cooldownMs = 10000;
                }else{
                    ps.cooldownMs = Number.parseInt(ps.cooldownMs);
                    if(ps.cooldownMs < 0){ ps.cooldownMs = 10000; }
                }
            }
            if(!ps.hasOwnProperty('perReceiver') || typeof ps.perReceiver !== 'object'){
                ps.perReceiver = {};
            }
        }
    }

    // Device Web-UI link profiles. Matched by substring against the NMOS node
    // label, first match wins, so the array order is the operator's priority.
    // A webui control advertised by the device itself always outranks these.
    const defaultVendorProfiles = [
        { id:"matrox",      name:"Matrox ConvertIP", labels:"Matrox, ConvertIP",   protocol:"https", port:443, path:"/" },
        { id:"embrionix",   name:"Riedel Embrionix", labels:"Embrionix",           protocol:"https", port:443, path:"/" },
        { id:"riedel",      name:"Riedel",           labels:"Riedel",              protocol:"http",  port:80,  path:"/" },
        { id:"lawo",        name:"Lawo",             labels:"Lawo",                protocol:"http",  port:80,  path:"/" },
        { id:"aja",         name:"AJA",              labels:"AJA",                 protocol:"http",  port:80,  path:"/" },
        { id:"imagine",     name:"Imagine",          labels:"Imagine",             protocol:"http",  port:80,  path:"/" },
        { id:"sony",        name:"Sony",             labels:"Sony",                protocol:"http",  port:80,  path:"/" },
        { id:"grassvalley", name:"Grass Valley",     labels:"Grass Valley",        protocol:"http",  port:80,  path:"/" },
        { id:"blackmagic",  name:"Blackmagic",       labels:"Blackmagic",          protocol:"http",  port:80,  path:"/admin" },
        { id:"merging",     name:"Merging",          labels:"Anubis, Hapi, Horus", protocol:"http",  port:80,  path:"/advanced" },
        { id:"directout",   name:"DirectOut",        labels:"ExBox",               protocol:"http",  port:80,  path:"/" },
        { id:"qsc",         name:"QSC",              labels:"Core",                protocol:"http",  port:80,  path:"/" },
        { id:"netgear",     name:"NETGEAR M4350",    labels:"M4350",               protocol:"http",  port:80,  path:"/" }
    ];
    if(!Array.isArray(settings.vendorProfiles)){
        settings.vendorProfiles = defaultVendorProfiles;
    }else{
        settings.vendorProfiles = settings.vendorProfiles
            .filter((v:any) => v && typeof v === "object")
            .map((v:any) => {
                let port = parseInt(""+v.port);
                if(isNaN(port) || port <= 0 || port > 65535){ port = 80; }
                let protocol = (""+v.protocol).toLowerCase();
                if(protocol !== "http" && protocol !== "https"){ protocol = "http"; }
                let path = (typeof v.path === "string" && v.path) ? v.path : "/";
                if(!path.startsWith("/")){ path = "/" + path; }
                return {
                    id: (typeof v.id === "string" && v.id) ? v.id : ("v_" + Math.random().toString(36).slice(2,8)),
                    name: (typeof v.name === "string") ? v.name : "",
                    labels: (typeof v.labels === "string") ? v.labels : "",
                    protocol,
                    port,
                    path
                };
            });
    }

    // Multicast probe: a shared secret the probe container authenticates with.
    // Minted once and then persisted — this is the reason settings.json is
    // written back at startup, since a fresh token every boot would lock out
    // every already-deployed probe.
    if(!settings.hasOwnProperty("probe") || typeof settings.probe !== "object" || settings.probe === null){
        settings.probe = { token: "" };
    }
    if(typeof settings.probe.token !== "string" || settings.probe.token.length < 32){
        settings.probe.token = require("crypto").randomBytes(24).toString("hex");
    }

    // Audio monitor: WebRTC listen-in on audio senders. Off by default — it
    // needs the server to reach the media network, or a probe to do it.
    if(!settings.hasOwnProperty("audioMonitor") || typeof settings.audioMonitor !== "object" || settings.audioMonitor === null){
        settings.audioMonitor = { enabled: false };
    }else{
        if(typeof settings.audioMonitor.enabled !== "boolean"){
            settings.audioMonitor.enabled = false;
        }
    }

    // ----- Virtual NMOS node -----
    // Serves an IS-04 Node API carrying operator-supplied SDPs, so devices
    // with no NMOS support of their own still appear to the rest of the plant.
    // Off by default: it registers resources in someone else's registry, so it
    // has to be an explicit choice.
    //
    // The identifiers below are MINTED and must survive a restart, or every
    // boot would register a new node and orphan the previous one in the
    // registry. This is the main reason settings.json is written back.
    {
        const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const mkUuid = () => require("crypto").randomUUID();

        if(!settings.virtualNode || typeof settings.virtualNode !== "object"){
            settings.virtualNode = {};
        }
        const vn = settings.virtualNode;
        if(typeof vn.enabled !== "boolean"){ vn.enabled = false; }
        if(typeof vn.nodeId !== "string" || !uuidRe.test(vn.nodeId)){ vn.nodeId = mkUuid(); }
        if(typeof vn.deviceId !== "string" || !uuidRe.test(vn.deviceId)){ vn.deviceId = mkUuid(); }
        if(typeof vn.label !== "string" || !vn.label){ vn.label = "NMOS Crosspoint Virtual Node"; }
        // Empty means "work the advertised address out from the interfaces".
        if(typeof vn.advertiseHost !== "string"){ vn.advertiseHost = ""; }

        if(!Array.isArray(settings.virtualSenders)){
            settings.virtualSenders = [];
        }else{
            settings.virtualSenders = settings.virtualSenders
                .filter((v:any) => v && typeof v === "object")
                .map((v:any) => ({
                    id:   (typeof v.id === "string" && v.id) ? v.id : ("vs_" + Math.random().toString(36).slice(2,10)),
                    name: (typeof v.name === "string") ? v.name : "",
                    sdp:  (typeof v.sdp === "string") ? v.sdp : "",
                    // Published as sender_id / source_id / flow_id in IS-04,
                    // so they must be stable across restarts too.
                    senderId: (typeof v.senderId === "string" && uuidRe.test(v.senderId)) ? v.senderId : mkUuid(),
                    sourceId: (typeof v.sourceId === "string" && uuidRe.test(v.sourceId)) ? v.sourceId : mkUuid(),
                    flowId:   (typeof v.flowId   === "string" && uuidRe.test(v.flowId))   ? v.flowId   : mkUuid(),
                }));
        }
    }

    // The PTP grandmaster the plant is supposed to be locked to; the virtual
    // node publishes it as its clock reference.
    if(!settings.hasOwnProperty("acceptableGmid") || typeof settings.acceptableGmid !== "string"){
        settings.acceptableGmid = "";
    }

    // DDNS: publish each node's name as an A record via RFC 2136 dynamic
    // updates. Off by default — it writes to someone else's DNS server.
    //
    // keySecret is a credential: it is normalised here but must never be sent
    // to a client, which is why getSetupConfigState reports only keySecretSet.
    if(!settings.hasOwnProperty("ddns") || typeof settings.ddns !== "object" || settings.ddns === null){
        settings.ddns = {};
    }
    {
        const d = settings.ddns;
        const ALGORITHMS = ["hmac-sha256", "hmac-sha512", "hmac-sha1", "hmac-md5", "none"];
        if(typeof d.enabled !== "boolean"){ d.enabled = false; }
        if(typeof d.server !== "string"){ d.server = ""; }
        if(typeof d.zone !== "string"){ d.zone = ""; }
        if(typeof d.keyName !== "string"){ d.keyName = ""; }
        if(typeof d.keySecret !== "string"){ d.keySecret = ""; }
        if(typeof d.port !== "number" || d.port < 1 || d.port > 65535){ d.port = 53; }
        if(typeof d.ttl !== "number" || d.ttl < 1 || d.ttl > 604800){ d.ttl = 300; }
        // "none" means unsigned, for a server that authorises by source IP.
        if(ALGORITHMS.indexOf(d.keyAlgorithm) === -1){ d.keyAlgorithm = "hmac-sha256"; }
    }

    // BCP-008 status monitoring. Read-only IS-12 client, on by default.
    if(!settings.hasOwnProperty("bcp008") || typeof settings.bcp008 !== "object" || settings.bcp008 === null){
        settings.bcp008 = { enabled: true };
    }else{
        if(!settings.bcp008.hasOwnProperty("enabled") || typeof settings.bcp008.enabled !== "boolean"){
            settings.bcp008.enabled = true;
        }
    }

    // Registry discovery: unicast DNS-SD (RFC 6763 over normal DNS) is on by
    // default, with an optional domain override. An empty domain means "use
    // the system resolver's search list".
    if(!settings.hasOwnProperty("registryDiscovery") || typeof settings.registryDiscovery !== "object" || settings.registryDiscovery === null){
        settings.registryDiscovery = { unicastDnssd: true, domain: "" };
    }else{
        const rd = settings.registryDiscovery;
        if(!rd.hasOwnProperty("unicastDnssd") || typeof rd.unicastDnssd !== "boolean"){
            rd.unicastDnssd = true;
        }
        if(!rd.hasOwnProperty("domain") || typeof rd.domain !== "string"){
            rd.domain = "";
        }
    }

    // Debug logs toggle (controls debug/verbose output through SyncLog)
    if(!settings.hasOwnProperty("debugLogs")){
        settings.debugLogs = false;
    }else{
        if(typeof settings.debugLogs !== "boolean"){
            settings.debugLogs = false;
        }
    }

    return settings;
}