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
        autoMulticast: !!settings.autoMulticast,
        firstDynamicNumber: (typeof settings.firstDynamicNumber === "number") ? settings.firstDynamicNumber : 1000,
        predictiveStaging,
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
            for(const key of ["reconnectOnSdpChanges", "fixSdpBugs", "autoMulticast"]){
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
        let senderId = query[0];
        if(!senderId){
            reject("missing sender id");
            return;
        }
        let sdp = nmosConnector.getSenderSdp(senderId);
        if(sdp && sdp.raw){
            resolve({message:200, data:sdp});
        }else{
            reject("no SDP known for this sender");
        }
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



