import { SyncObject } from "../lib/SyncServer/syncObject";
import { SyncLog } from "../lib/syncLog";

import { NmosRegistryConnector } from "../lib/nmosConnector";
import { findMatroxDeviceKey, matroxSerialFromNodeId } from "../lib/matroxDeviceMatch";
import axios, { isAxiosError } from "axios";
import { writeFileSync } from "fs";

import { applyPatch, createPatch } from "rfc6902";
import { WebsocketClient } from "../lib/SyncServer/websocketClient";
import { WebsocketSyncServer } from "../lib/SyncServer/websocketSyncServer";
import { BehaviorSubject, Subject } from "rxjs";
import { MdnsService } from "../lib/mdnsService";

import { setTimeout as sleep } from 'node:timers/promises'


const fs = require("fs");
const FormData = require('form-data');
const https = require("https");

interface MatroxConvertIpInterface {
    name:string;
    up:boolean;
    ip:string;
    speed:string;
}



class MatroxCipDevice {
    sn:string = "";
    name:string = ""
    
    ipList:string[] = [];
    firmwareMode:string="";
    firmwareVersion:string="";

    type:string = "";
    hasEdid:boolean = false;

    safeMode:boolean = false
    goldenMode:boolean = false

    temperature:string = ""

    direction = ""

    simpleMode = "";

    edidMonitor = ""
    edidNativeResMonitor = ""
    edidInput = ""
    edidNativeResInput = ""



    moinitorMode:"edidpreference"|"stream"|"force"|"" = "";
    monitorResolution:string = "";

    signalPresent = false
    signalResolution = "";

    inputResolution:string = "";
    inputPresent = false;
    inputCompression:"JPEG-XS"|"RAW" = "RAW";
    inputBitrate = 0;
    inputAudio = ""
    inputAudioPresent
    inputNoSignal = ""
    inputSync = ""

    outputMode:"input"|"force"|"" = ""
    outputResolution:string = "";
    outputPresent = false;
    outputBitrate = 0
    outputCompression:"Colibri"|"JPEG-XS"|"RAW" = "RAW";


    masterEnabled = false
    
    linkStatus:MatroxConvertIpInterface[] = [];
    

    frontpanelLock:boolean= false;
    hdcpEnabled:boolean = true;
    jpegxsLicensed:boolean = false;
    ptpStatus:string = "";
    ptpEnabled:boolean = true;
    ptpDomain:string|number = "";

    // IGMP version control
    igmpVersion: "none" | "v2" | "v3" = "none";

    flowMode:string = "mixed";

    // Multiviewer state
    isMultiviewEnabled:boolean = false;

    // Audio stream states
    txAudioStream0Enabled:boolean = false;
    rxAudioStream0Enabled:boolean = false;

    time:number = 0
    
    loading:boolean = false
    outdated:boolean = false

    failed:boolean = false
    error:string = ""
    sessionConflict = false
    unreachable = false



    
}


export default class MediaDevMatroxConvertIp {

    private simultanLoading = 0;

    public static instance: MediaDevMatroxConvertIp | null;

    public syncList: SyncObject;

    public quickState:Subject<any>


    private lastNodeState:any = {};

    private dedupReloadCooldownMs = 10000;
    private lastDedupReloadAt: Record<string, number> = {};
    private lastDedupFingerprint: Record<string, string> = {};

    
    private authState ={};

    config = {
        "user":"admin",
        "password":"password",
        "closeExistingSessions":true,
        "ignoreHttps":true,
        "edids":[{
            "name":"1080p50",
            "file":"./config/edid/1080p50.bin"
        },{
            "name":"2160p50",
            "file":"./config/edid/2160p50.bin"
        }],
        resolutions:[],
        "manualDevices":[],
        "autoConfigNmosRegistry": {
            "enabled": false,
            "configureOnDiscovery": true,
            "retryOnFailure": true,
            "retryDelayMs": 30000
        },
        "disableAutoReauth": false
    }

    private settings: any;

    // Helper methods to get registry information from settings.json
    private getPrimaryRegistry() {
        if (!this.settings?.staticNmosRegistries?.length) {
            return null;
        }
        // Get the registry with highest priority (lowest number)
        return this.settings.staticNmosRegistries.reduce((highest, current) =>
            (current.priority < highest.priority) ? current : highest
        );
    }

    private getRegistryIp(): string {
        const registry = this.getPrimaryRegistry();
        return registry?.ip || "";
    }

    private getRegistryPort(): number {
        const registry = this.getPrimaryRegistry();
        return registry?.port || 3210;
    }

    private getRegistryApiVersion(): string {
        // Use the first supported version from settings
        return this.settings?.nmos?.registryVersions?.[0] || "v1.3";
    }

    private isAutoConfigEnabled(): boolean {
        return this.config.autoConfigNmosRegistry.enabled && !!this.getRegistryIp();
    }

    httpsAgent:any = null
    ptpDomain = 127;
    quickStateInternal = {
        label:"Matrox Convert IP",
        name:"matroxcip",
        count:0,
        error:0,
        detail: [
            {label:"Connected", color: "success", count:0 },
            {label:"Session Conflict", color: "warning", count:0 },
            {label:"Unreachable", color: "error", count:0 },
        ],
        note:""
    }
    private state:any = {
        devices:{},
        quickState:this.quickStateInternal,
        settings:{
            edids:[],
            resolutions:[]
        },
        ptpDomain:this.ptpDomain
        
    }

    
    
    constructor(settings:any){
        this.settings = settings;
        this.ptpDomain = settings.ptp.domain;
        this.quickState = new BehaviorSubject<any>(this.quickStateInternal);
        
        try{
            if (!fs.existsSync("./state/mediadev_matroxcip")) {
                fs.mkdirSync("./state/mediadev_matroxcip", { recursive: true });
            }
        }catch(e){
            SyncLog.log("error", "MatroxCIP", "Error:", e.message);
        }

        try {
            let rawFile = fs.readFileSync("./config/mediadev_matroxcip/matroxcip.json");
            let top = JSON.parse(rawFile);
            this.config = top;
            
            // Initialize autoConfigNmosRegistry if not present in loaded config
            if (!this.config.autoConfigNmosRegistry) {
                this.config.autoConfigNmosRegistry = {
                    enabled: false,
                    configureOnDiscovery: true,
                    retryOnFailure: true,
                    retryDelayMs: 30000
                };
            }
        } catch (e) {
            console.error("Error reading from file: ./config/mediadev_matroxcip/matroxcip.json");
            // File load failed, config will remain as the default structure already defined above
            // Ensure autoConfigNmosRegistry exists in the default config
            if (!this.config.autoConfigNmosRegistry) {
                this.config.autoConfigNmosRegistry = {
                    enabled: false,
                    configureOnDiscovery: true,
                    retryOnFailure: true,
                    retryDelayMs: 30000
                };
            }
        }

        // TODO Config of https ignore SSL cert error
        this.httpsAgent = new https.Agent({  
            rejectUnauthorized: !this.config.ignoreHttps,
            keepAlive: true
        });


        if(process.env.MATROX_CIP_USER)
        {
            this.config.user = process.env.MATROX_CIP_USER;
            SyncLog.log("info", "matroxcip", "Using username from environment variable MATROX_CIP_USER");
        }

        if(process.env.MATROX_CIP_PASSWORD)
        {
            this.config.password = process.env.MATROX_CIP_PASSWORD;
            SyncLog.log("info", "matroxcip", "Using password from environment variable MATROX_CIP_PASSWORD");
        }


        


        try {
            let rawFile = fs.readFileSync("./state/mediadev_matroxcip/matroxcipstate.json");
            let top = JSON.parse(rawFile);
            this.state = top;
        } catch (e) {
            console.warn("Error reading from file: ./state/mediadev_matroxcip/matroxcipstate.json");
            console.warn("File will be created on first use.");
        }

        try {
            let rawFile = fs.readFileSync("./state/mediadev_matroxcip/matroxcipstateauth.json");
            let top = JSON.parse(rawFile);
            this.authState = top;
        } catch (e) {
            console.warn("Error reading from file: ./state/mediadev_matroxcip/matroxcipstateauth.json");
            console.warn("File will be created on first use.");
        }

        this.state.settings.edids = this.config.edids;
        this.state.settings.resolutions = this.config.resolutions;
        this.state.ptpDomain = this.ptpDomain;


        if(MediaDevMatroxConvertIp.instance == null){
            MediaDevMatroxConvertIp.instance = this;
        }

        for(let device of Object.values(this.state.devices)){
            let dev = (device as any)
            dev.loading = false
            
            dev.loaded = false;
            dev.failed = true
            dev.error = "Device not refreshed"
            dev.sessionConflict = false
            dev.unreachable = 0;

            // Config Upgrades
            dev.linkStatus = [];

        }

        // Config Upgrades
        if(this.state.hasOwnProperty("auth")){
            delete this.state.auth
        }

        this.quickStateInternal.note = "Initial Loading..."
        this.state["quickState"] = this.quickStateInternal;



        



        

        this.config.manualDevices.forEach((dev)=>{
            if(dev.hasOwnProperty('ipList') && dev.hasOwnProperty('sn')){
                if(!this.state.devices.hasOwnProperty(dev.sn)){
                    let cip:MatroxCipDevice = new MatroxCipDevice();
                    cip.sn = dev.sn;
                    cip.ipList = dev.ipList;
                    this.state.devices[dev.sn] = cip;
                    SyncLog.log("info", "matroxcip", "Adding Manual Device:"+ dev.sn)
                }
            }
        })

        this.syncList = new SyncObject("mediadevmatroxcip");
        this.syncList.setState(this.state);
        let server = WebsocketSyncServer.getInstance();
        server.addSyncObject("mediadevmatroxcip","global",this.syncList);

        this.updateQuickState();

        server.addRoute("GET", "matroxcip_forcereload","global", (client: WebsocketClient, query:string[]) => {
            return new Promise((resolve, reject) => {
                let sn = query[0];
                if(sn){
                    this.forceReloadData(sn);
                    resolve({});
                }else{
                    reject({status:403, message:"Missing SN"});
                }
                
            });
        });

        server.addRoute("GET", "matroxcip_forcereloadall","global", (client: WebsocketClient, query:string[]) => {
            return new Promise((resolve, reject) => {
                this.reloadAll(true);
            });
        });

        server.addRoute("POST", "matroxcip_fixptpdomain","global", (client: WebsocketClient, query:string[], postData: any) => {
            return new Promise((resolve, reject) => {
                this.fixPtpDomain(postData.sn).then(()=>{
                    resolve({});    
                }).catch((e)=>{
                    reject({status:400, message:e.message});
                })
                
            });
        });

        server.addRoute("POST", "matroxcip_toggleptp","global", (client: WebsocketClient, query:string[], postData: any) => {
            return new Promise((resolve, reject) => {
                this.togglePtp(postData.sn, postData.enabled).then(()=>{
                    resolve({});    
                }).catch((e)=>{
                    reject({status:400, message:e.message});
                })
                
            });
        });

        server.addRoute("POST", "matroxcip_toggleaudio","global", (client: WebsocketClient, query:string[], postData: any) => {
            return new Promise((resolve, reject) => {
                this.toggleAudioStream(postData.sn, postData.streamType, postData.streamIndex, postData.enabled).then(()=>{
                    resolve({});    
                }).catch((e)=>{
                    reject({status:400, message:e.message});
                })
                
            });
        });

        server.addRoute("POST", "matroxcip_setigmp","global", (client: WebsocketClient, query:string[], postData: any) => {
            return new Promise((resolve, reject) => {
                this.setIgmpVersion(postData.sn, postData.version).then(()=>{
                    resolve({});    
                }).catch((e)=>{
                    reject({status:400, message:e.message});
                })
            });
        });

        server.addRoute("POST", "matroxcip_togglemultiviewer","global", (client: WebsocketClient, query:string[], postData: any) => {
            return new Promise((resolve, reject) => {
                this.toggleMultiviewer(postData.sn, postData.enabled).then(()=>{
                    resolve({});    
                }).catch((e)=>{
                    reject({status:400, message:e.message});
                })
                
            });
        });

        server.addRoute("GET", "matroxcip_ptpenableall","global", (client: WebsocketClient, query:string[]) => {
            return new Promise((resolve, reject) => {
                this.ptpEnableAll().then(()=>{
                    resolve({});    
                }).catch((e)=>{
                    reject({status:400, message:e.message});
                })
            });
        });

        server.addRoute("GET", "matroxcip_ptpdisableall","global", (client: WebsocketClient, query:string[]) => {
            return new Promise((resolve, reject) => {
                this.ptpDisableAll().then(()=>{
                    resolve({});    
                }).catch((e)=>{
                    reject({status:400, message:e.message});
                })
            });
        });

        server.addRoute("POST", "matroxcip_setigmpall","global", (client: WebsocketClient, query:string[], postData: any) => {
            return new Promise((resolve, reject) => {
                this.setIgmpVersionAll(postData.version).then(()=>{
                    resolve({});    
                }).catch((e)=>{
                    reject({status:400, message:e.message});
                })
            });
        });

        server.addRoute("POST", "matroxcip_restart","global", (client: WebsocketClient, query:string[], postData: any) => {
            return new Promise((resolve, reject) => {
                this.restartDevice(postData.sn).then(()=>{
                    resolve({});    
                }).catch((e)=>{
                    reject({status:400, message:e.message});
                })
            });
        });

        server.addRoute("GET", "matroxcip_restartall","global", (client: WebsocketClient, query:string[]) => {
            return new Promise((resolve, reject) => {
                this.restartAll().then(()=>{
                    resolve({});    
                }).catch((e)=>{
                    reject({status:400, message:e.message});
                })
            });
        });

        server.addRoute("POST", "matroxcip_batchjob","global", (client: WebsocketClient, query:string[], postData: any) => {
            return new Promise((resolve, reject) => {
                let reboot = false;
                if(postData.hasOwnProperty('reboot')){
                    if(postData.reboot === true){
                        reboot = true;
                    }
                }
                this.batchJob(postData.sn,postData.context, reboot).then(()=>{
                    resolve({});    
                }).catch((e)=>{
                    reject({status:400, message:e.message});
                })
                
            });
        });

        server.addRoute("POST", "matroxcip_changeedid","global", (client: WebsocketClient, query:string[], postData: any) => {
            return new Promise((resolve, reject) => {
                this.changeEdid(postData.sn,postData.name).then(()=>{
                    resolve({});    
                }).catch((e)=>{
                    reject({status:400, message:e.message});
                })
                
            });
        });
        
        server.addRoute("POST", "matroxcip_enablemaster","global", (client: WebsocketClient, query:string[], postData: any) => {
            return new Promise((resolve, reject) => {
                this.masterEnable(postData.sn).then(()=>{
                    resolve({});    
                }).catch((e)=>{
                    reject({status:400, message:e.message});
                })
            });
        });
        server.addRoute("POST", "matroxcip_changeresolution","global", (client: WebsocketClient, query:string[], postData: any) => {
            return new Promise((resolve, reject) => {
                this.changeResolution(postData.sn,postData.name).then(()=>{
                    resolve({});
                    
                }).catch((e)=>{
                    reject({status:400, message:e.message});
                })
            });
        });

        server.addRoute("POST", "matroxcip_deletedevice","global", (client: WebsocketClient, query:string[], postData: any) => {
            return new Promise((resolve, reject) => {
                this.deleteDevice(postData.sn).then(()=>{
                    resolve({});    
                }).catch((e)=>{
                    reject({status:400, message:e.message});
                })
            });
        });

        server.addRoute("POST", "matroxcip_setnmosregistry","global", (client: WebsocketClient, query:string[], postData: any) => {
            return new Promise((resolve, reject) => {
                this.setNmosRegistry(postData.sn, postData.ip, postData.port, postData.apiVersion).then(()=>{
                    resolve({message: "NMOS registry configured successfully"});    
                }).catch((e)=>{
                    reject({status:400, message:e.message});
                })
            });
        });

        server.addRoute("POST", "matroxcip_autonmosregistry","global", (client: WebsocketClient, query:string[], postData: any) => {
            return new Promise((resolve, reject) => {
                this.configureAutoNmosRegistry(postData.enabled).then(()=>{
                    resolve({message: "Auto NMOS registry configuration updated successfully"});    
                }).catch((e)=>{
                    reject({status:400, message:e.message});
                });
            });
        });

        server.addRoute("POST", "matroxcip_toggleautoreauth","global", (client: WebsocketClient, query:string[], postData: any) => {
            return new Promise((resolve, reject) => {
                this.toggleAutoReauth(postData.enabled).then(()=>{
                    resolve({message: "Auto-reauthentication setting updated successfully"});    
                }).catch((e)=>{
                    reject({status:400, message:e.message});
                });
            });
        });

        server.addRoute("GET", "matroxcip_bulknmosregistry","global", (client: WebsocketClient, query:string[]) => {
            return new Promise((resolve, reject) => {
                this.bulkConfigureNmosRegistry().then((results)=>{
                    resolve({message: "Bulk NMOS registry configuration completed", results});    
                }).catch((e)=>{
                    reject({status:400, message:e.message});
                })
            });
        });

        

        NmosRegistryConnector.registerHook("nodes", (id,data)=>{this.nodeChange(id,data)})
        NmosRegistryConnector.registerHook("flows", (id,data)=>{this.flowChange(id,data)})

        NmosRegistryConnector.registerModifier("receivers", (id,data)=>{
            try{
                let idpart = id.split("-");
                if(idpart[idpart.length-1].endsWith("0000000000")){
                    // Fix changing Group Hints in Matrox
                    data.tags["urn:x-nmos:tag:grouphint/v1.0"][0] = data.tags["urn:x-nmos:tag:grouphint/v1.0"][0].replace(" 0:Video", ":Video");
                    data.tags["urn:x-nmos:tag:grouphint/v1.0"][0] = data.tags["urn:x-nmos:tag:grouphint/v1.0"][0].replace(" 1:Video", ":Video");
                    data.tags["urn:x-nmos:tag:grouphint/v1.0"][0] = data.tags["urn:x-nmos:tag:grouphint/v1.0"][0].replace(" 0:Audio", ":Audio");
                    data.tags["urn:x-nmos:tag:grouphint/v1.0"][0] = data.tags["urn:x-nmos:tag:grouphint/v1.0"][0].replace(" 1:Audio", ":Audio");
                    //if(data.tags["urn:x-nmos:tag:grouphint/v1.0"][0] == "IP IN 0:Video"){
                    //    data.tags["urn:x-nmos:tag:grouphint/v1.0"][0] = "IP IN:Video";
                    //    SyncLog.log("info", "MatroxCIP", "Modifying: "+data.id)
                    //}
                    //if(data.tags["urn:x-nmos:tag:grouphint/v1.0"][0] == "IP IN 1:Audio"){
                    //    data.tags["urn:x-nmos:tag:grouphint/v1.0"][0] = "IP IN:Audio";
                    //    SyncLog.log("info", "MatroxCIP", "Modifying: "+data.id)
                    //}
                }
            }catch(e){}
            return data;
        })
        NmosRegistryConnector.registerModifier("senders", (id,data)=>{
            try{
                let idpart = id.split("-");
                if(idpart[idpart.length-1].endsWith("0000000000")){
                    // Fix changing Group Hints in Matrox
                    data.tags["urn:x-nmos:tag:grouphint/v1.0"][0] = data.tags["urn:x-nmos:tag:grouphint/v1.0"][0].replace(" 0:Video", ":Video");
                    data.tags["urn:x-nmos:tag:grouphint/v1.0"][0] = data.tags["urn:x-nmos:tag:grouphint/v1.0"][0].replace(" 1:Video", ":Video");
                    data.tags["urn:x-nmos:tag:grouphint/v1.0"][0] = data.tags["urn:x-nmos:tag:grouphint/v1.0"][0].replace(" 0:Audio", ":Audio");
                    data.tags["urn:x-nmos:tag:grouphint/v1.0"][0] = data.tags["urn:x-nmos:tag:grouphint/v1.0"][0].replace(" 1:Audio", ":Audio");
                    //if(data.tags["urn:x-nmos:tag:grouphint/v1.0"][0] ==  "IP OUT 0:Video"){
                    //    data.tags["urn:x-nmos:tag:grouphint/v1.0"][0] = "IP OUT:Video";
                    //    SyncLog.log("info", "MatroxCIP", "Modifying: "+data.id)
                    //}
                    //if(data.tags["urn:x-nmos:tag:grouphint/v1.0"][0] == "IP OUT 1:Audio"){
                    //    data.tags["urn:x-nmos:tag:grouphint/v1.0"][0] = "IP OUT:Audio";
                    //    SyncLog.log("info", "MatroxCIP", "Modifying: "+data.id)
                    //}
                }
            }catch(e){}
            return data;
        });

        

        MdnsService.registerHook((response) => {
            try{
                response.answers.forEach((answer) => {
                    if (answer.name == "_matrox-service-api._tcp.local") {
                        response.additionals.forEach((element) => {
                            if (element.type == "A") {
                                let d = answer.data.split(".");
                                let detail = d[0].split("-");
                                if(detail[0] == "MTXCIP"){
                                    let sn = detail[1].toLowerCase();
                                    if(!this.state.devices.hasOwnProperty(sn)){
                                        let cip = new MatroxCipDevice();
                                        cip.sn = sn;
                                        cip.ipList = [element.data];
                                        this.state.devices[sn]=cip;
                                        setTimeout(()=>{
                                            this.reloadData(cip.ipList, cip.sn, cip);
                                        },1000);
                                        SyncLog.log("info", "matroxcip", "Added Matrox CIP from MDNS: " +sn +", " + cip.ipList[0])
                                    }
                                }
                            } 
                        });
                    }
                });
            }catch(e){
                // TODO SyncLog
                //console.log(e);
            }
        });

        setTimeout(()=>{
            this.mdnsQuery();
        },5000);
        this.mdnsQueryInterval = setInterval(() => {
            this.mdnsQuery();
        }, 60000);


        setTimeout(()=>{
            this.periodicReload();
        },5000)

        setInterval(()=>{
            this.periodicReload();
        },240000)
        
    }

    periodicReloadRunning = false;
    async periodicReload(){
        if(this.periodicReloadRunning){
            return;
        }

        this.periodicReloadRunning = true;
        for(let sn of Object.keys(this.state.devices)){
            let cip = this.state.devices[sn];
            try{
                await this.reloadData(cip.ipList, cip.sn, cip);
            }catch(e){}
            await sleep(2000);
        }

        this.quickStateInternal.note = ""
        this.periodicReloadRunning = false;
    }

    reloadAll(force = false){
        Object.keys(this.state.devices).forEach((sn)=>{
            let cip = this.state.devices[sn];
            this.reloadData(cip.ipList, cip.sn, cip, force);
        })
    }

    mdnsQueryInterval:any = null;

    private mdnsQuery() {
        MdnsService.query({
            questions: [
                {
                    name: "_matrox-service-api._tcp.local",
                    type: "PTR",
                    class: "IN",
                },
            ],
        });
    }


    updateQuickState(){

        let count = 0;
        let error = 0;
        let connected = 0;
        let session = 0;
        let unreachable = 0;

        Object.keys(this.state.devices).forEach((sn)=>{
            count ++;
            if(this.state.devices[sn].sessionConflict){
                session ++;
            }
            if(this.state.devices[sn].unreachable){
                unreachable ++;
            }
            if(this.state.devices[sn].failed){
                error ++;
            }else{
                connected ++;
            }


        })

        this.quickStateInternal.count = count;
        this.quickStateInternal.error = error;
        this.quickStateInternal.detail[0].count = connected; // Connected
        this.quickStateInternal.detail[1].count = session; // Session Conflict
        this.quickStateInternal.detail[2].count = unreachable; // Unreachable

        this.state.quickState = this.quickStateInternal;
        this.syncList.setState(this.state);

        this.quickState.next(this.quickStateInternal)
    }

    saveState(){
        try{writeFileSync("./state/mediadev_matroxcip/matroxcipstate.json", JSON.stringify(this.state))}catch(e){
            console.error("Error writing to file: ./state/mediadev_matroxcip/matroxcipstate.json");
        }
        try{writeFileSync("./state/mediadev_matroxcip/matroxcipstateauth.json", JSON.stringify(this.authState))}catch(e){
            console.error("Error writing to file: ./state/mediadev_matroxcip/matroxcipstateauth.json");
        }
    }

    mdnsAddDevice(data:any){

    }


    nodeChange(id:string, data:any){
        try{
            const sn = matroxSerialFromNodeId(id);
            if(sn !== null){

                let ips:string[] = [];
                data.api.endpoints.forEach((ep)=>{
                    ips.push(ep.host);
                });

                // Extract device name/hostname if available
                let deviceName = data.label || data.description || "";

                // Helper function to determine if a serial number is alphanumeric (preferred format)
                const isAlphanumeric = (serial: string): boolean => {
                    return /[a-zA-Z]/.test(serial); // Contains at least one letter
                };

                // Enhanced device deduplication logic
                let existingDeviceKey: string | null = null;
                let existingDevice: MatroxCipDevice | null = null;
                let useNewSerialAsKey = false;
                let matchReason = "";
                let pendingMatchLog: { key: string; sn: string; score: number; reason: string } | null = null;

                // First check if we already have this exact serial number
                if(this.state.devices.hasOwnProperty(sn)){
                    existingDeviceKey = sn;
                    existingDevice = this.state.devices[sn];
                    matchReason = "exact serial";
                } else {
                    // Enhanced deduplication: Check for duplicates using multiple criteria
                    let bestMatch: { key: string; device: MatroxCipDevice; score: number; reasons: string[] } | null = null;
                    
                    for(let deviceSerial in this.state.devices) {
                        let device = this.state.devices[deviceSerial];
                        let matchScore = 0;
                        let matchReasons: string[] = [];
                        
                        // 1. Serial number matching (multiple approaches)
                        let normalizedSN = sn.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                        let normalizedExistingSN = deviceSerial.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                        
                        let serialsMatch = false;
                        if(normalizedSN === normalizedExistingSN) {
                            serialsMatch = true;
                            matchScore += 100; // Highest priority
                            matchReasons.push("exact normalized serial");
                        } else {
                            // Enhanced partial matching - multiple suffix lengths
                            for(let suffixLen of [8, 6, 5, 4]) {
                                let snSuffix = normalizedSN.slice(-suffixLen);
                                let existingSuffix = normalizedExistingSN.slice(-suffixLen);
                                if(snSuffix.length >= 4 && existingSuffix.length >= 4 && snSuffix === existingSuffix) {
                                    serialsMatch = true;
                                    matchScore += Math.max(80 - (8 - suffixLen) * 10, 20); // Score based on suffix length
                                    matchReasons.push(`serial suffix match (${suffixLen} chars)`);
                                    break;
                                }
                            }
                        }
                        
                        // 2. IP address matching (higher weight for exact matches)
                        if(device.ipList.length > 0 && ips.length > 0) {
                            let commonIPs = device.ipList.filter(ip => ips.includes(ip));
                            if(commonIPs.length > 0) {
                                matchScore += 60 + (commonIPs.length * 10); // More common IPs = higher score
                                matchReasons.push(`IP match (${commonIPs.join(', ')})`);
                            }
                        }
                        
                        // 3. Device name/hostname matching
                        if(deviceName && device.name && deviceName.toLowerCase() === device.name.toLowerCase()) {
                            matchScore += 30;
                            matchReasons.push("device name match");
                        }
                        
                        // 4. Prioritize reactivation of failed devices (likely after reboot)
                        if(device.failed || device.unreachable || device.error) {
                            matchScore += 20;
                            matchReasons.push("reactivating failed device");
                        }
                        
                        // 5. Consider device type/firmware mode if available
                        if(device.type && device.firmwareMode) {
                            // This will be checked after device info is loaded, but we can still bonus existing typed devices
                            matchScore += 5;
                        }
                        
                        // Update best match if this device has a higher score
                        if(matchScore > 50 && (!bestMatch || matchScore > bestMatch.score)) { // Minimum threshold
                            bestMatch = {
                                key: deviceSerial,
                                device: device,
                                score: matchScore,
                                reasons: matchReasons
                            };
                        }
                    }
                    
                    if(bestMatch) {
                        existingDeviceKey = bestMatch.key;
                        existingDevice = bestMatch.device;
                        matchReason = bestMatch.reasons.join(', ');
                        
                        // Prefer alphanumeric serial number as the primary key
                        if(isAlphanumeric(sn) && !isAlphanumeric(bestMatch.key)) {
                            useNewSerialAsKey = true;
                        }
                        
                        pendingMatchLog = {
                            key: bestMatch.key,
                            sn,
                            score: bestMatch.score,
                            reason: matchReason
                        };
                    }
                }

                let cip: MatroxCipDevice;
                let finalDeviceKey: string;
                const wasUnhealthy = !!existingDevice && (existingDevice.failed || existingDevice.unreachable || existingDevice.error || existingDevice.outdated);
                
                if(existingDevice) {
                    cip = existingDevice;
                    
                    if(useNewSerialAsKey) {
                        // Migrate device to use alphanumeric serial number as key
                        delete this.state.devices[existingDeviceKey!];
                        cip.sn = sn; // Update the device's serial number property
                        this.state.devices[sn] = cip;
                        finalDeviceKey = sn;
                        SyncLog.log("info", "MatroxCIP", `Enhanced deduplication: Migrated device '${existingDeviceKey}' to alphanumeric key '${sn}' (${matchReason})`);
                        if (existingDeviceKey && this.lastDedupFingerprint[existingDeviceKey]) {
                            this.lastDedupFingerprint[sn] = this.lastDedupFingerprint[existingDeviceKey];
                            delete this.lastDedupFingerprint[existingDeviceKey];
                        }
                        if (existingDeviceKey && this.lastDedupReloadAt[existingDeviceKey]) {
                            this.lastDedupReloadAt[sn] = this.lastDedupReloadAt[existingDeviceKey];
                            delete this.lastDedupReloadAt[existingDeviceKey];
                        }
                    } else {
                        finalDeviceKey = existingDeviceKey!;
                    }
                    
                    // Merge IP lists to ensure we have all available IPs
                    let mergedIps = [...new Set([...cip.ipList, ...ips])];
                    cip.ipList = mergedIps;
                    
                    // Reset failure states when device comes back online
                    cip.failed = false;
                    cip.error = "";
                    cip.unreachable = false;
                    cip.outdated = false;
                    
                    // Update device name if we have it
                    if(deviceName && !cip.name) {
                        cip.name = deviceName;
                    }
                    
                    const deviceNameForFingerprint = deviceName || cip.name || "";
                    const fingerprint = `${deviceNameForFingerprint}|${mergedIps.join(',')}`;
                    const previousFingerprint = this.lastDedupFingerprint[finalDeviceKey];
                    const fingerprintUnchanged = previousFingerprint === fingerprint;
                    const shouldLogDedup = !fingerprintUnchanged || wasUnhealthy || useNewSerialAsKey;
                    const now = Date.now();
                    const lastReloadAt = this.lastDedupReloadAt[finalDeviceKey] ?? 0;
                    const shouldReload = !fingerprintUnchanged || wasUnhealthy || (now - lastReloadAt) > this.dedupReloadCooldownMs;

                    if (pendingMatchLog && shouldLogDedup) {
                        SyncLog.log(
                            "info",
                            "MatroxCIP",
                            `Enhanced deduplication: Matched device '${pendingMatchLog.key}' to new serial '${pendingMatchLog.sn}' (score: ${pendingMatchLog.score}, reasons: ${pendingMatchLog.reason})`
                        );
                    }

                    if (shouldLogDedup) {
                        SyncLog.log("info", "MatroxCIP", `Enhanced deduplication: Reactivated existing device '${finalDeviceKey}' with IPs: ${mergedIps.join(', ')} (${matchReason})`);
                    }

                    this.lastDedupFingerprint[finalDeviceKey] = fingerprint;

                    // Cleanup: Remove any obvious stale duplicates after successful match
                    this.cleanupStaleDevices(finalDeviceKey, mergedIps);

                    if (shouldReload) {
                        this.lastDedupReloadAt[finalDeviceKey] = now;
                        this.reloadData(cip.ipList, finalDeviceKey, cip);
                        if (wasUnhealthy || !fingerprintUnchanged) {
                            setTimeout(() => {
                                this.reloadData(cip.ipList, finalDeviceKey, cip);
                            }, 5000);
                        }
                    }
                } else {
                    // Create new device
                    cip = new MatroxCipDevice();
                    cip.sn = sn;
                    cip.loading = false;
                    cip.ipList = ips;
                    if(deviceName) {
                        cip.name = deviceName;
                    }
                    this.state.devices[sn] = cip;
                    finalDeviceKey = sn;
                    SyncLog.log("info", "MatroxCIP", `Enhanced deduplication: Created new device '${sn}' with IPs: ${ips.join(', ')}`);

                    const deviceNameForFingerprint = deviceName || cip.name || "";
                    const fingerprint = `${deviceNameForFingerprint}|${ips.join(',')}`;
                    this.lastDedupFingerprint[finalDeviceKey] = fingerprint;

                    this.cleanupStaleDevices(finalDeviceKey, ips);

                    const now = Date.now();
                    this.lastDedupReloadAt[finalDeviceKey] = now;
                    this.reloadData(cip.ipList, finalDeviceKey, cip);
                    setTimeout(() => {
                        this.reloadData(cip.ipList, finalDeviceKey, cip);
                    }, 5000);
                }

                // Auto-configure NMOS registry if enabled
                if (this.isAutoConfigEnabled() && 
                    this.config.autoConfigNmosRegistry.configureOnDiscovery) {
                    
                    setTimeout(() => {
                        this.autoConfigureNmosRegistry(finalDeviceKey, cip);
                    }, 10000); // Wait 10 seconds for device to stabilize
                }
            }
        }catch(e){
            SyncLog.log("error", "MatroxCIP", "Error in nodeChange:", e.message);
        }
    }


    flowChange(id:string, data:any){
        try{
            let idpart = id.split('-');
                let sn = idpart[0];
                if(sn[sn.length-1] == "0"){
                    sn = sn.slice(0,sn.length-1);
                } 
                if(this.state.devices.hasOwnProperty(sn)){
                    let cip = this.state.devices[sn];

                    this.reloadData(this.state.devices[sn].ipList, sn, cip);
                    setTimeout(()=>{
                        this.reloadData(this.state.devices[sn].ipList, sn, cip);
                    },5000);
                }
            
        }catch(e){}

    }

    // Web Accessible
    forceReloadData(sn:string){
        if(this.state.devices.hasOwnProperty(sn)){
            this.reloadData(this.state.devices[sn].ipList, sn, this.state.devices[sn],true);
        }
    }

    async batchJob(sn:string, source:string, reboot:boolean){
        let ipList:string[] = [];
        let cip;
        if(this.state.devices.hasOwnProperty(sn)){
            ipList = this.state.devices[sn].ipList
            cip = this.state.devices[sn]
        }else{
            throw new Error("Device not found.")
        }
        let sourceData = JSON.parse(source);
        let context = await this.apiRequest(ipList, sn, "GET", "/device/settings/context");

        let data:any = {};

        Object.keys(sourceData).forEach((k)=>{
            try{
            data[k] = context[k];
            Object.keys(sourceData[k]).forEach((kk)=>{
                if(context[k].hasOwnProperty(kk)){
                    context[k][kk] = sourceData[k][kk];
                }
            })
            }catch(e){}
        });
        await this.apiRequest(ipList,sn,"POST","/device/settings/context",data,true);
        if(reboot){
            await sleep(100);
            await this.apiRequest(ipList,sn,"POST","/device/reboot",{"maintenanceMode":false},true);
        }else{
            this.reloadData(ipList,sn,cip);
        }
        
        
    }

    // Web Accessible
    async changeEdid(sn:string, name:string){
        let ipList:string[] = [];
        let cip;
        if(this.state.devices.hasOwnProperty(sn)){
            ipList = this.state.devices[sn].ipList
            cip = this.state.devices[sn]
        }else{
            throw new Error("Device not found.")
        }

        if(name == "__nativeMatrox"){
            await this.apiRequest(ipList,sn,"POST","/device/settings/video/in/mode",{isEdidOverrideEnabled: false, selectEdid: "passthrough",noSignalOption:cip.inputNoSignal})
        }else if(name == "__passthrough"){
            await this.apiRequest(ipList,sn,"POST","/device/settings/video/in/mode",{isEdidOverrideEnabled: true, selectEdid: "passthrough",noSignalOption:cip.inputNoSignal})
        }else{
            for(let edid of this.config.edids){
                if(edid.name == name){
                    await this.apiUploadFile(ipList,sn,"/device/settings/video/in/hdmi/edid/custom/0","edid.bin",edid.file)
                    break;
                }
            }
            await this.apiRequest(ipList,sn,"POST","/device/settings/video/in/mode",{isEdidOverrideEnabled: true, selectEdid: "custom0",noSignalOption:cip.inputNoSignal})
        }
        setTimeout(()=>{
            this.reloadData(ipList,sn,this.state.devices[sn]);    
        },2000)
    }

    async fixPtpDomain(sn:string){
        let ipList:string[] = [];
        let cip;
        if(this.state.devices.hasOwnProperty(sn)){
            ipList = this.state.devices[sn].ipList
            cip = this.state.devices[sn]
        }else{
            throw new Error("Device not found.")
        }

        let context = await this.apiRequest(ipList, sn, "GET", "/device/settings/context");
        if(!context){
            throw new Error("Can not get Context.");
        }
        let data = context.ptpSettings;
        data.domain = this.ptpDomain
        let result = await this.apiRequest(ipList, sn, "POST", "/device/settings/ptp", data);

        setTimeout(()=>{
            this.reloadData(ipList,sn,cip)
        },2000)
    }

    private async isMasterEnabled(sn: string, ipList: string[]): Promise<boolean> {
        try {
            const masterSettings = await this.apiRequest(ipList, sn, "GET", "/device/settings/streams/master");
            if (masterSettings && typeof masterSettings.enable === "boolean") {
                return masterSettings.enable;
            }
        } catch (error) {
            SyncLog.log("debug", "MatroxCIP", `Master settings GET failed for ${sn}, falling back to context check.`);
        }

        try {
            const context = await this.apiRequest(ipList, sn, "GET", "/device/settings/context");
            return !!context?.StreamsEnableSettings?.enable;
        } catch (error) {
            return false;
        }
    }

    private async ensureMasterEnabled(sn: string, ipList: string[], options?: { attempts?: number; delayMs?: number }) {
        const attempts = options?.attempts ?? 3;
        const delayMs = options?.delayMs ?? 2000;

        for (let attempt = 1; attempt <= attempts; attempt++) {
            const alreadyEnabled = await this.isMasterEnabled(sn, ipList);
            if (alreadyEnabled) {
                SyncLog.log("info", "MatroxCIP", `Master mode already enabled for ${sn} (attempt ${attempt}/${attempts})`);
                return;
            }

            try {
                SyncLog.log("info", "MatroxCIP", `Enabling master mode for ${sn} (attempt ${attempt}/${attempts})`);
                await this.masterEnable(sn);
            } catch (error) {
                SyncLog.log("warning", "MatroxCIP", `Master enable attempt ${attempt} failed for ${sn}: ${error instanceof Error ? error.message : String(error)}`);
            }

            if (attempt < attempts) {
                await sleep(delayMs);
            }
        }

        if (!(await this.isMasterEnabled(sn, ipList))) {
            throw new Error(`Master mode not enabled after ${attempts} attempts`);
        }
    }

    // Web Accessible
    async togglePtp(sn:string, enabled:boolean){
        let ipList:string[] = [];
        let cip;
        if(this.state.devices.hasOwnProperty(sn)){
            ipList = this.state.devices[sn].ipList
            cip = this.state.devices[sn]
        }else{
            throw new Error("Device not found.")
        }

        let context = await this.apiRequest(ipList, sn, "GET", "/device/settings/context");
        if(!context){
            throw new Error("Can not get Context.");
        }
        let data = context.ptpSettings;
        data.isEnabled = enabled;
        let result = await this.apiRequest(ipList, sn, "POST", "/device/settings/ptp", data);

        setTimeout(()=>{
            this.reloadData(ipList,sn,cip)
        },2000)
    }

    // Web Accessible - IGMP Version Control (available on both TX and RX devices)
    async setIgmpVersion(sn: string, version: "none" | "v2" | "v3") {
        let ipList: string[] = [];
        let cip;
        if (this.state.devices.hasOwnProperty(sn)) {
            ipList = this.state.devices[sn].ipList;
            cip = this.state.devices[sn];
        } else {
            throw new Error("Device not found.");
        }

        // Get current other settings
        let context = await this.apiRequest(ipList, sn, "GET", "/device/settings/other");
        if (!context) {
            throw new Error("Cannot get other settings context.");
        }

        // Update IGMP version
        let data = { ...context };
        data.igmpVersion = version;
        
        SyncLog.log("info", "MatroxCIP", `Setting IGMP version to ${version} for device ${sn}`);
        
        let result = await this.apiRequest(ipList, sn, "POST", "/device/settings/other", data);
        
        // Note: Device reboot may be required for changes to take effect
        SyncLog.log("warning", "MatroxCIP", `IGMP version change requires device reboot for ${sn}`);

        setTimeout(() => {
            this.reloadData(ipList, sn, cip);
        }, 2000);
    }

    // Web Accessible - Toggle Audio Stream Enable/Disable
    async toggleAudioStream(sn: string, streamType: 'tx' | 'rx', streamIndex: number, enabled: boolean) {
        let ipList: string[] = [];
        let cip;
        if (this.state.devices.hasOwnProperty(sn)) {
            ipList = this.state.devices[sn].ipList;
            cip = this.state.devices[sn];
        } else {
            throw new Error("Device not found.");
        }

        SyncLog.log("info", "MatroxCIP", `${enabled ? 'Enabling' : 'Disabling'} ${streamType.toUpperCase()} audio stream ${streamIndex} for device ${sn}`);

        // For RX streams, we need to get current SDP URL
        let data: any = { enable: enabled };
        
        if (streamType === 'rx') {
            try {
                let currentStream = await this.apiRequest(ipList, sn, "GET", `/device/settings/streams/audio/${streamIndex}`);
                if (currentStream && currentStream.sdpUrl) {
                    data.sdpUrl = currentStream.sdpUrl;
                } else {
                    // If no current SDP URL, provide empty string as required parameter
                    data.sdpUrl = "";
                }
                SyncLog.log("info", "MatroxCIP", `Got current RX audio stream ${streamIndex} config for ${sn}: ${JSON.stringify(currentStream)}`);
            } catch (error) {
                SyncLog.log("warning", "MatroxCIP", `Could not get current SDP URL for RX audio stream ${streamIndex} on ${sn}: ${error instanceof Error ? error.message : String(error)}`);
                // If we can't get current config, provide empty SDP URL as required parameter
                data.sdpUrl = "";
            }
        }

        SyncLog.log("info", "MatroxCIP", `Posting to /device/settings/streams/audio/${streamIndex} for ${sn} with data: ${JSON.stringify(data)}`);
        
        try {
            let result = await this.apiRequest(ipList, sn, "POST", `/device/settings/streams/audio/${streamIndex}`, data);
            SyncLog.log("info", "MatroxCIP", `Audio stream toggle successful for ${sn}, result: ${JSON.stringify(result)}`);
        } catch (error) {
            SyncLog.log("error", "MatroxCIP", `Audio stream toggle failed for ${sn}: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        }

        setTimeout(() => {
            this.reloadData(ipList, sn, cip);
        }, 2000);
    }

    // Resolve a serial number or Matrox device name (the NMOS device label) to the state key.
    private resolveDeviceKey(identifier: string): string | null {
        if(this.state.devices.hasOwnProperty(identifier)){
            return identifier;
        }
        for(const key in this.state.devices){
            if(this.state.devices[key].name === identifier){
                return key;
            }
        }
        return null;
    }

    // Public method to query multiviewer enabled status by device serial number or name
    isMultiviewerEnabled(deviceIdentifier: string): boolean {
        const key = this.resolveDeviceKey(deviceIdentifier);
        return key !== null && this.state.devices[key].isMultiviewEnabled === true;
    }

    /**
     * Whether an NMOS receiver belongs to a Matrox decoder with multiviewer enabled. Resolved
     * through the receiver's NMOS device and node, so router aliases and labels do not matter.
     */
    static isMultiviewReceiver(receiverFlowId: string): boolean {
        const instance = MediaDevMatroxConvertIp.instance;
        if(!instance){ return false; }
        const deviceId = NmosRegistryConnector.nmosDeviceIdFromFlowId(receiverFlowId);
        if(!deviceId || !NmosRegistryConnector.isMatroxCipDevice(deviceId)){ return false; }

        const nmosState = NmosRegistryConnector.instance?.getNmosState?.();
        const nodeId = nmosState?.devices?.[deviceId]?.node_id;
        const node = nodeId ? (nmosState?.nodes?.[nodeId] ?? { id: nodeId }) : null;
        const key = node ? findMatroxDeviceKey(instance.state.devices, node) : null;
        if(key === null){
            SyncLog.log("debug", "MatroxCIP", `No Matrox device found for NMOS receiver ${receiverFlowId} (device ${deviceId})`);
            return false;
        }
        return instance.state.devices[key].isMultiviewEnabled === true;
    }

    // Web Accessible
    async toggleMultiviewer(sn:string, enabled:boolean){
        if(typeof enabled !== "boolean"){
            throw new Error("'enabled' must be true or false.");
        }
        SyncLog.log("info", "MatroxCIP", `Toggling multiviewer for device ${sn}: ${enabled ? 'ENABLE' : 'DISABLE'}`);

        // Accept a serial number or the device name, but talk to the device under its serial:
        // apiRequest keys its login session on it.
        const deviceSerial = this.resolveDeviceKey(sn);
        if(deviceSerial === null){
            SyncLog.log("error", "MatroxCIP", `Device not found: ${sn}. Available devices: ${Object.keys(this.state.devices).join(', ')}`);
            throw new Error("Device not found.");
        }
        const cip = this.state.devices[deviceSerial];
        const ipList = cip.ipList;

        // Note: the documented /device/settings/Multiview endpoint returns 404 on current firmware;
        // a partial context POST works.
        const multiviewerData = {
            MultiviewSettings: {
                isMultiviewEnabled: enabled
            }
        };

        try{
            // apiRequest throws on HTTP errors. The response body is not a reliable success signal,
            // so read the setting back instead.
            const result = await this.apiRequest(ipList, deviceSerial, "POST", "/device/settings/context", multiviewerData);
            SyncLog.log("debug", "MatroxCIP", `Multiviewer API result for ${deviceSerial}:`, result);
            const context = await this.apiRequest(ipList, deviceSerial, "GET", "/device/settings/context");
            const actual = context?.MultiviewSettings?.isMultiviewEnabled;
            if(typeof actual !== "boolean"){
                throw new Error("Device does not report a multiviewer setting; is multiviewer supported?");
            }
            if(actual !== enabled){
                throw new Error(`Device kept multiviewer ${actual ? 'enabled' : 'disabled'}`);
            }
            cip.isMultiviewEnabled = actual;
            SyncLog.log("info", "MatroxCIP", `Multiviewer ${enabled ? 'enabled' : 'disabled'} for device ${deviceSerial}`);

            // Multiviewer only works with master mode on.
            if(enabled) {
                await this.ensureMasterEnabled(deviceSerial, ipList);
            }
        } finally {
            // Reflect whatever state the device ended up in, including after a failure.
            setTimeout(()=>{
                this.reloadData(ipList,deviceSerial,cip)
            },2000)
        }
    }

    // Auto-configure NMOS registry for discovered devices
    private async autoConfigureNmosRegistry(sn: string, cip: MatroxCipDevice) {
        try {
            SyncLog.log("info", "MatroxCIP", `Auto-configuring NMOS registry for device ${sn}`);
            
            // Check if device already has NMOS registry configured
            let currentSettings;
            try {
                currentSettings = await this.apiRequest(cip.ipList, sn, "GET", "/device/settings/nmos/registerserver");
                
                // Skip if the device already has manual registry configured
                if (currentSettings?.server?.ip && 
                    currentSettings.server.ip !== this.getRegistryIp()) {
                    SyncLog.log("info", "MatroxCIP", `Device ${sn} already has manual NMOS registry configured, skipping auto-config`);
                    return;
                }
            } catch (e) {
                SyncLog.log("debug", "MatroxCIP", `Could not retrieve current NMOS registry settings for ${sn}: ${e.message}`);
            }
            
            // Auto-configure the registry
            await this.setNmosRegistry(
                sn, 
                this.getRegistryIp(),
                this.getRegistryPort(),
                this.getRegistryApiVersion()
            );
            
            SyncLog.log("info", "MatroxCIP", `Successfully auto-configured NMOS registry for device ${sn}`);
            
        } catch (e) {
            SyncLog.log("error", "MatroxCIP", `Failed to auto-configure NMOS registry for device ${sn}: ${e.message}`);
            
            // Retry if enabled
            if (this.config.autoConfigNmosRegistry.retryOnFailure) {
                setTimeout(() => {
                    SyncLog.log("info", "MatroxCIP", `Retrying NMOS registry auto-configuration for device ${sn}`);
                    this.autoConfigureNmosRegistry(sn, cip);
                }, this.config.autoConfigNmosRegistry.retryDelayMs);
            }
        }
    }

    // Configure automatic NMOS registry settings
    async configureAutoNmosRegistry(enabled: boolean) {
        this.config.autoConfigNmosRegistry.enabled = enabled;
        
        SyncLog.log("info", "MatroxCIP", `Auto NMOS registry configuration updated: enabled=${enabled}, using registry from settings: ${this.getRegistryIp()}:${this.getRegistryPort()}`);
        
        // Save config to file if needed
        // Note: Currently we don't persist config changes to file
        // This would require implementing config file writing
    }

    // Toggle auto-reauthentication setting
    async toggleAutoReauth(enabled: boolean) {
        this.config.disableAutoReauth = !enabled; // Note: enabled=true means auto-reauth is ON, so disableAutoReauth=false
        
        SyncLog.log("info", "MatroxCIP", `Auto-reauthentication setting updated: enabled=${enabled} (disableAutoReauth=${this.config.disableAutoReauth})`);
        
        // Update the sync object to notify UI
        this.state.settings.disableAutoReauth = this.config.disableAutoReauth;
        this.syncList.setState(this.state);
        
        // Save config to file if needed
        // Note: Currently we don't persist config changes to file
        // This would require implementing config file writing
    }

    async bulkConfigureNmosRegistry() {
        if (!this.isAutoConfigEnabled()) {
            throw new Error("Auto NMOS registry configuration is not enabled or registry IP is not available in settings");
        }

        const results: { [key: string]: { success: boolean, error?: string } } = {};
        const deviceList = Object.keys(this.state.devices);
        
        SyncLog.log("info", "MatroxCIP", `Starting bulk NMOS registry configuration for ${deviceList.length} devices`);
        
        for (const sn of deviceList) {
            try {
                const cip = this.state.devices[sn];
                if (!cip.failed && !cip.unreachable) {
                    await this.setNmosRegistry(
                        sn,
                        this.getRegistryIp(),
                        this.getRegistryPort(),
                        this.getRegistryApiVersion()
                    );
                    results[sn] = { success: true };
                    SyncLog.log("info", "MatroxCIP", `Bulk configuration successful for device ${sn}`);
                } else {
                    results[sn] = { success: false, error: "Device is failed or unreachable" };
                }
                
                // Add delay between devices to prevent overwhelming the network
                await sleep(2000);
                
            } catch (e) {
                results[sn] = { success: false, error: e.message };
                SyncLog.log("error", "MatroxCIP", `Bulk configuration failed for device ${sn}: ${e.message}`);
            }
        }
        
        const successCount = Object.values(results).filter(r => r.success).length;
        SyncLog.log("info", "MatroxCIP", `Bulk NMOS registry configuration completed: ${successCount}/${deviceList.length} devices configured successfully`);
        
        return results;
    }

    // Web Accessible
    async setNmosRegistry(sn:string, ip:string, port:number = 3210, apiVersion:string = "v1.3"){
        let ipList:string[] = [];
        let cip;
        if(this.state.devices.hasOwnProperty(sn)){
            ipList = this.state.devices[sn].ipList
            cip = this.state.devices[sn]
        }else{
            throw new Error("Device not found.")
        }

        SyncLog.log("info", "MatroxCIP", `Configuring NMOS registry for device ${sn}: ${ip}:${port}`);

        // Get current NMOS registry settings
        let currentSettings;
        try {
            currentSettings = await this.apiRequest(ipList, sn, "GET", "/device/settings/nmos/registerserver");
        } catch (e) {
            SyncLog.log("warn", "MatroxCIP", `Could not retrieve current NMOS registry settings for ${sn}, using defaults`);
            currentSettings = {};
        }
        
        // Configure manual NMOS registry with proper payload structure
        let registryConfig = {
            isEnabled: true,
            mode: "manual",
            host: ip,
            isIPv6: false,
            port: port,
            apiVersion: apiVersion,
            isSecured: false,
            selectPrivateKey: currentSettings.selectPrivateKey || "ManufacturerRsaClientPrivateKey",
            isClientServerRole: currentSettings.isClientServerRole || false
        };
        
        let result = await this.apiRequest(ipList, sn, "POST", "/device/settings/nmos/registerserver", registryConfig);
        
        if (result) {
            SyncLog.log("info", "MatroxCIP", `Successfully configured NMOS registry for device ${sn}`);
            
            // Update device state to reflect registry configuration
            cip.loading = true;
            this.syncList.setState(this.state);
            
            setTimeout(()=>{
                this.reloadData(ipList,sn,cip)
            },2000)
        } else {
            throw new Error("Failed to configure NMOS registry settings");
        }
    }

    // Web Accessible
    async ptpEnableAll(){
        for(let sn in this.state.devices){
            try{
                await this.togglePtp(sn, true);
            }catch(e){
                SyncLog.log("error", "MatroxCIP", `Failed to enable PTP on device ${sn}: ${e.message}`);
            }
        }
    }

    // Web Accessible
    async ptpDisableAll(){
        for(let sn in this.state.devices){
            try{
                await this.togglePtp(sn, false);
            }catch(e){
                SyncLog.log("error", "MatroxCIP", `Failed to disable PTP on device ${sn}: ${e.message}`);
            }
        }
    }

    // Web Accessible - Bulk IGMP Version Operations
    async setIgmpVersionAll(version: "none" | "v2" | "v3"){
        for(let sn in this.state.devices){
            try{
                await this.setIgmpVersion(sn, version);
            }catch(e){
                SyncLog.log("error", "MatroxCIP", `Failed to set IGMP version to ${version} on device ${sn}: ${e.message}`);
            }
        }
    }

    // Web Accessible
    async restartDevice(sn:string){
        let ipList:string[] = [];
        let cip;
        if(this.state.devices.hasOwnProperty(sn)){
            ipList = this.state.devices[sn].ipList
            cip = this.state.devices[sn]
        }else{
            throw new Error("Device not found.")
        }

        await this.apiRequest(ipList, sn, "POST", "/device/reboot", {"maintenanceMode":false}, true);
        
        // Mark device as loading since it will be rebooting
        cip.loading = true;
        this.updateQuickState();
        this.syncList.setState(this.state);
        
        // Reload device data after reboot delay
        setTimeout(()=>{
            this.reloadData(ipList,sn,cip)
        },10000) // 10 second delay for reboot
    }

    // Web Accessible
    async restartAll(){
        for(let sn in this.state.devices){
            try{
                await this.restartDevice(sn);
                // Add delay between device restarts to avoid network overload
                await sleep(1000);
            }catch(e){
                SyncLog.log("error", "MatroxCIP", `Failed to restart device ${sn}: ${e.message}`);
            }
        }
    }


    async changeResolution(sn:string, name:string){
        let ipList:string[] = [];
        let cip;
        if(this.state.devices.hasOwnProperty(sn)){
            ipList = this.state.devices[sn].ipList
            cip = this.state.devices[sn]
        }else{
            throw new Error("Device not found.")
        }
        let context = await this.apiRequest(ipList, sn, "GET", "/device/settings/context");
        if(!context){
            throw new Error("Can not get Context.");
        }
        let mode = cip.direction;
        

        if(mode == "tx"){
            if(name == "__input"){
                let data = context.txVideoStream0
                data.selectPixelFormat = "input"
                data.selectResolution = "input"

                await this.apiRequest(ipList, sn, "POST", "/device/settings/context", {txVideoStream0:data});
            }else{
                for(let res of this.config.resolutions){
                    if(res.name == name){
                        
                        let data = context.txVideoStream0
                        data.selectPixelFormat = "force"
                        data.selectResolution = "force"
                        data.colorSpace = "bt709"
                        if(res.sampling){
                            data.pixelFormat = res.sampling
                            }else{
                                data.pixelFormat = "yuv_10_422";
                            }
                            data.resolution = res.settings

                        await this.apiRequest(ipList, sn, "POST", "/device/settings/context", {txVideoStream0:data});
                        break;
                    }
                }
            }
        }else{
            if(name == "__input"){
                let data = context.monitorSettings
                data.selectPixelFormat = "stream"
                data.selectResolution = "stream"
                await this.apiRequest(ipList, sn, "POST", "/device/settings/context", {monitorSettings:data});
            }else if(name == "__edid"){
                let data = context.monitorSettings
                data.selectPixelFormat = "edidpreference"
                data.selectResolution = "edidpreference"
                await this.apiRequest(ipList, sn, "POST", "/device/settings/context", {monitorSettings:data});
            }else{
                for(let res of this.config.resolutions){
                    if(res.name == name){
                        let data = context.monitorSettings
                        data.selectPixelFormat = "force"
                        data.selectResolution = "force"
                        data.isEdidOverrideEnabled =  false;
                        data.colorSpace = "bt709"
                        if(res.sampling){
                            data.pixelFormat = res.sampling

                            }else{
                                data.pixelFormat = "yuv_10_422";
                            }
                        data.resolution = res.settings
                        await this.apiRequest(ipList, sn, "POST", "/device/settings/context", {monitorSettings:data});
                        break;
                    }
                }
            }
        }
        
        setTimeout(()=>{
            this.reloadData(ipList,sn,cip)
        },2000)
    }
    async masterEnable(sn:string){
        let ipList:string[] = [];
        let cip;
        if(this.state.devices.hasOwnProperty(sn)){
            ipList = this.state.devices[sn].ipList
            cip = this.state.devices[sn]
        }else{
            throw new Error("Device not found.")
        }
        
        // Get current master settings from the documented endpoint
        let currentMasterSettings;
        try {
            currentMasterSettings = await this.apiRequest(ipList, sn, "GET", "/device/settings/streams/master");
        } catch(e) {
            // If the documented endpoint fails, fall back to context approach
            SyncLog.log("debug", "MatroxCIP", `Master settings GET failed, using context fallback for ${sn}:`, e.message);
            let context = await this.apiRequest(ipList, sn, "GET", "/device/settings/context");
            if(!context){
                throw new Error("Can not get Context.");
            }
            currentMasterSettings = context.StreamsEnableSettings || {};
        }
        
        // Construct proper StreamsMasterSettings according to API documentation
        let masterData = {
            enable: true,
            isRedundancyEnabled: currentMasterSettings.isRedundancyEnabled || false,
            connectionMode: currentMasterSettings.connectionMode || "manual"
        };
        
        SyncLog.log("debug", "MatroxCIP", `Enabling master mode for ${sn}:`, masterData);
        
        await this.apiRequest(ipList, sn, "POST", "/device/settings/streams/master", masterData);
        
        setTimeout(()=>{
            this.reloadData(ipList,sn,cip)
        },2000)
    }

    async deleteDevice(sn:string){
        try{
            delete this.state.devices[sn];
        }catch(e){
            throw new Error("Can not delete device.");
        }

        try{
            delete this.authState[sn];
        }catch(e){}

        this.syncList.setState(this.state);
        this.updateQuickState();
        this.saveState();

    }

    /**
     * Get authentication token for a specific device (for proxy usage)
     */
    public getAuthToken(sn: string): {bearerToken: string, sessionCookie: string} | null {
        if (this.authState.hasOwnProperty(sn)) {
            const auth = this.authState[sn];
            // Handle both old format (string) and new format (object)
            if (typeof auth === 'string') {
                return { bearerToken: auth, sessionCookie: `session_token=${auth}` };
            }
            return auth;
        }
        return null;
    }

    /**
     * Get device state (for proxy usage)
     */
    public getDeviceState() {
        return this.state;
    }

    /**
     * Clean up stale/duplicate devices after successful device matching
     * This helps prevent duplicate entries after device reboots
     */
    private cleanupStaleDevices(activeDeviceKey: string, activeIPs: string[]) {
        try {
            let devicesToRemove: string[] = [];
            let activeDevice = this.state.devices[activeDeviceKey];
            
            if (!activeDevice) return;

            // Look for potential duplicates/stale entries
            for (let deviceKey in this.state.devices) {
                if (deviceKey === activeDeviceKey) continue; // Skip the active device
                
                let device = this.state.devices[deviceKey];
                let shouldRemove = false;
                let removeReason = "";

                // Check for obvious stale duplicates
                // 1. Device has same IPs but is marked as failed/unreachable
                if (device.ipList.length > 0 && activeIPs.length > 0) {
                    let commonIPs = device.ipList.filter(ip => activeIPs.includes(ip));
                    if (commonIPs.length > 0) {
                        if (device.failed || device.unreachable || device.error) {
                            shouldRemove = true;
                            removeReason = `stale duplicate with failed state (common IPs: ${commonIPs.join(', ')})`;
                        }
                    }
                }

                // 2. Device has been failed/unreachable for extended period
                if ((device.failed || device.unreachable) && !shouldRemove) {
                    // Check if device has been stale for a while (no recent successful connection)
                    let isLikelyStale = !device.loading && 
                                      (device.error === "Device not refreshed" || 
                                       device.error.includes("Auth not possible") ||
                                       device.error.includes("No connection possible"));
                    
                    if (isLikelyStale) {
                        // Only remove if we have a very similar device that's now active
                        let normalizedStaleSN = deviceKey.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                        let normalizedActiveSN = activeDeviceKey.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
                        
                        if (normalizedStaleSN.includes(normalizedActiveSN.slice(-6)) || 
                            normalizedActiveSN.includes(normalizedStaleSN.slice(-6))) {
                            shouldRemove = true;
                            removeReason = `stale device with similar serial to active device`;
                        }
                    }
                }

                if (shouldRemove) {
                    devicesToRemove.push(deviceKey);
                    SyncLog.log("info", "MatroxCIP", `Cleanup: Marking stale device '${deviceKey}' for removal (${removeReason})`);
                }
            }

            // Remove stale devices
            for (let deviceKey of devicesToRemove) {
                delete this.state.devices[deviceKey];
                if (this.authState.hasOwnProperty(deviceKey)) {
                    delete this.authState[deviceKey];
                }
                SyncLog.log("info", "MatroxCIP", `Cleanup: Removed stale device '${deviceKey}'`);
            }

            if (devicesToRemove.length > 0) {
                this.syncList.setState(this.state);
                this.updateQuickState();
                this.saveState();
                SyncLog.log("info", "MatroxCIP", `Cleanup: Removed ${devicesToRemove.length} stale device(s) to prevent duplicates`);
            }

        } catch (e) {
            SyncLog.log("error", "MatroxCIP", `Error during stale device cleanup: ${e.message}`);
        }
    }

    async reloadData(ipList:string[], sn:string, cip:MatroxCipDevice, force =false){
        if(cip.loading){
            cip.outdated = true;
        }else{
            cip.loading = true;
            this.doReloadData(ipList,sn,cip,force);
        }
    }

    calculateResolution(set:any){
        let res = set.resolution
        let text = ""
        text += res.width;
        text += "x"
        text += res.height;
        if(res.scan == "interlaced"){
            text += "i"
        }else{
            text += "p"
        }
        if(res.refreshRateDen == 1){
            text += res.refreshRateNum;
        }else{
            text += Math.round( (res.refreshRateNum/res.refreshRateDen)*100)/100
        }

        text += " "

        switch(set.pixelFormat){
            case "yuv_10_422":
                text += "YCbCr 10 Bit 4:2:2"
                break;
            case "rgb_10":
                text += "RGB 10 Bit 4:4:4"
                break;
            case "rgb_8":
                text += "RGB 8 Bit 4:4:4"
                break;
            default:
                text += set.pixelFormat
        }

        text += " "

        switch(set.colorSpace){
            case "bt709":
                text += "BT.709"
                break;
            case "bt2020":
                text += "BT.2020"
                break;
            default:
                text += set.colorSpace
        }

        
        // TODO Information is not updated properly on amtrox device, check after firmware updates
        //if(set.hasOwnProperty("colorTcs")){
        //    text += " "
        //    switch(set.colorTcs){
        //        case "sdr":
        //            text += "SDR"
        //            break;
        //        case "pq":
        //            text += "PQ"
        //            break;
        //        case "hlg":
        //            text += "HLG"
        //            break;
        //        default:
        //            text += set.colorTcs
        //    }
        //}else{
        //    //text += " "
        //    //text += "SDR"
        //}



    


        return text;
    }

    calculateAudio(aud:any){
        let text = "";

        text += aud.audioFormat.nbChannels + " Ch ";
        text += (aud.audioFormat.sampleRate/1000) + " kHz ";

        switch(aud.audioFormat.format){
            case "PCM_16":
                text += "16 Bit"
                break;
            case "PCM_24":
                text += "24 Bit"
                break;
            default:
                text += aud.audioFormat.format
        }
        

        // TODO, incomplete Data
        //text += " "
        //text += aud.packetTime + " ms";

        return text;
    }


    async doReloadData(ipList:string[], sn:string, cip:MatroxCipDevice, force = false){
        while(this.simultanLoading > 3){
            await sleep(1000);
        }
        this.simultanLoading ++;
        SyncLog.log("verbose", "matroxcip", "Reloading Matrox CIP with SN: "+sn,{ipList,force});
        cip.loading = true;
        
        this.syncList.setState(this.state);
        let context;
        let status;
        let caps;
        try{
            SyncLog.log("debug", "MatroxCIP", `Device ${sn}: Starting API calls to IPs: ${ipList.join(', ')}`);
            context = await this.apiRequest(ipList, sn, "GET", "/device/settings/context", {}, force);
            status = await this.apiRequest(ipList, sn, "GET", "/device/status", {}, force);
            SyncLog.log("debug", "MatroxCIP", `Device ${sn}: API calls completed. Context: ${context ? 'received' : 'null'}, Status: ${status ? 'received' : 'null'}`);
            cip.unreachable = false;
            if(context == "duplicate" || status == "duplicate"){
                cip.sessionConflict = true;
            }else{
                cip.sessionConflict = false;
            
                if(context && status){
                    try{
                        cip.firmwareVersion = context.header.verSW;
                        SyncLog.log("debug", "MatroxCIP", `Device ${sn}: Processing SKU: ${context.header.sku}`);
                        switch(context.header.sku){
                            case "fpga2110_hdmi_unc_jpegxs_sfp_10G_rx":
                                cip.firmwareMode = "HDMI JPEG-XS 10G RX"
                                cip.direction = "rx"
                                cip.simpleMode = "IP/JPEG-XS to HDMI"
                                cip.type = "DSH"
                                cip.hasEdid = true;
                            break;
                            case "fpga2110_hdmi_unc_jpegxs_sfp_10G_tx":
                                cip.firmwareMode = "HDMI JPEG-XS 10G TX"
                                cip.direction = "tx"
                                cip.simpleMode = "HDMI to IP/JPEG-XS"
                                cip.type = "DSH"
                                cip.hasEdid = true;
                            break;

                            case "fpga2110_hdmi_unc_sfp_10_25G_tx":
                                cip.firmwareMode = "HDMI 10G/25G TX"
                                cip.direction = "tx"
                                cip.simpleMode = "HDMI to IP"
                                cip.type = "DSH"
                                cip.hasEdid = true;
                            break;

                            case "fpga2110_hdmi_unc_sfp_10_25G_rx":
                                cip.firmwareMode = "HDMI 10/25G RX"
                                cip.direction = "rx"
                                cip.simpleMode = "IP to HDMI"
                                cip.type = "DSH"
                                cip.hasEdid = true;
                            break;

                            case "fpga2110_hdmi_colibri_combo_rj45_1_2G5_rx":
                                cip.firmwareMode = "HDMI Colibri 1/2.5G RX"
                                cip.direction = "rx"
                                cip.simpleMode = "IP/Colibri to HDMI"
                                cip.type = "SRH"
                                cip.hasEdid = true;
                            break;

                            case "fpga2110_hdmi_colibri_combo_rj45_1_2G5_tx":
                                cip.firmwareMode = "HDMI Colibri 1/2.5G TX"
                                cip.direction = "rx"
                                cip.simpleMode = "IP/Colibri to HDMI"
                                cip.type = "SRH"
                                cip.hasEdid = true;
                            break;

                            case "fpga2110_hdmi_jpegxs_combo_rj45_1_2G5_rx":
                                cip.firmwareMode = "HDMI JPEG-XS 1/2.5G RX"
                                cip.direction = "rx"
                                cip.simpleMode = "IP/JPEG-XS to HDMI"
                                cip.type = "SRH"
                                cip.hasEdid = true;
                            break;

                            case "fpga2110_hdmi_jpegxs_combo_rj45_1_2G5_tx":
                                cip.firmwareMode = "HDMI JPEG-XS 1/2.5G TX"
                                cip.direction = "tx"
                                cip.simpleMode = "HDMI to IP/JPEG-XS"
                                cip.type = "SRH"
                                cip.hasEdid = true;
                            break;




                            // SDI / DSS

                            case "fpga2110_sdi_unc_jpegxs_sfp_10G_rx":
                                cip.firmwareMode = "SDI JPEG-XS 10G RX"
                                cip.direction = "rx"
                                cip.simpleMode = "IP/JPEG-XS to SDI"
                                cip.type = "DSS"
                                cip.hasEdid = false;
                            break;
                            case "fpga2110_sdi_unc_jpegxs_sfp_10G_tx":
                                cip.firmwareMode = "SDI JPEG-XS 10G TX"
                                cip.direction = "tx"
                                cip.simpleMode = "SDI to IP/JPEG-XS"
                                cip.type = "DSS"
                                cip.hasEdid = false;
                            break;

                            case "fpga2110_sdi_unc_sfp_10_25G_tx":
                                cip.firmwareMode = "SDI 10G/25G TX"
                                cip.direction = "tx"
                                cip.simpleMode = "SDI to IP"
                                cip.type = "DSS"
                                cip.hasEdid = false;
                            break;

                            case "fpga2110_sdi_unc_sfp_10_25G_rx":
                                cip.firmwareMode = "SDI 10/25G RX"
                                cip.direction = "rx"
                                cip.simpleMode = "IP to SDI"
                                cip.type = "DSS"
                                cip.hasEdid = false;
                            break;

                            case "fpga2110_hdmi_colibri_rj45_1_2G5_rx":
                                cip.firmwareMode = "HDMI 2.5G RX"
                                cip.direction = "rx"
                                cip.simpleMode = "Decoder"
                                cip.type = "DRH"
                                cip.hasEdid = true;
                            break;

                            case "fpga2110_hdmi_colibri_rj45_1_2G5_tx":
                                cip.firmwareMode = "HDMI 2.5G TX"
                                cip.direction = "tx"
                                cip.simpleMode = "Encoder"
                                cip.type = "DRH"
                                cip.hasEdid = true;
                            break;

                            case "fpga2110_sdi_colibri_rj45_1_2G5_tx":
                                cip.firmwareMode = "SDI 2.5G TX"
                                cip.direction = "tx"
                                cip.simpleMode = "Encoder"
                                cip.type = "DRS"
                                cip.hasEdid = false;
                            break;

                            default:
                                SyncLog.log("warn", "MatroxCIP", `Device ${sn}: Unknown SKU detected: ${context.header.sku}. Please add support for this device type.`);
                                cip.firmwareMode = "Unknown"
                                cip.simpleMode = "Unknown Device Type"
                                cip.type = "UNK"
                        }

                        SyncLog.log("debug", "MatroxCIP", `Device ${sn}: Fields set - Type: '${cip.type}', SimpleMode: '${cip.simpleMode}', FirmwareMode: '${cip.firmwareMode}'`);
                        cip.name = context.nmosInterface.deviceName;

                        cip.moinitorMode = context.monitorSettings.selectResolution;
                        if(cip.moinitorMode == "force"){
                            cip.monitorResolution = this.calculateResolution(context.monitorSettings)
                        }else if(cip.moinitorMode == "stream"){
                            cip.monitorResolution = this.calculateResolution(context.rxVideoStreamManual0)
                        }else if(cip.moinitorMode == "edidpreference"){
                            cip.monitorResolution = context.RxMonitorEdidHeader.nativeResolution;
                        }

                        

                        cip.inputCompression = context.rxVideoStreamManual0.isCompressionEnabled ? "JPEG-XS":"RAW";
                        cip.inputAudioPresent = status.audios[0].isPresent;
                        cip.inputAudio = this.calculateAudio(context.rxAudioStreamManual0)
                        cip.inputNoSignal = context.videoInSettings.noSignalOption
                        cip.inputSync = context.videoInSettings.syncType

                        cip.outputMode = context.txVideoStream0.selectPixelFormat
                        
                        cip.outputPresent = true
                        cip.outputCompression = context.txVideoStream0.isCompressionEnabled ? "JPEG-XS":"RAW";



                        cip.masterEnabled = context.StreamsEnableSettings.enable

                        if(context.txAudioStreamManual0.isIPMXEnabled && context.txVideoStreamManual0.isIPMXEnabled){
                            cip.flowMode = "ipmx";
                        }else if(context.txAudioStreamManual0.isIPMXEnabled == false && context.txVideoStreamManual0.isIPMXEnabled == false){
                            cip.flowMode = "st2110";
                        }else{
                            cip.flowMode = "mixed";
                        }

                        if(context.RxMonitorEdidHeader && context.RxMonitorEdidHeader.isHeaderValid){
                            cip.edidMonitor = context.RxMonitorEdidHeader.monitorName
                            cip.edidNativeResMonitor = context.RxMonitorEdidHeader.nativeResolution
                        }else{
                            cip.edidMonitor = "Not connected"
                            cip.edidNativeResMonitor = ""
                            if(!cip.hasEdid){
                                cip.edidMonitor = "-";
                            }
                        }
                        
                        if(context.videoInSettings.isEdidOverrideEnabled){
                            if(context.videoInSettings.selectEdid == "passthrough"){
                                if(context.TxPasstroughEdidHeader.isHeaderValid){
                                    cip.edidInput = context.TxPasstroughEdidHeader.monitorName
                                    cip.edidNativeResInput = context.TxPasstroughEdidHeader.nativeResolution
                                }else{
                                    cip.edidInput = "Not available"
                                    cip.edidNativeResInput = ""
                                }
                            }else{
                                if(context.TxCustomEdidHeader.isHeaderValid){
                                    cip.edidInput = context.TxCustomEdidHeader.monitorName
                                    cip.edidNativeResInput = context.TxCustomEdidHeader.nativeResolution
                                }else{
                                    cip.edidInput = "Not available"
                                    cip.edidNativeResInput = ""
                                }
                            }

                        }else{
                            cip.edidInput = "Native Matrox"
                            cip.edidNativeResInput = ""
                            if(!cip.hasEdid){
                                cip.edidInput = "-";
                            }
                        }



                        cip.frontpanelLock = context.otherSettings.areButtonsLocked;
                        cip.hdcpEnabled = context.hdcpSettings.enableHdcpSupport;

                        // Parse IGMP version from otherSettings
                        if (context.otherSettings && context.otherSettings.igmpVersion) {
                            cip.igmpVersion = context.otherSettings.igmpVersion;
                            SyncLog.log("debug", "MatroxCIP", `Device ${sn}: IGMP version: ${cip.igmpVersion}`);
                        } else {
                            cip.igmpVersion = "none";
                            SyncLog.log("debug", "MatroxCIP", `Device ${sn}: No IGMP version found, defaulting to none`);
                        }

                        cip.ptpDomain = context.ptpSettings.domain;
                        cip.ptpEnabled = context.ptpSettings.isEnabled;

                        // Parse multiviewer settings
                        if(context.MultiviewSettings && typeof context.MultiviewSettings.isMultiviewEnabled === 'boolean'){
                            cip.isMultiviewEnabled = context.MultiviewSettings.isMultiviewEnabled;
                            SyncLog.log("debug", "MatroxCIP", `Device ${sn}: Multiviewer enabled: ${cip.isMultiviewEnabled}`);
                        } else {
                            cip.isMultiviewEnabled = false;
                            SyncLog.log("debug", "MatroxCIP", `Device ${sn}: No multiviewer settings found, defaulting to false`);
                        }

                        // Parse audio stream settings
                        try {
                            // Get TX audio stream 0 settings
                            if(context.txAudioStream0){
                                cip.txAudioStream0Enabled = context.txAudioStream0.enable || false;
                                SyncLog.log("debug", "MatroxCIP", `Device ${sn}: TX Audio Stream 0 enabled: ${cip.txAudioStream0Enabled}`);
                            } else {
                                cip.txAudioStream0Enabled = false;
                            }

                            // Get RX audio stream 0 settings  
                            if(context.rxAudioStream0){
                                cip.rxAudioStream0Enabled = context.rxAudioStream0.enable || false;
                                SyncLog.log("debug", "MatroxCIP", `Device ${sn}: RX Audio Stream 0 enabled: ${cip.rxAudioStream0Enabled}`);
                            } else {
                                cip.rxAudioStream0Enabled = false;
                            }
                        } catch(audioError) {
                            SyncLog.log("warning", "MatroxCIP", `Device ${sn}: Could not parse audio stream settings: ${audioError.message}`);
                            cip.txAudioStream0Enabled = false;
                            cip.rxAudioStream0Enabled = false;
                        }

                        
                    }catch(e){
                        SyncLog.log("error","MatroxCIP", "Can not parse Context for:  "+ ipList.join(", "), e);
                        cip.failed = true,
                        cip.error = "Can not parse Context.";
                    }

                
                    
                    try{
                        if(cip.direction == "tx"){
                            cip.inputResolution = this.calculateResolution(status.videos[0]);
                            cip.outputResolution = this.calculateResolution(status.frameBuffer);
                            cip.inputPresent = status.videos[0].isPresent
                            cip.inputBitrate = 0  // TX devices take HDMI input, not IP
                            cip.outputBitrate = status.videoStreams[0].bitrateKbits/1000  // IP output stream bitrate
                        }else{
                            cip.inputResolution = this.calculateResolution(status.frameBuffer);
                            // TODO why is the data so strange in the device...
                            // Expected resolution is not the actual resolution
                            // Videos 0 seems to be exact output pixel format
                            //cip.outputResolution = cip.monitorResolution;
                            cip.outputResolution = this.calculateResolution(status.videos[0]);
                            cip.inputPresent = status.frameBuffer.resolution.isPresent
                            cip.inputBitrate = status.videoStreams[0].bitrateKbits/1000  // IP input stream bitrate
                            cip.outputBitrate = 0  // RX devices output HDMI, not IP
                        }
                    }catch(e){
                        SyncLog.log("error","MatroxCIP", "Can not parse Status for:  "+ ipList.join(", "), e);
                        cip.failed = true,
                        cip.error = "Can not parse Status.";
                    }

                    cip.ptpStatus = status.ptpState;
                    cip.temperature = status.temperature;

                    
                    cip.monitorResolution = this.calculateResolution(status.videos[0])

                    cip.linkStatus = [];
                    status.networks.forEach((inter,i)=>{
                        let link:MatroxConvertIpInterface = {
                            name:"", up:false, ip:"", speed:""
                        }
                        if(i == 0){
                            link.name = "OOB"
                        }else if(i == 1){
                            link.name = "MEDIA 1"
                        }else if(i == 2){
                            link.name = "MEDIA 2"
                        }else{
                            link.name = "eth "+ i;
                        }

                        if(inter.state == "disconnected"){
                            link.up = false; 
                        }else{
                            link.up = true;
                            link.speed = inter.state
                        }
                        link.ip = inter.ipv4Address;

                        cip.linkStatus.push(link)

                    })
                    
                }else{
                    cip.failed = true,
                    cip.error = "Can not Load from Context and Status.";
                }
            }
            cip.error = "";
        cip.failed = false;
        cip.loading = false;

        }catch(e){
            cip.loading = false;
            cip.failed = true;
            cip.error = e.message;
            if (axios.isAxiosError(e)) {
                if(e.code == "ETIMEDOUT"){
                    e.message = "Timeout"
                }
                cip.unreachable = true;
            }
        }

        if(cip.outdated){
            cip.outdated = false;
            this.reloadData(ipList,sn,cip);
        }else{
            this.syncList.setState(this.state);
        }

        this.updateQuickState();
        this.saveState();
        this.simultanLoading--;
    }


    async apiRequest(ipList:string[], sn:string ,method:"POST"|"GET", href:string, data:any={}, force = false){
        let baseUrl = "";
        let ip = "";

        for(let ipt of ipList){

            baseUrl = "https://"+ipt+":443";
            let url = baseUrl + "/device/caps";
            let result = await axios.get(url, {httpsAgent:this.httpsAgent, timeout:10000});
            ip = ipt;

            let caps = result.data
            // Safety check to ensure device exists before setting properties
            if(this.state.devices[sn]) {
                this.state.devices[sn].jpegxsLicensed = caps.isJpegxsLicenseInstalled
                this.state.devices[sn].safeMode = caps.isSafeMode
                this.state.devices[sn].goldenMode = caps.isGolden
            } else {
                SyncLog.log("warning", "MatroxCIP", `Device ${sn} not found in state during apiRequest caps update`);
            }

            break;
        }
        if(baseUrl == ""){
            SyncLog.log("error","MatroxCIP", "No connection possible to: "+ ipList.join(", "));
            return null;
        }
        let duplicate = false

        let doLogin = async (sn:string)=>{

            let user = this.config.user
            let password = this.config.password

            this.config.manualDevices.forEach((d)=>{
                if(d.hasOwnProperty("auth")){
                    if(d.hasOwnProperty("sn")){
                        if(d.sn == sn){        
                            user = d.auth.user;
                            password = d.auth.password;
                        }
                    }else{
                        if(d.hasOwnProperty("ipList")){
                            let matched = false;
                            ipList.forEach((ip1)=>{
                                d.ipList.forEach((ip2)=>{
                                    if(ip1==ip2){
                                        matched = true;
                                    }
                                })
                            })
                            if(matched){
                                user = d.auth.user;
                                password = d.auth.password;
                            }
                            
                        }
                    }
                }
            })

            try{
                let url = baseUrl + "/user/login";
                let result = await axios.post(url, {
                    username:user,
                    password:password,
                    closeExistingSessions: String(this.config.closeExistingSessions || force)
                }, {httpsAgent:this.httpsAgent});
                
                // Store both bearer token and session cookie (like test-multiview-post.js)
                let sessionCookie = '';
                if (result.headers['set-cookie']) {
                    sessionCookie = result.headers['set-cookie'].map(cookie => cookie.split(';')[0]).join('; ');
                }
                
                this.authState[sn] = {
                    bearerToken: result.data.access_token,
                    sessionCookie: sessionCookie
                };
                
            }catch(e){ 
                if(isAxiosError(e)){
                    if(e.response?.data?.code == 18){
                        // duplicate session
                        SyncLog.log("warning", "MatroxCIP", "Session Conflict while login: " + ip)
                        duplicate = true;
                        throw new Error("Other Session active")
                    }else{
                        SyncLog.log("error","MatroxCIP", "Auth not possible: "+ ipList.join(", "),e.response.data);
                        throw new Error(e.response.data.message);
                    }
                }else{
                    throw new Error(e.message);
                }
            }
        }

        if(!this.authState.hasOwnProperty(sn)){
            try{
                await doLogin(sn);
            }catch(e){
                throw new Error("Auth not possible: "+e.message);
            }
        }

        if(this.authState.hasOwnProperty(sn)){
            let url = baseUrl + href;
            try{    
                let result:any = {};
                const auth = this.authState[sn];
                const authHeaders = typeof auth === 'string' 
                    ? { Authorization: `Bearer ${auth}`, Cookie: `session_token=${auth}` }
                    : { Authorization: `Bearer ${auth.bearerToken}`, Cookie: auth.sessionCookie };
                    
                if(method == "GET" ){
                    result = await axios.get(url, {
                        headers: { ...authHeaders },
                        httpsAgent:this.httpsAgent
                    });
                }else if(method == "POST"){
                    result = await axios.post(url, data, {
                        headers: { ...authHeaders },
                        httpsAgent:this.httpsAgent
                    });
                }
                return result.data;
            }catch(e){ 
                if(e.response?.status == 401){
                    // Check if auto-reauthentication is disabled
                    if(this.config.disableAutoReauth) {
                        SyncLog.log("info", "MatroxCIP", `Auto-reauthentication disabled for device ${sn}, skipping login retry to preserve manual web UI sessions`);
                        throw new Error("Authentication expired and auto-reauthentication is disabled");
                    }
                    
                    // Login expired...
                    try{
                        await doLogin(sn);
                    }catch(e){
                        throw new Error("Auth not possible: "+e.message);
                    }
                    if(this.authState.hasOwnProperty(sn)){
                        try{    
                            let url = baseUrl + href;
                            let result:any = {};
                            const auth = this.authState[sn];
                            const authHeaders = typeof auth === 'string' 
                                ? { Authorization: `Bearer ${auth}`, Cookie: `session_token=${auth}` }
                                : { Authorization: `Bearer ${auth.bearerToken}`, Cookie: auth.sessionCookie };
                                
                            if(method == "GET" ){
                                result = await axios.get(url, {
                                    headers: { ...authHeaders },
                                    httpsAgent:this.httpsAgent
                                });
                            }else if(method == "POST"){
                                result = await axios.post(url, data, {
                                    headers: { ...authHeaders },
                                    httpsAgent:this.httpsAgent
                                });
                            }
                            return result.data;
                        }catch(e){ 
                            throw new Error("Can not get Data: "+e.message);
                        }
                    }else{
                        SyncLog.log("error","MatroxCIP", "Auth not possible: "+ ipList.join(", "));
                        throw new Error("Auth not possible.");
                    }
                }else{
                    SyncLog.log("error","MatroxCIP", "Can not access data on: "+ url,e);
                    if(isAxiosError(e) && e.response?.data){
                        throw new Error(`API Error: ${e.response.data.message || JSON.stringify(e.response.data)}`);
                    } else {
                        throw new Error(`Network Error: ${e.message || 'Unknown network error'}`);
                    }
                }
            }
        }else{
            SyncLog.log("error","MatroxCIP", "Auth not possible: "+ ipList.join(", "));
            throw new Error("Auth not possible.")
        }

        if(duplicate){
            throw new Error("Other Session active")
        }else{
            throw new Error("Unknown error - this should not be reached")
        }


    }




    async apiUploadFile(ipList:string[], sn:string , href:string, fileName:string, file:string){
        let baseUrl = "";
        let ip = "";

        for(let ipt of ipList){
            try{
                baseUrl = "https://"+ipt+":443";
                let url = baseUrl + "/device/caps";
                let result = await axios.get(url, {httpsAgent:this.httpsAgent});
                ip = ipt;
                break;
            }catch(e){ 
                // TODO Logging
                //console.log(e)
            }
        }
        if(baseUrl == ""){
            SyncLog.log("error","MatroxCIP", "No connection possible to: "+ ipList.join(", "));
            return null;
        }

        if(this.authState.hasOwnProperty(sn)){
            try{    
                let url = baseUrl + href;
                let result:any = {};
                const auth = this.authState[sn];
                const authHeaders = typeof auth === 'string' 
                    ? { Authorization: `Bearer ${auth}`, Cookie: `session_token=${auth}` }
                    : { Authorization: `Bearer ${auth.bearerToken}`, Cookie: auth.sessionCookie };

                const formData = new FormData();
                formData.append(fileName, file);
                
                result = await axios.post(url, formData, {
                    headers:{
                        ...authHeaders,
                        ...formData.getHeaders()
                    },
                    httpsAgent:this.httpsAgent
                });
                return result.data;
            }catch(e){ 
                SyncLog.log("error","MatroxCIP", "Upload failed: "+ e.message);
                return null;
            }
        }else{
            SyncLog.log("error","MatroxCIP", "Auth not possible: "+ ipList.join(", "));
            return null;
        }
    }
}



