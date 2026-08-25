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


    if(!settings.hasOwnProperty("autoMulticast")){
        settings.autoMulticast = false;
    }else{
        if(typeof settings.autoMulticast != "boolean"){
            settings.autoMulticast = false;
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