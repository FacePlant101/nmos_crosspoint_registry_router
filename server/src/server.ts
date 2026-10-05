/* 
    NMOS Crosspoint
    Copyright (C) 2021 Johannes Grieb
*/


const fs = require("fs");
const path = require("path");

import {MdnsService} from "./lib/mdnsService"

import { SyncLog } from "./lib/syncLog";


import { NmosRegistryConnector } from "./lib/nmosConnector";
import { WebsocketClient } from "./lib/SyncServer/websocketClient";

import { WebsocketSyncServer } from "./lib/SyncServer/websocketSyncServer";
import { CrosspointAbstraction } from "./lib/crosspointAbstraction";
import { Topology } from "./lib/topology";
import { MediaDevices } from "./lib/mediaDevices";
import { SyncObject } from "./lib/SyncServer/syncObject";
import { parseSettings } from "./lib/parseSettings";
import PredictiveStager from "./lib/predictiveStager";
import { ConnectionLatencyMeasurement } from "./lib/connectionLatencyMeasurement";
import { MatroxAuthHelper } from "./lib/matroxAuthHelper";
import { PrometheusMetrics } from "./lib/prometheusMetrics";
import { NmosHealthMonitor } from "./lib/nmosHealthMonitor";
import { Bcp008Monitor } from "./lib/bcp008Monitor";
import { nmosIdFromCrosspointId } from "./lib/functions";
import { ProbeGateway } from "./lib/probeGateway";
import { AudioMonitorService } from "./lib/audioMonitor";
import { MulticastLeaseManager } from "./lib/multicastLeaseManager";




const uiConfig = {
    "disabledModules":{
        "core":[]
    }
};


const log = new SyncLog();
SyncLog.log("info", "Process", "Server Startup.");

let CROSSPOINT_VERSION = "unknown";
try{
    CROSSPOINT_VERSION = require(path.join(__dirname, "..", "package.json")).version || "unknown";
}catch(e){}

let settings: any = {};
let rawSettingsText: string = "";
try {
    let rawFile = fs.readFileSync("./config/settings.json");
    rawSettingsText = rawFile.toString();
    let tempSettings = JSON.parse(rawFile);
    settings = parseSettings(tempSettings);
} catch (e) {
    SyncLog.log("error", "Settings", "Error while reading file: ./config/settings.json", e);
    SyncLog.log("error", "Settings", "Can not run without Configuration...");
    process.exit();
}

// parseSettings not only fills in defaults, it MINTS identifiers (probe
// tokens, virtual sender/node UUIDs). Those have to survive a restart, so the
// normalised result is written back whenever it differs from what was read.
// ./config must therefore be writable — if it is not, say so loudly rather
// than silently handing out a different token on every boot.
try {
    let serialised = JSON.stringify(settings, null, 4);
    if (serialised !== rawSettingsText) {
        fs.writeFileSync("./config/settings.json", serialised);
        SyncLog.log("info", "Settings", "Normalised ./config/settings.json written back.");
    }
} catch (e) {
    SyncLog.log("error", "Settings",
        "Could not persist ./config/settings.json — any minted identifiers " +
        "(probe token, virtual sender IDs) will change on every restart. " +
        "Make the config directory writable.", e);
}

if(settings.hasOwnProperty("logOutput")){
    log.setOutput(settings.logOutput);
}

// Configure debug log gating (from settings and optional env override)
try{
    const envDbg = process.env.DEBUG_LOGS || process.env.DEBUG;
    let debugFlag = !!settings.debugLogs;
    if (typeof envDbg === 'string') {
        const lowered = envDbg.toLowerCase();
        if (['1','true','yes','on'].includes(lowered)) debugFlag = true;
        if (['0','false','no','off'].includes(lowered)) debugFlag = false;
    }
    SyncLog.setDebugEnabled(debugFlag);
    SyncLog.info("server", `Debug logs ${debugFlag ? 'ENABLED' : 'disabled'}`);
}catch(e){}

let serverPort = 80;
let serverAddress = "0.0.0.0";

let modDisabled:string[]=[];

let mdns = new MdnsService(settings);
try{
    if(settings.hasOwnProperty("disabledModules") && settings.disabledModules.hasOwnProperty("core")){
        uiConfig.disabledModules.core = settings.disabledModules.core;
        settings.disabledModules.core.forEach((m)=>{
            let name = ""+m;
            modDisabled.push(name);
        });
        // If topology is disabled, also mark m4350 as disabled for clarity/consistency
        if (modDisabled.includes("topology")) {
            if (!uiConfig.disabledModules.core.includes("m4350")) {
                uiConfig.disabledModules.core.push("m4350");
            }
            if (!modDisabled.includes("m4350")) {
                modDisabled.push("m4350");
            }
        }
    }
}catch(e){}

try{
    if(settings.hasOwnProperty('server') && settings.server.hasOwnProperty('port')){
        let serverPortTemp = parseInt(settings.server.port);
        if(serverPortTemp > 0 && serverPortTemp < 65536){
            serverPort = serverPortTemp;
        }else{
            throw new Error("Settings server port not a usable number.")
        }
    }else{
        throw new Error("Settings server port not a usable number.")
    }
}catch(e){
    SyncLog.log("error", "Settings", "Can not read Server Port from settings. Default to "+serverPort+".", e);
}

try{
    if(settings.hasOwnProperty('server') && settings.server.hasOwnProperty('address')){
        // NOTE this used to parseInt() the address into an unused variable, so
        // serverAddress was always the 0.0.0.0 default no matter what the
        // settings said. It is a dotted-quad / hostname string, not a number.
        let serverAddressTemp = ("" + settings.server.address).trim();
        if(serverAddressTemp.length > 0){
            serverAddress = serverAddressTemp;
        }else{
            throw new Error("Settings server address is empty.");
        }
    }else{
        throw new Error("Settings server address not a usable.");
    }
}catch(e){
    SyncLog.log("error", "Settings", "Can not read Server Address from settings. Default to "+serverAddress+".", e);
}

WebsocketSyncServer.init();
let server = WebsocketSyncServer.getInstance();
let users:any = null;
try {
    let rawFile = fs.readFileSync("./config/users.json");
    users = JSON.parse(rawFile);
} catch (e) {
    SyncLog.log("error", "Server", "Error while reading file: ./config/users.json", e);
}
if(users){
    server.relaodAuthData(users);
}


// TODO.... load dynamic....
const mediaDevices = new MediaDevices(settings);

// Multicast lease manager. Constructed before the connector so the first
// reconcile after a sender's active params arrive already finds it.
const multicastLeaseManager = new MulticastLeaseManager(settings);

const crosspoint = new CrosspointAbstraction(settings);
const nmosConnector = new NmosRegistryConnector(settings);

// Initialize latency measurement system
const latencyMeasurement = new ConnectionLatencyMeasurement();
SyncLog.info("server", "Connection latency measurement system initialized");

// Initialize Prometheus metrics
const prometheusMetrics = PrometheusMetrics.getInstance();
SyncLog.info("server", "Prometheus metrics system initialized");

// Predictive Stager
let predictiveStager: PredictiveStager | null = null;
try{
    if(settings.predictiveStaging && settings.predictiveStaging.enabled){
        predictiveStager = new PredictiveStager(crosspoint, {
            enabled: true,
            cooldownMs: settings.predictiveStaging.cooldownMs,
            perReceiver: settings.predictiveStaging.perReceiver
        });
        SyncLog.info("server", "PredictiveStager enabled");
    }else{
        SyncLog.info("server", "PredictiveStager disabled");
    }
}catch(e){
    SyncLog.log("error", "server", "Failed to initialize PredictiveStager", e);
}




server.addSyncObject("log","global",log);

server.addSyncObject("nmos","global",nmosConnector.syncNmos);
server.addSyncObject("nmosConnectionState","global",nmosConnector.syncConnectionState);

server.addSyncObject("crosspoint","global",crosspoint.syncCrosspoint);

// The health monitor builds this sync object in its constructor but nothing
// ever registered it, so the UI had no way to subscribe.
server.addSyncObject("nmosHealthStats","global",NmosHealthMonitor.getInstance().getSyncHealthStats());


let topology = null;
if(modDisabled.includes("topology")){
    SyncLog.info("server", "disabling module topology");
}else{
    topology = new Topology();
}


const uiConfigSync: SyncObject = new SyncObject("uiconfig", uiConfig);
server.addSyncObject("uiconfig","public",uiConfigSync);

// ----- Multicast lease inventory -----
// The snapshot is enriched server-side with the sender label and a live status,
// so the client does not have to join two more channels and re-derive this
// table on every patch.
function getMulticastLeaseSnapshot(){
    let leases:any = {};
    try{
        const all = multicastLeaseManager.getAllLeases();
        const activeIps = nmosConnector.getActiveSenderIps("");
        const senders = nmosConnector.getNmosState()?.senders || {};
        for(const senderId in all){
            const l:any = { ...all[senderId], senderId };
            const sender = senders[senderId];
            l.senderLabel = sender?.label || "";
            // "missing" means we hold a lease for a sender the registry no
            // longer knows — usually a device that was replaced.
            // Compare the EFFECTIVE address, not the reserved one. A sender
            // with a manual override is transmitting on the override, so
            // checking primaryIp reported a perfectly healthy sender as
            // inactive.
            const effective = multicastLeaseManager.getEffectiveIp(senderId, 0) || l.primaryIp;
            l.effectiveIp = effective;
            l.liveStatus = !sender ? "missing"
                : (activeIps.has(effective) ? "active" : "inactive");
            leases[senderId] = l;
        }
    }catch(e){}
    return { leases, stats: multicastLeaseManager.getStats(), updatedAt: new Date().toISOString() };
}
const multicastLeasesSync: SyncObject = new SyncObject("multicastLeases", { leases:{}, stats:{}, updatedAt:"" });
server.addSyncObject("multicastLeases","global",multicastLeasesSync);

// Dedupe the publish: the manager fires on every lease touch and a sweep can
// touch many in a row, which would otherwise be a patch storm.
let lastLeaseSnapshotJson = "";
function publishLeaseSnapshotIfChanged(){
    try{
        const snap = getMulticastLeaseSnapshot();
        const j = JSON.stringify({leases:snap.leases, stats:snap.stats});
        if(j === lastLeaseSnapshotJson){ return; }
        lastLeaseSnapshotJson = j;
        multicastLeasesSync.setState(snap);
    }catch(e){}
}
multicastLeaseManager.setOnChange(()=>{ publishLeaseSnapshotIfChanged(); });
multicastLeaseManager.setExternalIpsProvider((excludeSenderId:string)=>{
    try{ return nmosConnector.getActiveSenderIps(excludeSenderId); }catch(e){ return new Set<string>(); }
});
// Live status depends on the wire, not just on lease changes, so refresh on a
// slow timer as well.
setInterval(()=>{ publishLeaseSnapshotIfChanged(); }, 5000);

// Periodic reconcile. Most drift is caught the moment a sender's active params
// are fetched; this covers the rest — a device rebooting back onto a stale
// address, or a sender that went active while the pool was exhausted.
setInterval(()=>{
    try{ nmosConnector.sweepLeases(); }catch(e){}
}, 30000);

server.addRoute("POST", "releaseLease","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        let senderId = nmosIdFromCrosspointId((postData && typeof postData.senderId === "string") ? postData.senderId : "");
        if(!senderId){ reject({message:"missing sender id"}); return; }
        let n = multicastLeaseManager.releaseLeases([senderId]);
        SyncLog.log("info", "Multicast Lease", "Released lease for " + senderId + " by " + client.user + ".");
        resolve({message:200, data:{ released: n }});
    });
});

server.addRoute("POST", "releaseAllLeases","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve) => {
        let ids = Object.keys(multicastLeaseManager.getAllLeases());
        let n = multicastLeaseManager.releaseLeases(ids);
        SyncLog.log("warning", "Multicast Lease", "Released ALL " + n + " lease(s) by " + client.user + ".");
        resolve({message:200, data:{ released: n }});
    });
});

server.addRoute("GET", "exportLeases","global", (client: WebsocketClient, query:string[]) => {
    return new Promise((resolve) => {
        resolve({message:200, data: multicastLeaseManager.exportLeases()});
    });
});

server.addRoute("POST", "importLeases","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        try{
            let r:any = multicastLeaseManager.importLeases(postData);
            SyncLog.log("info", "Multicast Lease", "Imported leases by " + client.user + ".", r);
            resolve({message:200, data:r});
        }catch(e:any){
            reject({message:"import failed: " + (e?.message || e)});
        }
    });
});

// Multicast probe gateway. Registers its own /probe websocket upgrade path, so
// it must come after WebsocketSyncServer.init() — which it does, since the
// sync server is created far above.
const probeGateway = new ProbeGateway(
    (settings.probe && typeof settings.probe.token === "string") ? settings.probe.token : "");
server.addSyncObject("probeState","global",probeGateway.syncProbes);

// Audio monitor. When a probe is connected the monitor uses it, so the
// crosspoint container itself needs no multicast access.
const audioMonitor = new AudioMonitorService();
// Tear a listener's peer connection down the moment its browser tab closes;
// otherwise the producer lingers until werift's DTLS keep-alives time out.
server.onClientDisconnect.push((c: WebsocketClient) => {
    try { audioMonitor.dropWsClient(c).catch(()=>{}); } catch(e) {}
});


// ----- Editable setup config exposed to the UI -----
// This is the single read model behind the Setup page. It deliberately does
// NOT hand out the whole settings object: each field is picked and coerced so
// the UI contract is explicit, and secrets are never included (see the DDNS
// note when that lands — only a "…Set" boolean ever goes out).
//
// Some values can be applied to the running server, others cannot; the ones
// that cannot set restartRequired on the reply so the UI can say so.
let setupRestartRequired = false;
function getSetupConfigState() {
    let registry = { ip: "", port: 80 };
    try {
        if (Array.isArray(settings.staticNmosRegistries) && settings.staticNmosRegistries.length > 0) {
            let r = settings.staticNmosRegistries[0] || {};
            registry.ip = (typeof r.ip === "string") ? r.ip : "";
            let p = parseInt("" + r.port);
            registry.port = (!isNaN(p) && p > 0 && p < 65536) ? p : 80;
        }
    } catch (e) {}

    // Predictive staging is a local feature that until now could only be
    // configured by hand-editing settings.json.
    let ps = (settings.predictiveStaging && typeof settings.predictiveStaging === "object")
        ? settings.predictiveStaging : {};
    let predictiveStaging = {
        enabled: !!ps.enabled,
        cooldownMs: (typeof ps.cooldownMs === "number") ? ps.cooldownMs : 10000
    };

    // Auth snapshot — just the configured usernames so the UI can show the
    // current login in the change-credentials form. The stored password hash
    // is NEVER sent out.
    let authUsers: string[] = [];
    try {
        if (users && users.users && typeof users.users === "object") {
            authUsers = Object.keys(users.users);
        }
    } catch (e) {}

    return {
        registry,
        reconnectOnSdpChanges: !!settings.reconnectOnSdpChanges,
        fixSdpBugs: !!settings.fixSdpBugs,
        autoMulticast: { enabled: !!(settings.autoMulticast && settings.autoMulticast.enabled) },
        // Read-only here: the ranges are an operational decision made in
        // settings.json, and the Setup page shows them so capacity is legible.
        multicastRanges: (settings.multicastRanges && typeof settings.multicastRanges === "object")
            ? JSON.parse(JSON.stringify(settings.multicastRanges)) : {},
        firstDynamicNumber: (typeof settings.firstDynamicNumber === "number") ? settings.firstDynamicNumber : 1000,
        predictiveStaging,
        // Read-only IS-12 status monitoring; absent means on.
        bcp008: { enabled: !(settings.bcp008 && settings.bcp008.enabled === false) },
        audioMonitor: { enabled: !!(settings.audioMonitor && settings.audioMonitor.enabled) },
        vendorProfiles: Array.isArray(settings.vendorProfiles)
            ? settings.vendorProfiles.map((v:any) => ({...v}))
            : [],
        registryDiscovery: {
            unicastDnssd: !(settings.registryDiscovery && settings.registryDiscovery.unicastDnssd === false),
            domain: (settings.registryDiscovery && typeof settings.registryDiscovery.domain === "string") ? settings.registryDiscovery.domain : ""
        },
        debugLogs: !!settings.debugLogs,
        auth: { users: authUsers },
        // Sticky for the lifetime of the process: it means "the running server
        // no longer matches settings.json". An unrelated later save must not
        // clear it, so it is tracked outside this function.
        restartRequired: setupRestartRequired,
        version: CROSSPOINT_VERSION
    };
}
const setupConfigSync: SyncObject = new SyncObject("setupConfig", getSetupConfigState());
// "global", not "public": this snapshot includes the registry address and
// the configured usernames, which unauthenticated clients have no need for.
server.addSyncObject("setupConfig","global",setupConfigSync);

/** Persist the current settings object to ./config/settings.json. */
function persistSettings(){
    let tmp = "./config/settings.json.tmp";
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 4));
    fs.renameSync(tmp, "./config/settings.json");
}

server.addRoute("POST", "setupConfig","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        try{
            if(!postData || typeof postData !== "object"){
                reject({message:"No settings supplied."});
                return;
            }
            // Local to this request, then folded into the sticky flag below.
            let restartRequired = false;

            // --- NMOS registry (first static entry). Needs a restart: the
            // connector builds its registry list once at startup.
            if(postData.hasOwnProperty("registry") && typeof postData.registry === "object" && postData.registry){
                let ip = (typeof postData.registry.ip === "string") ? postData.registry.ip.trim() : "";
                if(ip !== "" && !/^[0-9a-zA-Z.:_-]+$/.test(ip)){
                    reject({message:"Registry address contains invalid characters."});
                    return;
                }
                let port = parseInt("" + postData.registry.port);
                if(isNaN(port) || port < 1 || port > 65535){
                    reject({message:"Registry port must be between 1 and 65535."});
                    return;
                }
                if(!Array.isArray(settings.staticNmosRegistries) || settings.staticNmosRegistries.length === 0){
                    settings.staticNmosRegistries = [{ip:"", port:80, priority:10, domain:""}];
                }
                let cur = settings.staticNmosRegistries[0];
                if(cur.ip !== ip || parseInt("" + cur.port) !== port){
                    restartRequired = true;
                }
                cur.ip = ip;
                cur.port = port;
            }

            // --- Plain booleans read live by the connector / update thread.
            for(const key of ["reconnectOnSdpChanges", "fixSdpBugs"]){
                if(postData.hasOwnProperty(key)){
                    if(typeof postData[key] !== "boolean"){
                        reject({message: key + " must be a boolean."});
                        return;
                    }
                    settings[key] = postData[key];
                }
            }

            // --- Crosspoint numbering. The worker thread reads this at start.
            if(postData.hasOwnProperty("firstDynamicNumber")){
                let n = parseInt("" + postData.firstDynamicNumber);
                if(isNaN(n) || n < 1){
                    reject({message:"First dynamic number must be 1 or greater."});
                    return;
                }
                if(settings.firstDynamicNumber !== n){ restartRequired = true; }
                settings.firstDynamicNumber = n;
            }

            // --- Predictive staging. The stager is constructed at startup, so
            // enabling it from here needs a restart to take effect.
            if(postData.hasOwnProperty("predictiveStaging") && typeof postData.predictiveStaging === "object" && postData.predictiveStaging){
                if(!settings.predictiveStaging || typeof settings.predictiveStaging !== "object"){
                    settings.predictiveStaging = { enabled:false, cooldownMs:10000, perReceiver:{} };
                }
                let target = settings.predictiveStaging;
                if(postData.predictiveStaging.hasOwnProperty("enabled")){
                    if(typeof postData.predictiveStaging.enabled !== "boolean"){
                        reject({message:"predictiveStaging.enabled must be a boolean."});
                        return;
                    }
                    if(target.enabled !== postData.predictiveStaging.enabled){ restartRequired = true; }
                    target.enabled = postData.predictiveStaging.enabled;
                }
                if(postData.predictiveStaging.hasOwnProperty("cooldownMs")){
                    let c = parseInt("" + postData.predictiveStaging.cooldownMs);
                    if(isNaN(c) || c < 0){
                        reject({message:"predictiveStaging.cooldownMs must be 0 or greater."});
                        return;
                    }
                    target.cooldownMs = c;
                }
            }

            // --- BCP-008 master switch. Applies live: the monitor opens or
            // tears down its control connections itself.
            if(postData.hasOwnProperty("bcp008") && typeof postData.bcp008 === "object" && postData.bcp008){
                if(postData.bcp008.hasOwnProperty("enabled")){
                    if(typeof postData.bcp008.enabled !== "boolean"){
                        reject({message:"bcp008.enabled must be a boolean."});
                        return;
                    }
                    if(!settings.bcp008 || typeof settings.bcp008 !== "object"){ settings.bcp008 = { enabled:true }; }
                    settings.bcp008.enabled = postData.bcp008.enabled;
                    try{ Bcp008Monitor.instance?.setEnabled(settings.bcp008.enabled); }catch(e){}
                }
            }

            // --- Registry discovery. The domain list is re-read on the next
            // DNS-SD pass, so both fields apply without a restart.
            if(postData.hasOwnProperty("registryDiscovery") && typeof postData.registryDiscovery === "object" && postData.registryDiscovery){
                if(!settings.registryDiscovery || typeof settings.registryDiscovery !== "object"){
                    settings.registryDiscovery = { unicastDnssd:true, domain:"" };
                }
                if(postData.registryDiscovery.hasOwnProperty("unicastDnssd")){
                    if(typeof postData.registryDiscovery.unicastDnssd !== "boolean"){
                        reject({message:"registryDiscovery.unicastDnssd must be a boolean."});
                        return;
                    }
                    settings.registryDiscovery.unicastDnssd = postData.registryDiscovery.unicastDnssd;
                }
                if(postData.registryDiscovery.hasOwnProperty("domain")){
                    let d = ("" + postData.registryDiscovery.domain).trim();
                    if(d !== "" && !/^[A-Za-z0-9.-]+$/.test(d)){
                        reject({message:"Discovery domain contains invalid characters."});
                        return;
                    }
                    settings.registryDiscovery.domain = d;
                }
            }

            // --- Multicast DHCP master switch. Turning it ON does not
            // immediately repoint anything: the reconcile sweep decides whether
            // to adopt the addresses already on the wire or allocate fresh,
            // based on the adoptExisting flag below.
            if(postData.hasOwnProperty("autoMulticast") && typeof postData.autoMulticast === "object" && postData.autoMulticast){
                if(postData.autoMulticast.hasOwnProperty("enabled")){
                    if(typeof postData.autoMulticast.enabled !== "boolean"){
                        reject({message:"autoMulticast.enabled must be a boolean."});
                        return;
                    }
                    if(!settings.autoMulticast || typeof settings.autoMulticast !== "object"){
                        settings.autoMulticast = { enabled:false };
                    }
                    let wasOn = !!settings.autoMulticast.enabled;
                    settings.autoMulticast.enabled = postData.autoMulticast.enabled;
                    try{ MulticastLeaseManager.instance?.setSettings(settings); }catch(e){}

                    if(!wasOn && settings.autoMulticast.enabled){
                        // First enable: adopt what is already on the wire unless
                        // the operator explicitly asked for fresh addresses.
                        let adopt = postData.autoMulticast.adoptExisting !== false;
                        try{ nmosConnector.seedLeasesFromActive(adopt); }catch(e){}
                    }
                }
            }

            // --- Audio monitor master switch.
            if(postData.hasOwnProperty("audioMonitor") && typeof postData.audioMonitor === "object" && postData.audioMonitor){
                if(postData.audioMonitor.hasOwnProperty("enabled")){
                    if(typeof postData.audioMonitor.enabled !== "boolean"){
                        reject({message:"audioMonitor.enabled must be a boolean."});
                        return;
                    }
                    if(!settings.audioMonitor || typeof settings.audioMonitor !== "object"){ settings.audioMonitor = { enabled:false }; }
                    let wasEnabled = !!settings.audioMonitor.enabled;
                    settings.audioMonitor.enabled = postData.audioMonitor.enabled;
                    if(wasEnabled && !settings.audioMonitor.enabled){
                        // Stop every producer rather than leaving multicast
                        // memberships open after the feature is switched off.
                        try{ audioMonitor.shutdownAll().catch(()=>{}); }catch(e){}
                    }
                }
            }

            // --- Device Web-UI link profiles. Replaced wholesale, then
            // re-normalised by parseSettings so the stored shape is canonical
            // no matter what the client sent.
            if(postData.hasOwnProperty("vendorProfiles")){
                if(!Array.isArray(postData.vendorProfiles)){
                    reject({message:"vendorProfiles must be an array."});
                    return;
                }
                if(postData.vendorProfiles.length > 200){
                    reject({message:"Too many vendor profiles (limit 200)."});
                    return;
                }
                for(const v of postData.vendorProfiles){
                    if(!v || typeof v !== "object"){
                        reject({message:"Each vendor profile must be an object."});
                        return;
                    }
                    let port = parseInt("" + v.port);
                    if(isNaN(port) || port < 1 || port > 65535){
                        reject({message:"Vendor profile port must be between 1 and 65535."});
                        return;
                    }
                    if(v.protocol !== "http" && v.protocol !== "https"){
                        reject({message:"Vendor profile protocol must be http or https."});
                        return;
                    }
                    if(typeof v.path === "string" && /[\s"'<>]/.test(v.path)){
                        reject({message:"Vendor profile path contains invalid characters."});
                        return;
                    }
                }
                settings.vendorProfiles = postData.vendorProfiles;
                // Re-run the normaliser over just this key.
                settings = parseSettings(settings);
                // Device links are computed during enrichment, so without a
                // republish they stay stale until an unrelated device event.
                try{ crosspoint.republishForSettingsChange(); }catch(e){}
            }

            // --- Debug logging applies immediately.
            if(postData.hasOwnProperty("debugLogs")){
                if(typeof postData.debugLogs !== "boolean"){
                    reject({message:"debugLogs must be a boolean."});
                    return;
                }
                settings.debugLogs = postData.debugLogs;
                try{ SyncLog.setDebugEnabled(settings.debugLogs); }catch(e){}
            }

            try{
                persistSettings();
            }catch(e:any){
                SyncLog.log("error", "Settings", "Failed to write ./config/settings.json", e);
                reject({message:"Could not write settings.json: " + (e?.message || e)});
                return;
            }

            if(restartRequired){ setupRestartRequired = true; }
            setupConfigSync.setState(getSetupConfigState());
            SyncLog.log("info", "Settings", "Setup config updated by " + client.user + ".");
            resolve({message:200, data:{ ok:true, restartRequired: setupRestartRequired }});
        }catch(e:any){
            reject({message:"setupConfig failed: " + (e?.message || e)});
        }
    });
});

// ----- Change admin credentials -----
// The auth model stores sha256(plaintextPassword) in users.json, and the
// browser only ever knows that hash too — the plaintext never crosses the
// wire. So this route takes hashes on both sides. A caller may only edit the
// account they are authenticated as. After a rename the client is logged out,
// because its stored hash no longer matches the new username.
server.addRoute("POST", "changeCredentials","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        try{
            if(!client || !client.user || client.user === "__noAuth"){
                reject({message:"Not authenticated."});
                return;
            }
            let curUser = (postData && typeof postData.currentUsername === "string") ? postData.currentUsername.trim() : "";
            let curHash = (postData && typeof postData.currentPasswordHash === "string") ? postData.currentPasswordHash.trim().toLowerCase() : "";
            let newUser = (postData && typeof postData.newUsername === "string") ? postData.newUsername.trim() : "";
            let newHash = (postData && typeof postData.newPasswordHash === "string") ? postData.newPasswordHash.trim().toLowerCase() : "";

            if(!curUser){ reject({message:"Current username is required."}); return; }
            if(curUser !== client.user){
                reject({message:"You can only change the credentials of your own account."});
                return;
            }
            if(!users || !users.users || typeof users.users !== "object" || !users.users[curUser]){
                reject({message:"User not found."});
                return;
            }
            let stored = users.users[curUser];
            let storedPass = (typeof stored.password === "string") ? stored.password.toLowerCase() : "";
            if(!storedPass || storedPass !== curHash){
                reject({message:"Current password is wrong."});
                return;
            }
            if(newUser && newUser !== curUser){
                if(!/^[A-Za-z0-9_.-]{1,64}$/.test(newUser)){
                    reject({message:"New username must be 1-64 characters: letters, digits, _ . -"});
                    return;
                }
                if(users.users.hasOwnProperty(newUser)){
                    reject({message:"That username already exists."});
                    return;
                }
            }
            if(newHash && !/^[a-f0-9]{64}$/.test(newHash)){
                reject({message:"New password hash malformed."});
                return;
            }
            let finalUser = (newUser && newUser !== curUser) ? newUser : curUser;
            if(finalUser !== curUser){
                users.users[finalUser] = { ...stored };
                delete users.users[curUser];
            }
            if(newHash){
                users.users[finalUser].password = newHash;
            }
            try{
                let tmp = "./config/users.json.tmp";
                fs.writeFileSync(tmp, JSON.stringify(users, null, 4));
                fs.renameSync(tmp, "./config/users.json");
                SyncLog.log("info", "Settings", "Updated ./config/users.json (credentials change for " + curUser + (finalUser !== curUser ? " -> " + finalUser : "") + ").");
            }catch(e:any){
                SyncLog.log("error", "Settings", "Failed to write ./config/users.json", e);
                reject({message:"Could not write users.json: " + (e?.message || e)});
                return;
            }
            // Hot-reload the in-memory auth table so the next auth attempt is
            // checked against the new data.
            try{ server.relaodAuthData(users); }catch(e){}
            try{ setupConfigSync.setState(getSetupConfigState()); }catch(e){}

            resolve({message:200, data:{ ok:true, username: finalUser, passwordChanged: !!newHash }});
        }catch(e:any){
            reject({message:"changeCredentials failed: " + (e?.message || e)});
        }
    });
});

// Initialize Matrox CIP authentication helper (must be done after MediaDevices initialization)
MatroxAuthHelper.initializeAuthHelper();

// Add Prometheus metrics HTTP endpoint
server.addExpressMiddleware('/api/metrics', async (req, res) => {
    try {
        const metrics = await prometheusMetrics.getMetrics();
        res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        res.send(metrics);
    } catch (error) {
        res.status(500).send(`Error getting metrics: ${error}`);
    }
});

// Register SPA catch-all route after all middleware
server.registerSpaRoute();

// Start the server after all routes are registered
server.startServer(serverAddress, serverPort);





// Raw + parsed SDP for a single sender. Fetched on demand rather than read out
// of the broadcast `nmos` channel, so the UI's SDP viewer and the audio monitor
// do not depend on the whole manifest set being pushed to every client.
server.addRoute("GET", "senderSdp","global", (client: WebsocketClient, query:string[]) => {
    return new Promise((resolve, reject) => {
        // Accept either the bare IS-04 UUID or a crosspoint-namespaced id, so
        // the UI can pass the flow id it already has.
        let senderId = nmosIdFromCrosspointId(query[0] || "");
        if(!senderId){
            reject({message:"missing sender id"});
            return;
        }
        let sdp = nmosConnector.getSenderSdp(senderId);
        if(sdp && sdp.raw){
            resolve({message:200, data:sdp});
        }else{
            reject({message:"no SDP known for this sender"});
        }
    });
});

// ----- Audio monitor -----
// WebRTC signalling for listening in on an audio sender. The SDP comes from the
// server's own manifest cache rather than the client, so a client cannot point
// the server at an arbitrary multicast group.
function audioMonitorGuard(reject: (m: any) => void): boolean {
    if (!(settings.audioMonitor && settings.audioMonitor.enabled)) {
        reject({message:"The audio monitor is disabled in Setup."});
        return false;
    }
    return true;
}

server.addRoute("POST", "audioMonitorSubscribe","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        if(!audioMonitorGuard(reject)){ return; }
        let senderId = nmosIdFromCrosspointId((postData && typeof postData.senderId === "string") ? postData.senderId : "");
        let listenerId = (postData && typeof postData.listenerId === "string") ? postData.listenerId : "";
        if(!senderId || !listenerId){ reject({message:"missing sender or listener id"}); return; }

        let sdp = nmosConnector.getSenderSdp(senderId);
        if(!sdp || !sdp.raw){ reject({message:"no SDP known for this sender"}); return; }

        let channels: [number, number] | undefined = undefined;
        if(Array.isArray(postData.channels) && postData.channels.length === 2){
            let a = parseInt("" + postData.channels[0]);
            let b = parseInt("" + postData.channels[1]);
            if(!isNaN(a) && !isNaN(b) && a >= 0 && b >= 0){ channels = [a, b]; }
        }

        audioMonitor.subscribe({ senderId, listenerId, sdp: sdp.raw, channels })
            .then((r:any)=>{
                if(r && r.ok){
                    // Remember which WS client owns this listener, so the
                    // disconnect hook can tear it down immediately.
                    audioMonitor.registerListenerForClient(client, listenerId);
                    resolve({message:200, data:{ offer: r.offer }});
                }else{
                    reject({message:(r && r.error) || "could not start the audio monitor"});
                }
            })
            .catch((e:any)=>reject({message:"audio monitor failed: " + (e?.message || e)}));
    });
});

server.addRoute("POST", "audioMonitorAnswer","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        if(!audioMonitorGuard(reject)){ return; }
        let listenerId = (postData && typeof postData.listenerId === "string") ? postData.listenerId : "";
        if(!listenerId || !postData.answer){ reject({message:"missing listener id or answer"}); return; }
        audioMonitor.answer(listenerId, postData.answer)
            .then((r:any)=>{ r && r.ok ? resolve({message:200, data:{ok:true}}) : reject({message:(r && r.error) || "answer rejected"}); })
            .catch((e:any)=>reject({message:"answer failed: " + (e?.message || e)}));
    });
});

server.addRoute("POST", "audioMonitorIce","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        if(!audioMonitorGuard(reject)){ return; }
        let listenerId = (postData && typeof postData.listenerId === "string") ? postData.listenerId : "";
        if(!listenerId || !postData.candidate){ reject({message:"missing listener id or candidate"}); return; }
        audioMonitor.ice(listenerId, postData.candidate)
            .then(()=>resolve({message:200, data:{ok:true}}))
            .catch((e:any)=>reject({message:"ice failed: " + (e?.message || e)}));
    });
});

server.addRoute("POST", "audioMonitorSetChannels","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        if(!audioMonitorGuard(reject)){ return; }
        let listenerId = (postData && typeof postData.listenerId === "string") ? postData.listenerId : "";
        if(!listenerId || !Array.isArray(postData.channels) || postData.channels.length !== 2){
            reject({message:"missing listener id or channel pair"});
            return;
        }
        let a = parseInt("" + postData.channels[0]);
        let b = parseInt("" + postData.channels[1]);
        if(isNaN(a) || isNaN(b) || a < 0 || b < 0){ reject({message:"invalid channel pair"}); return; }
        if(audioMonitor.setChannels(listenerId, [a, b])){
            resolve({message:200, data:{ok:true}});
        }else{
            reject({message:"no such listener"});
        }
    });
});

server.addRoute("POST", "audioMonitorUnsubscribe","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        let listenerId = (postData && typeof postData.listenerId === "string") ? postData.listenerId : "";
        if(!listenerId){ reject({message:"missing listener id"}); return; }
        audioMonitor.unsubscribe(listenerId)
            .then(()=>resolve({message:200, data:{ok:true}}))
            .catch(()=>resolve({message:200, data:{ok:true}}));
    });
});

// BCP-008 packet counters for one flow, fetched live over IS-12 rather than
// streamed, because they are only wanted while the status panel is open.
server.addRoute("POST", "bcp008Counters","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        // The UI sends the crosspoint flow id ("nmos_<uuid>"); the monitor keys
        // everything by the bare IS-04 UUID from the device's touchpoints.
        let flowId = nmosIdFromCrosspointId((postData && typeof postData.flowId === "string") ? postData.flowId : "");
        if(!flowId){ reject({message:"missing flow id"}); return; }
        if(!Bcp008Monitor.instance){ reject({message:"BCP-008 monitoring is not running"}); return; }
        Bcp008Monitor.instance.getPacketCounters(flowId).then((counters)=>{
            if(counters){
                resolve({message:200, data:{ counters }});
            }else{
                reject({message:"no monitor for this flow"});
            }
        }).catch((e)=>reject({message:"counter read failed: " + (e?.message || e)}));
    });
});

server.addRoute("POST", "bcp008Reset","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        let flowId = nmosIdFromCrosspointId((postData && typeof postData.flowId === "string") ? postData.flowId : "");
        if(!flowId){ reject({message:"missing flow id"}); return; }
        if(!Bcp008Monitor.instance){ reject({message:"BCP-008 monitoring is not running"}); return; }
        Bcp008Monitor.instance.resetCounters(flowId).then((ok)=>{
            if(ok){
                SyncLog.log("info", "BCP-008", "Counters reset for flow " + flowId + " by " + client.user + ".");
                resolve({message:200, data:{ ok:true }});
            }else{
                reject({message:"no monitor for this flow"});
            }
        }).catch((e)=>reject({message:"counter reset failed: " + (e?.message || e)}));
    });
});

server.addRoute("GET", "flowInfo","global" , (client: WebsocketClient, query:string[]) => {
    return new Promise((resolve, reject) => {
        let flowId = query[0];
        if(flowId){
            let flow = crosspoint.getFlowInfo(flowId);
            if(flow){
                resolve({message:200, data:flow});
            }else{
                reject("flow not found");
            }
        }else{
            reject("missing flow Id");
        }
        
    });
});

server.addRoute("POST", "makeconnection","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        // Debug logging for route handler
        console.log("[DEBUG] makeconnection route handler called with:", JSON.stringify(postData, null, 2));
        console.log("[DEBUG] crosspoint object exists:", !!crosspoint);
        console.log("[DEBUG] crosspoint.makeConnection exists:", !!(crosspoint && crosspoint.makeConnection));
        
        crosspoint
            .makeConnection(postData)
            .then((data) => resolve({message:200, data:data}))
            .catch((m) => reject(m));
    });
});

server.addRoute("POST", "changealias","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        crosspoint
            .changeAlias(postData.id, postData.alias)
            .then((m) => resolve(m))
            .catch((m) => reject(m));
    });
});

server.addRoute("POST", "enableFlow","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        crosspoint
            .enableFlow(postData.id, false)
            .then((m) => resolve(m))
            .catch((m) => reject(m));
    });
});

server.addRoute("POST", "disableFlow","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        crosspoint
            .enableFlow(postData.id, true)
            .then((m) => resolve(m))
            .catch((m) => reject(m));
    });
});


server.addRoute("POST", "setMulticast","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        crosspoint
            .setMulticast(postData.id, postData.data)
            .then((m) => resolve(m))
            .catch((m) => reject(m));
    });
});





server.addRoute("POST", "togglehidden","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        crosspoint
            .toggleHidden(postData.id)
            .then((m) => resolve(m))
            .catch((m) => reject(m));
    });
});



// Crosspoint editor
server.addRoute("POST", "crosspoint","global", (client: WebsocketClient, query:string[], postData: any) => {
    return new Promise((resolve, reject) => {
        crosspoint
            .crosspointApi(postData)
            .then((m) => resolve(m))
            .catch((m) => reject(m));
    });
});



