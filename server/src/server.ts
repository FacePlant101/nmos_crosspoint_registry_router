/* 
    NMOS Crosspoint
    Copyright (C) 2021 Johannes Grieb
*/


const fs = require("fs");

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

let settings: any = {};
try {
    let rawFile = fs.readFileSync("./config/settings.json");
    let tempSettings = JSON.parse(rawFile);
    settings = parseSettings(tempSettings);
} catch (e) {
    SyncLog.log("error", "Settings", "Error while reading file: ./config/settings.json", e);
    SyncLog.log("error", "Settings", "Can not run without Configuration...");
    process.exit();
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



