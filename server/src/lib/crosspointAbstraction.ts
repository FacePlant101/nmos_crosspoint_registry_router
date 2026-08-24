import { SyncObject } from "./SyncServer/syncObject";
import { LoggedError, SyncLog } from "./syncLog";
import { error } from "console";
import { NmosRegistryConnector } from "./nmosConnector";
import { ConnectionLatencyMeasurement, LatencyTimingContext } from "./connectionLatencyMeasurement";
import { CrosspointOptimizedLookup } from "./crosspointOptimizedLookup";
import { ParallelNmosConnector } from "./parallelNmosConnector";
import { NmosHealthMonitor } from "./nmosHealthMonitor";
import { EnhancedPredictiveStaging } from "./enhancedPredictiveStaging";

import { setTimeout as sleep } from 'node:timers/promises'


const { Worker } = require('worker_threads');

const crypto = require('crypto');


const fs = require("fs");
const md5 = data => crypto.createHash('md5').update(data).digest("hex")

 export class CrosspointAbstraction {
    public static instance: CrosspointAbstraction | null;

    public syncCrosspoint: SyncObject;
    crosspointState: CrosspointState = {devices:[]};

    worker;

    // Internal subscribers that want to be notified when crosspointState updates
    private updateCallbacks: Array<(state: CrosspointState, prev: CrosspointState | null) => void> = [];

    // Optimized lookup service for O(1) device/flow lookups
    private optimizedLookup: CrosspointOptimizedLookup;
    healthMonitor: NmosHealthMonitor;
    predictiveStaging: EnhancedPredictiveStaging;



    startWorker(){
        SyncLog.info("crosspoint", "Starting Worker thread.");
        this.worker = new Worker(__dirname + '/crosspointUpdateThread.js');
        this.worker.on('message', (message)=>{
            let data = JSON.parse(message);
            this.updateReturn(data);
        });
        this.worker.on('error', (error)=>{
            SyncLog.error("crosspoint", "Error in Worker Thread: "+ error.message, error);
            // TODO crash on remote system "Error in Worker Thread: Cannot read properties of null (reading 'devices')" Analyze
        });

        this.worker.on('exit', (code)=>{
            if(code == 0){
                SyncLog.info("crosspoint", "Worker Thread exit with code: "+ code);
            }else{
                SyncLog.error("crosspoint", "Worker Thread exit with code: "+ code);
                setTimeout(()=>{this.startWorker()},1000);
            }
        });
    }

    
    executeConnectionPrepare(src:CrosspointFlow, dst:CrosspointFlow){
        return new Promise(async(resolve, reject) => {
            if(dst){
                let senderInfo:CrosspointConnectionSenderInfo|null = null;
                if(src){
                    SyncLog.log("info", "connect_crosspoint", "Stage (prepare): Receiver "+ dst.id + "    <   Sender " + src.id)
                    try{
                        if(src.id.startsWith("nmos_")){
                            let nmosId = src.id.slice(5);
                            senderInfo = await NmosRegistryConnector.instance.connectionGetSenderInfo(nmosId);
                        }
                    }catch(e){
                        reject({src:src,dst:dst,status:"failed sender info"});
                        return;
                    }
                }else{
                    SyncLog.log("info", "connect_crosspoint", "Stage (prepare): Receiver "+ dst.id + "    <   Disconnect")
                    senderInfo = {
                        senderId: "disconnect",
                        interfaces:[],
                        manifestFile:"",
                        active:false,
                        error:"",
                        transport:""
                    }
                }

                if(dst.id.startsWith("nmos_")){
                    try{
                        let nmosId = dst.id.slice(5);
                        let log = await NmosRegistryConnector.instance.makeConnection(nmosId,senderInfo,true);
                        if(senderInfo.senderId == "disconnect"){
                            resolve({src:src,dst:dst,status:"ok_staged_dis", detail:{message:"Staged",log:""+log}});
                        }else{
                            resolve({src:src,dst:dst,status:"ok_staged", detail:{message:"Staged",log:""+log}});
                        }
                    }catch(e){
                        if(e instanceof LoggedError){
                            reject({src:src,dst:dst,status:"failed", detail:{message:e.message, log:e.logId}});
                        }else{
                            reject({src:src,dst:dst,status:"failed", detail:{message:e.message, log:""}});
                        }
                    }
                }
            }else{
                let id = SyncLog.log("warning", "connect_crosspoint", "Prepare connect command without destination.")
                reject({src:src,dst:dst,status:"nc", detail:{message:"Destination missing",log:id}});
            }
        });
    }
    settings:any = {};
    constructor(config:any){
        this.settings = config;
        CrosspointAbstraction.instance = this;
        
        this.syncCrosspoint = new SyncObject("crosspoint", this.crosspointState);
        
        // Initialize optimized lookup service
        this.optimizedLookup = new CrosspointOptimizedLookup();
        
        // Initialize performance optimization services
        this.healthMonitor = NmosHealthMonitor.getInstance();
        this.predictiveStaging = EnhancedPredictiveStaging.getInstance();

        this.startWorker();
        // Don't call this.update() here - wait for first NMOS state to prevent 
        // initialization timing issues where existing connections are missed
    }

    nmosState: any = null;

    /**
     * Load aliases from NMOS description fields on startup
     */
    public loadNmosAliases(): void {
        if (!this.crosspointState || !this.nmosState) {
            return;
        }

        const aliasUpdates: { [key: string]: string } = {};

        // Check all devices for aliases in NMOS description fields
        for (const dev of this.crosspointState.devices) {
            if (dev.id.startsWith("nmos_")) {
                const nmosId = dev.id.slice(5);

                // Find the NMOS resource and extract alias from description
                const nmosResource = this.findNmosResource(nmosId);
                if (nmosResource && nmosResource.description && nmosResource.description.trim()) {
                    // Use description as alias if it looks like an alias (not default description)
                    const description = nmosResource.description.trim();
                    if (description && description !== dev.name && description !== nmosId) {
                        aliasUpdates[dev.id] = description;
                    }
                }

                // Also check senders and receivers for aliases
                for (const type of ['senders', 'receivers']) {
                    if (dev[type]) {
                        for (const flowType of Object.keys(dev[type])) {
                            for (const flow of dev[type][flowType]) {
                                if (flow.id.startsWith("nmos_")) {
                                    const flowNmosId = flow.id.slice(5);
                                    const flowResource = this.findNmosResource(flowNmosId);
                                    if (flowResource && flowResource.description && flowResource.description.trim()) {
                                        const description = flowResource.description.trim();
                                        if (description && description !== flow.name && description !== flowNmosId) {
                                            aliasUpdates[flow.id] = description;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Send alias updates to worker thread
        if (Object.keys(aliasUpdates).length > 0) {
            this.worker.postMessage(JSON.stringify({
                loadNmosAliases: aliasUpdates
            }));
            SyncLog.log("info", "alias", `Loaded ${Object.keys(aliasUpdates).length} aliases from NMOS description fields`);
        }
    }

    public async migrateExistingAliasesToNmos(): Promise<void> {
        if (!this.crosspointState || !this.nmosState) {
            return;
        }

        // Request current alias state from worker thread
        return new Promise((resolve) => {
            const requestId = Math.random().toString(36).substring(7);

            // Set up listener for response
            const messageHandler = (event: MessageEvent) => {
                try {
                    const data = JSON.parse(event.data);
                    if (data.aliasStateResponse && data.requestId === requestId) {
                        this.worker.removeEventListener('message', messageHandler);
                        this.processAliasMigration(data.aliasState).then(resolve);
                    }
                } catch (e) {
                    // Ignore parsing errors
                }
            };

            this.worker.addEventListener('message', messageHandler);

            // Request alias state
            this.worker.postMessage(JSON.stringify({
                requestAliasState: { requestId }
            }));

            // Timeout after 5 seconds
            setTimeout(() => {
                this.worker.removeEventListener('message', messageHandler);
                resolve();
            }, 5000);
        });
    }

    public async migrateExistingAliasesToNmosOnce(): Promise<void> {
        const fs = require('fs');
        const path = require('path');
        const migrationFlagFile = './state/alias_migration_completed.flag';

        // Check if migration has already been completed
        if (fs.existsSync(migrationFlagFile)) {
            SyncLog.log("debug", "alias", "Alias migration already completed, skipping");
            return;
        }

        // Run the migration
        await this.migrateExistingAliasesToNmos();

        // Create flag file to prevent future migrations
        try {
            fs.writeFileSync(migrationFlagFile, new Date().toISOString());
            SyncLog.log("info", "alias", "Alias migration completed and flagged - will not run again");
        } catch (error) {
            SyncLog.log("warning", "alias", `Failed to create migration flag file: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async processAliasMigration(aliasState: { [key: string]: string }): Promise<void> {
        let migratedCount = 0;
        let errorCount = 0;

        SyncLog.log("info", "alias", `Starting migration of ${Object.keys(aliasState).length} existing aliases to NMOS description fields`);

        
        // Process each alias
        for (const [id, alias] of Object.entries(aliasState)) {
            try {
                await this.updateNmosAlias(id, alias);
                migratedCount++;
                SyncLog.log("debug", "alias", `Migrated alias for ${id}: "${alias}"`);
            } catch (error) {
                errorCount++;
                SyncLog.log("warning", "alias", `Failed to migrate alias for ${id}: ${error instanceof Error ? error.message : String(error)}`);
            }
            
            // Small delay to avoid overwhelming NMOS registries
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        if (migratedCount > 0 || errorCount > 0) {
            SyncLog.log("info", "alias", `Alias migration complete: ${migratedCount} migrated, ${errorCount} failed`);
        }
    }

    private findNmosResource(nmosId: string): any {
        if (!this.nmosState) {
            return null;
        }
        
        // Search in devices, senders, receivers, sources, and flows
        const resourceTypes = ['devices', 'senders', 'receivers', 'sources', 'flows'];
        
        for (const resourceType of resourceTypes) {
            if (this.nmosState[resourceType] && this.nmosState[resourceType][nmosId]) {
                return this.nmosState[resourceType][nmosId];
            }
        }
        
        return null;
    }

    private checkIs13Support(): void {
        if (!NmosRegistryConnector.instance) {
            return;
        }
        
        const is13Summary = NmosRegistryConnector.instance.getIs13SupportSummary();
        
        if (is13Summary.totalDevices === 0) {
            SyncLog.log("info", "nmos_alias", "No NMOS devices discovered yet");
            return;
        }
        
        if (is13Summary.supportedDevices.length === 0) {
            SyncLog.log("info", "nmos_alias", `IS-13 annotation support: 0/${is13Summary.totalDevices} devices support NMOS alias persistence`);
        } else {
            SyncLog.log("info", "nmos_alias", `IS-13 annotation support: ${is13Summary.supportedDevices.length}/${is13Summary.totalDevices} devices support NMOS alias persistence`);
            
            // List supported devices
            for (const device of is13Summary.supportedDevices) {
                SyncLog.log("info", "nmos_alias", `  ✓ ${device.label} supports IS-13 annotation`, { deviceId: device.id, serviceUrl: device.serviceUrl });
            }
        }
    }

    getFlowInfo(flowId: string) {
        try {
            let manifest: any = null;
            if (flowId.startsWith("nmos_")) {
                let id = flowId.slice(5);
                manifest = this.nmosState.sendersManifestDetail[id];
            }
            for (let dev of this.crosspointState.devices) {
                for (let type of Object.keys(dev.senders)) {
                    for (let flow of dev.senders[type]) {
                        if (flow.id == flowId) {
                            return {
                                flow: flow,
                                manifest: manifest
                            };
                        }
                    }
                }
            }
        } catch (e) { }
        return null;
    }

    enableFlow(id: string, disable = false) {
        return new Promise((resolve, reject) => {
            if (id.startsWith("nmos_")) {
                let nmosId = id.slice(5);
                NmosRegistryConnector.instance.enableFlow(nmosId, disable);
            }
            resolve({});
        });
    }

    setMulticast(id: string, data: any) {
        return new Promise((resolve, reject) => {
            if(id.startsWith("nmos_")){
                let nmosId = id.slice(5);
                NmosRegistryConnector.instance.setFlowMulticast(nmosId,data);
            } 
            resolve({});
        });
    }

    
    crosspointApi(data:any){
        return new Promise((resolve, reject) => {
            this.worker.postMessage(JSON.stringify({
                crosspointChanges:data
            }));
            // TODO feedback.....
            resolve({});
        });
    }


    changeAlias(id:string, alias:string){
        return new Promise(async (resolve, reject) => {
            // First update local storage (existing behavior)
            this.worker.postMessage(JSON.stringify({
                changeAlias:{id:id, alias:alias}
            }));
            
            // Then attempt to persist to NMOS description field
            try {
                await this.updateNmosAlias(id, alias);
            } catch (error) {
                SyncLog.log("warning", "alias", `Failed to persist alias to NMOS: ${error instanceof Error ? error.message : String(error)}`);
                // Continue anyway - local storage still works
            }
            
            resolve({});
        });
    }
    
    /**
     * Update NMOS description field with alias for persistent storage
     */
    private async updateNmosAlias(id: string, alias: string): Promise<void> {
        if (!NmosRegistryConnector.instance) {
            return;
        }
        
        // Determine resource type and ID from crosspoint ID format
        if (id.startsWith("nmos_")) {
            const nmosId = id.slice(5);
            
            // Check what type of resource this is by looking in nmosState
            const nmosState = NmosRegistryConnector.instance.getNmosState();
            
            if (nmosState.devices[nmosId]) {
                await NmosRegistryConnector.instance.updateNmosDescription("devices", nmosId, alias);
            } else if (nmosState.senders[nmosId]) {
                await NmosRegistryConnector.instance.updateNmosDescription("senders", nmosId, alias);
            } else if (nmosState.receivers[nmosId]) {
                await NmosRegistryConnector.instance.updateNmosDescription("receivers", nmosId, alias);
            } else if (nmosState.sources[nmosId]) {
                await NmosRegistryConnector.instance.updateNmosDescription("sources", nmosId, alias);
            } else if (nmosState.flows[nmosId]) {
                await NmosRegistryConnector.instance.updateNmosDescription("flows", nmosId, alias);
            }
        }
    }

    toggleHidden(id:string){
        return new Promise((resolve, reject) => {
            this.worker.postMessage(JSON.stringify({
                toggleHidden:{id:id}
            }));
            resolve({});
        });
    }

    // Allow modules (e.g., PredictiveStager) to subscribe to crosspoint updates
    public registerUpdateCallback(cb: (state: CrosspointState, prev: CrosspointState | null) => void) {
        try{
            if(typeof cb === 'function'){
                this.updateCallbacks.push(cb);
            }
        }catch(e){}
    }

    // Check if a device is a multiview decoder by counting video receiver flows
    private isDeviceMultiviewDecoder(device: CrosspointDevice): boolean {
        try {
            console.log(`[DEBUG] isDeviceMultiviewDecoder called for device:`, {
                name: device.name,
                alias: device.alias,
                num: device.num
            });
            
            // Simple and reliable approach: multiviewer devices typically have exactly 4 video receiver flows
            const videoReceiverFlows = this.optimizedLookup.findReceiverFlows(device.id, 'video');
            const flowCount = videoReceiverFlows.length;
            
            console.log(`[DEBUG] Device has ${flowCount} video receiver flows`);
            
            // If device has exactly 4 video receiver flows, it's likely a multiviewer
            const isMultiviewer = flowCount === 4;
            
            console.log(`[DEBUG] Multiviewer detection result: ${isMultiviewer} (based on flow count)`);
            return isMultiviewer;
            
        } catch (error) {
            console.log(`[DEBUG] Error in isDeviceMultiviewDecoder:`, error);
            return false;
        }
    }

    makeConnection(data:any){
        return new Promise(async(resolve, reject) => {
            // Debug logging to track makeConnection calls
            console.log("[DEBUG] makeConnection called with:", JSON.stringify(data, null, 2));

            // Start latency measurement
            const latencyMeasurement = ConnectionLatencyMeasurement.getInstance();
            let timingContext: LatencyTimingContext | null = null;

            let preview = false; // default to immediate activation unless explicitly preview/prepare
            let prepare = false;
            const toBool = (v:any) => v === true || v === 'true' || v === 1 || v === '1';
            let list = [];
            if(data.hasOwnProperty("multiple")){
                list = data.multiple;
            }else{
                if(data.hasOwnProperty("source") && data.hasOwnProperty('destination')){
                    list = [{source:data.source+"", destination:data.destination+""}]
                }
            }

            if(data.hasOwnProperty("preview")){
                preview = toBool(data.preview);
            }
            if(data.hasOwnProperty("prepare")){
                prepare = toBool(data.prepare);
                if(prepare) preview = false;
            }

            const mode = prepare ? "prepare" : (preview ? "preview" : "immediate");
            SyncLog.log("info", "connect_crosspoint", "makeConnection mode", { preview, prepare, mode });

            // Initialize timing context for first connection in list
            if (list.length > 0) {
                const firstConnection = list[0];
                timingContext = latencyMeasurement.startConnectionTiming({
                    sourceId: firstConnection.source,
                    destinationId: firstConnection.destination,
                    mode: mode as 'immediate' | 'prepare' | 'preview'
                });
            }


            let connections = [];


            list.forEach((c)=>{
                let source = c.source+""
                let destination = c.destination+""
                let disconnect = false
                if(source == "" || source =="__disconnect"){
                    // Disconnect
                    disconnect = true
                }
                
                console.log("[DEBUG] Processing connection:", {source, destination, disconnect});

                let srcFlows:any[] = [];
                let dstFlows:any[] = [];

                // Select all source Flows
                let sourceDevice = null;
                let sourceDeviceOnly = false;
                let sourceFlowType = "";
                let sourceFlow = null;
                let sourceParts = source.split(".");
                let srcDev = null
                sourceDevice = sourceParts[0]
                if(sourceParts.length == 2){
                    sourceFlow = sourceParts[1].slice(1);
                    switch(sourceParts[1][0]){
                        case "v":
                            sourceFlowType = "video"
                            break;
                        case "a":
                            sourceFlowType = "audio"
                            break;
                        case "d":
                            sourceFlowType = "data"
                            break;
                        default:
                            sourceFlowType = "unknown"
                    }
                }else{
                    sourceDeviceOnly = true;
                }

                console.log("[DEBUG] Looking for source device:", {sourceDevice, sourceFlowType, sourceFlow, sourceDeviceOnly});
                console.log("[DEBUG] Available devices:", this.crosspointState.devices.map(d => ({num: d.num, name: d.name, alias: d.alias})));
                
                // 1) Try direct NMOS flow-id addressing (e.g., 'nmos_<sender_id>') - OPTIMIZED
                let matchedByNmosIdSrc = false;
                if(source.startsWith("nmos_")){
                    const flow = this.optimizedLookup.findFlow(source);
                    if(flow){
                        // Find the device that contains this flow
                        for(const dev of this.crosspointState.devices){
                            for(const type of Object.keys(dev.senders)){
                                const arr:any[] = (dev.senders as any)[type] || [];
                                if(arr.some(f => f.id === source)){
                                    srcDev = dev;
                                    srcFlows.push(flow);
                                    matchedByNmosIdSrc = true;
                                    console.log("[DEBUG] Matched source by NMOS id (OPTIMIZED):", {dev: {num: dev.num, name: dev.name, alias: dev.alias}, flowId: flow.id});
                                    break;
                                }
                            }
                            if(matchedByNmosIdSrc) break;
                        }
                    }
                }

                // 2) Fallback to name/alias/num based addressing - OPTIMIZED
                if(!matchedByNmosIdSrc){
                    // Use optimized O(1) device lookup instead of O(n) loop
                    const dev = this.optimizedLookup.findDevice(sourceDevice);
                    if(dev){
                        console.log("[DEBUG] Found matching source device (OPTIMIZED):", {num: dev.num, name: dev.name, alias: dev.alias});
                        srcDev = dev;
                        
                        if(sourceDeviceOnly){
                            // Get only video sender flows for device-level patching (not audio)
                            srcFlows.push(...this.optimizedLookup.findSenderFlows(dev.id, "video"));
                            console.log("[DEBUG] Added video sender flows for device-level patching (OPTIMIZED):", srcFlows.length);
                        } else if(sourceFlowType && sourceFlow){
                            // Get specific flow using optimized lookup
                            // Handle stream indexing - check if device is a multiview decoder
                            let hwStreamIndex = parseInt(sourceFlow);
                            
                            // For multiview decoders, UI sends 0-based stream numbers directly (0, 1, 2, 3)
                            // For other devices, UI sends 1-based stream numbers (1, 2, 3) that need conversion to 0-based
                            const isMultiviewDecoder = srcDev && this.isDeviceMultiviewDecoder(srcDev);
                            if (!isMultiviewDecoder) {
                                // Convert from 1-based UI numbering (v.1) to 0-based hardware indexing (stream 0)
                                hwStreamIndex = hwStreamIndex - 1;
                            }
                            
                            console.log("[DEBUG] Stream indexing for source:", {
                                sourceFlow, 
                                isMultiviewDecoder, 
                                hwStreamIndex,
                                deviceName: srcDev?.name,
                                deviceAlias: srcDev?.alias
                            });
                            
                            const flow = this.optimizedLookup.findFlowByDeviceAndNum(dev.id, hwStreamIndex);
                            if(flow && (flow.type === sourceFlowType || sourceFlowType === "unknown")){
                                srcFlows.push(flow);
                                console.log("[DEBUG] Added specific source flow (OPTIMIZED):", {type: flow.type, flowNum: flow.num, flowId: flow.id});
                            } else {
                                // Fallback: get flows by type
                                srcFlows.push(...this.optimizedLookup.findSenderFlows(dev.id, sourceFlowType));
                                console.log("[DEBUG] Added sender flows by type (OPTIMIZED):", {type: sourceFlowType, count: srcFlows.length});
                            }
                        } else if(sourceFlowType){
                            // Get flows by type only
                            srcFlows.push(...this.optimizedLookup.findSenderFlows(dev.id, sourceFlowType));
                            console.log("[DEBUG] Added sender flows by type (OPTIMIZED):", {type: sourceFlowType, count: srcFlows.length});
                        }
                    }
                }
                console.log("[DEBUG] Source device search complete:", {srcDev: srcDev ? {num: srcDev.num, name: srcDev.name} : null, srcFlowsCount: srcFlows.length});


                // Select all destination Flows
                let destinationDevice = null;
                let destinationDeviceOnly = false;
                let destinationFlowType = "";
                let destinationFlow = null;
                let destinationParts = destination.split(".");
                let dstDev = null;
                destinationDevice = destinationParts[0]
                if(destinationParts.length == 2){
                    destinationFlow = destinationParts[1].slice(1);
                    switch(destinationParts[1][0]){
                        case "v":
                            destinationFlowType = "video"
                            break;
                        case "a":
                            destinationFlowType = "audio"
                            break;
                        case "d":
                            destinationFlowType = "data"
                            break;
                        default:
                            destinationFlowType = "unknown"
                    }
                }else{
                    destinationDeviceOnly = true;
                }

                console.log("[DEBUG] Looking for destination device:", {destinationDevice, destinationFlowType, destinationFlow, destinationDeviceOnly});
                
                // 1) Try direct NMOS flow-id addressing (e.g., 'nmos_<receiver_id>') - OPTIMIZED
                let matchedByNmosIdDst = false;
                if(destination.startsWith("nmos_")){
                    const flow = this.optimizedLookup.findFlow(destination);
                    if(flow){
                        // Find the device that contains this flow
                        for(const dev of this.crosspointState.devices){
                            for(const type of Object.keys(dev.receivers)){
                                const arr:any[] = (dev.receivers as any)[type] || [];
                                if(arr.some(f => f.id === destination)){
                                    dstDev = dev;
                                    dstFlows.push(flow);
                                    matchedByNmosIdDst = true;
                                    console.log("[DEBUG] Matched destination by NMOS id (OPTIMIZED):", {dev: {num: dev.num, name: dev.name, alias: dev.alias}, flowId: flow.id});
                                    break;
                                }
                            }
                            if(matchedByNmosIdDst) break;
                        }
                    }
                }

                // 2) Fallback to name/alias/num based addressing - OPTIMIZED
                if(!matchedByNmosIdDst){
                    // Use optimized O(1) device lookup instead of O(n) loop
                    const dev = this.optimizedLookup.findDevice(destinationDevice);
                    if(dev){
                        console.log("[DEBUG] Found matching destination device (OPTIMIZED):", {num: dev.num, name: dev.name, alias: dev.alias});
                        dstDev = dev;
                        
                        if(destinationDeviceOnly){
                            // Get only video receiver flows for device-level patching (not audio)
                            const allReceiverFlows = this.optimizedLookup.findReceiverFlows(dev.id, "video");
                            
                            // Filter out flows that are not available in NMOS to prevent batch failures
                            const nmosState = NmosRegistryConnector.instance.getNmosState();
                            const availableFlows = allReceiverFlows.filter(flow => {
                                if (!flow.id.startsWith("nmos_")) return false;
                                const nmosId = flow.id.substring(5); // Remove "nmos_" prefix
                                const isAvailable = nmosState && nmosState.receivers && nmosState.receivers.hasOwnProperty(nmosId);
                                if (!isAvailable) {
                                    console.log("[DEBUG] Filtering out unavailable NMOS receiver:", {flowId: flow.id, nmosId});
                                }
                                return isAvailable;
                            });
                            
                            dstFlows.push(...availableFlows);
                            console.log("[DEBUG] Added video receiver flows for device-level patching (OPTIMIZED):", {
                                total: allReceiverFlows.length,
                                available: availableFlows.length,
                                filtered: allReceiverFlows.length - availableFlows.length
                            });
                        } else if(destinationFlowType && destinationFlow){
                            // Get specific flow using optimized lookup
                            // Handle stream indexing - check if device is a multiview decoder
                            let hwStreamIndex = parseInt(destinationFlow);
                            
                            // For multiview decoders, UI sends 0-based stream numbers directly (0, 1, 2, 3)
                            // For other devices, UI sends 1-based stream numbers (1, 2, 3, 4) that need conversion to 0-based
                            const isMultiviewDecoder = dstDev && this.isDeviceMultiviewDecoder(dstDev);
                            
                            // For non-multiviewer devices, only allow .v1 connections
                            if (!isMultiviewDecoder && parseInt(destinationFlow) > 1) {
                                console.log("[DEBUG] Non-multiviewer device: ignoring flow request above v1:", {
                                    deviceName: dstDev?.name,
                                    deviceAlias: dstDev?.alias,
                                    requestedFlow: destinationFlow,
                                    message: 'Non-multiviewer devices only accept device-level connections or .v1'
                                });
                                // Skip processing this flow - effectively ignores .v2, .v3, .v4 for non-multiviewer devices
                            } else {
                                if (!isMultiviewDecoder) {
                                    // Convert from 1-based UI numbering (v.1) to 0-based hardware indexing (stream 0)
                                    hwStreamIndex = hwStreamIndex - 1;
                                }
                                
                                console.log("[DEBUG] Stream indexing for destination:", {
                                    destinationFlow, 
                                    isMultiviewDecoder, 
                                    hwStreamIndex,
                                    deviceName: dstDev?.name,
                                    deviceAlias: dstDev?.alias,
                                    originalIndex: parseInt(destinationFlow),
                                    indexConversion: isMultiviewDecoder ? 'none (multiviewer mode)' : '1-based to 0-based (regular mode)'
                                });
                                
                                const flow = this.optimizedLookup.findFlowByDeviceAndNum(dev.id, hwStreamIndex);
                                if(flow && (flow.type === destinationFlowType || destinationFlowType === "unknown")){
                                    dstFlows.push(flow);
                                    console.log("[DEBUG] Added specific destination flow (OPTIMIZED):", {type: flow.type, flowNum: flow.num, flowId: flow.id});
                                } else {
                                    // Fallback: get flows by type
                                    dstFlows.push(...this.optimizedLookup.findReceiverFlows(dev.id, destinationFlowType));
                                    console.log("[DEBUG] Added receiver flows by type (OPTIMIZED):", {type: destinationFlowType, count: dstFlows.length});
                                }
                            }
                        } else if(destinationFlowType){
                            // Get flows by type only
                            dstFlows.push(...this.optimizedLookup.findReceiverFlows(dev.id, destinationFlowType));
                            console.log("[DEBUG] Added receiver flows by type (OPTIMIZED):", {type: destinationFlowType, count: dstFlows.length});
                        }
                    }
                }
                console.log("[DEBUG] Destination device search complete:", {dstDev: dstDev ? {num: dstDev.num, name: dstDev.name} : null, dstFlowsCount: dstFlows.length});


                console.log("[DEBUG] Flow matching results:", {
                    srcFlowsCount: srcFlows.length,
                    dstFlowsCount: dstFlows.length,
                    disconnect,
                    willProcessConnection: (srcFlows.length > 0 || disconnect) && dstFlows.length > 0
                });
                
                if((srcFlows.length > 0 || disconnect) && dstFlows.length > 0){
                    
                        // Connection Matcher

                        // For Each dstFlow
                        //      find suitable SrcFlow
                        //      Type
                        //      Capabilities
                        //      Lowest NUM
                        for(let dstFlow of dstFlows){
                            let connection = {src:null,srcDev:srcDev, dst:dstFlow,dstDev:dstDev}
                            if(disconnect){
                                // src : null (explicit disconnect request)
                                connections.push(connection);
                                continue;
                            }
                            // Choose best matching source using optimized compatibility check with caching
                            let bestSrc:any = null;
                            for(let srcFlow of srcFlows){
                                // Use optimized compatibility check with caching
                                if(this.optimizedLookup.areFlowsCompatible(srcFlow, dstFlow)){
                                    if(bestSrc == null || (typeof srcFlow.num === "number" && typeof bestSrc.num === "number" && srcFlow.num < bestSrc.num)){
                                        bestSrc = srcFlow;
                                    }
                                }
                            }
                            // Alternative: use optimized findBestSender method
                            // bestSrc = this.optimizedLookup.findBestSender(dstFlow, srcFlows);
                            if(bestSrc){
                                connection.src = bestSrc;
                                connections.push(connection);
                            }else{
                                // No matching source for this destination; skip to avoid unintended disconnects
                                SyncLog.log("info", "connect_crosspoint", `No matching source for destination ${dstFlow.id}; skipping`);
                            }
                        }
                }

            });

            // Mark device resolution phase complete
            if (timingContext) {
                latencyMeasurement.markPhase(timingContext.connectionId, 'deviceResolution');
            }

            if(preview){
                let connectionPreviews = [];
                connections.forEach((c)=>{
                    connectionPreviews.push({src:(c.src?c.src.id:null),dst:c.dst.id, status:"preview"});
                });
                
                // Complete latency measurement for preview mode
                if (timingContext) {
                    latencyMeasurement.completeConnectionMeasurement(timingContext.connectionId, true);
                }
                
                resolve({connections:connectionPreviews});
            }else if(prepare){
                let stagePromises:any[] = [];
                let stageDisconnectPromises:any[] = [];
                let connectionResponses:any[] = [];

                // Stage connects
                connections.forEach((c)=>{
                    if(c.src){
                        stagePromises.push(this.executeConnectionPrepare(c.src,c.dst));
                    }
                });
                let results = await Promise.allSettled(stagePromises);
                results.forEach((r)=>{
                    if(r.status == "fulfilled"){ connectionResponses.push(r.value); }
                    else{ connectionResponses.push(r.reason); }
                });

                // Stage disconnects
                connections.forEach((c)=>{
                    if(!c.src){
                        stageDisconnectPromises.push(this.executeConnectionPrepare(c.src,c.dst));
                    }
                });
                results = await Promise.allSettled(stageDisconnectPromises);
                results.forEach((r)=>{
                    if(r.status == "fulfilled"){ connectionResponses.push(r.value); }
                    else{ connectionResponses.push(r.reason); }
                });

                // Complete latency measurement for prepare mode
                if (timingContext) {
                    const success = connectionResponses.every(r => r.status && (r.status.includes("ok") || r.status === "preview"));
                    latencyMeasurement.completeConnectionMeasurement(timingContext.connectionId, success);
                }

                resolve({connections:connectionResponses});
            }else{
                let connectionPromises = [];
                let disconnectPromises = [];
                let connectionResponses = [];

                // Connects - Use parallel processing for NMOS connections
                const nmosConnections = connections.filter(c => c.src && c.dst.id.startsWith("nmos_"));
                const nonNmosConnections = connections.filter(c => c.src && !c.dst.id.startsWith("nmos_"));
                
                // Process NMOS connections in parallel using ParallelNmosConnector
                if (nmosConnections.length > 0) {
                    const parallelConnector = ParallelNmosConnector.getInstance();
                    
                    // Group by sender for batch processing
                    const senderGroups = new Map<string, typeof nmosConnections>();
                    nmosConnections.forEach(conn => {
                        const senderId = conn.src!.id;
                        if (!senderGroups.has(senderId)) {
                            senderGroups.set(senderId, []);
                        }
                        senderGroups.get(senderId)!.push(conn);
                    });
                    
                    // Process each sender group in parallel
                    const parallelPromises = Array.from(senderGroups.entries()).map(async ([senderId, conns]) => {
                        const receiverIds = conns.map(c => c.dst.id);
                        const results = await parallelConnector.makeBatchConnection(senderId, receiverIds, false);
                        
                        return results.map((result, index) => {
                            const conn = conns[index];
                            if (result.success) {
                                return { src: conn.src, dst: conn.dst, status: "ok", detail: { message: "Success", log: result.logId } };
                            } else {
                                return { src: conn.src, dst: conn.dst, status: "failed", detail: { message: result.error, log: "" } };
                            }
                        });
                    });
                    
                    const parallelResults = await Promise.all(parallelPromises);
                    connectionPromises.push(...parallelResults.flat().map(result => Promise.resolve(result)));
                }
                
                // Process non-NMOS connections normally
                nonNmosConnections.forEach((c)=>{
                    if(c.src){
                        connectionPromises.push(this.executeConnection(c.src,c.dst,timingContext));
                    }
                });
                
                let results = await Promise.allSettled(connectionPromises);
                results.forEach((r)=>{
                    if(r.status == "fulfilled"){
                        connectionResponses.push(r.value);
                    }else{
                        connectionResponses.push(r.reason);
                    }
                })


                // Dsiconnects
                connections.forEach((c)=>{
                    if(!c.src){
                        disconnectPromises.push(this.executeConnection(c.src,c.dst,timingContext));
                    }
                });
                results = await Promise.allSettled(disconnectPromises);
                results.forEach((r)=>{
                    if(r.status == "fulfilled"){
                        connectionResponses.push(r.value);
                    }else{
                        connectionResponses.push(r.reason);
                    }
                })

                // Complete latency measurement for immediate mode
                if (timingContext) {
                    const success = connectionResponses.every(r => 
                        r.status && (r.status.startsWith('ok') || r.status === 'preview')
                    );
                    latencyMeasurement.completeConnectionMeasurement(timingContext.connectionId, success);
                    if (success && connections.length > 0 && connections[0].dst) {
                        latencyMeasurement.detectStreamActive(timingContext.connectionId, connections[0].dst.id);
                    }
                }

                resolve({connections:connectionResponses});
            }

            // Further TODOs
            // Get Source Info
            // SDP
            // Bitrate
            // Interfaces

            // Transform

            // Check Network
            // Check other ???

            // Send to destiantion (if not preview)
           
            
        });

    }


    executeConnection(src:CrosspointFlow,dst:CrosspointFlow, timingContext?: LatencyTimingContext){
        return new Promise(async(resolve, reject) => {
            if(dst){
                let senderInfo:CrosspointConnectionSenderInfo|null = null;
                if(src){
                    SyncLog.log("info", "connect_crosspoint", "Make Connect: Receiver "+ dst.id + "    <   Sender " + src.id)
                    try{
                        if(src.id.startsWith("nmos_")){
                            let nmosId = src.id.slice(5);
                            // Mark sender info retrieval start for latency measurement
                            const latencyMeasurement = ConnectionLatencyMeasurement.getInstance();
                            senderInfo = await NmosRegistryConnector.instance.connectionGetSenderInfo(nmosId);
                            // Mark sender info phase complete
                            if (timingContext) {
                                latencyMeasurement.markPhase(timingContext.connectionId, 'senderInfoRetrieved');
                            }
                        }
                        
                    }catch(e){
                        reject({src:src,dst:dst,status:"failed sender info"});
                    }
                }else{
                    SyncLog.log("info", "connect_crosspoint", "Make Connect: Receiver "+ dst.id + "    <   Disconnect")
                    senderInfo = {
                        senderId: "disconnect",
                        interfaces:[],
                        manifestFile:"",
                        active:false,
                        error:"",
                        transport:""
                    }
                }

                // TODO handle inactive Sender


                    
                if(dst.id.startsWith("nmos_")){
                    try{
                        let nmosId = dst.id.slice(5);
                        // Mark NMOS patching start
                        if (timingContext) {
                            const latencyMeasurement = ConnectionLatencyMeasurement.getInstance();
                            latencyMeasurement.markPhase(timingContext.connectionId, 'patchSent');
                        }
                        let log = await NmosRegistryConnector.instance.makeConnection(nmosId,senderInfo);
                        // Mark NMOS patching complete
                        if (timingContext) {
                            const latencyMeasurement = ConnectionLatencyMeasurement.getInstance();
                            latencyMeasurement.markPhase(timingContext.connectionId, 'patchResponse');
                        }
                        if(senderInfo.senderId == "disconnect"){
                            resolve({src:src,dst:dst,status:"ok_dis", detail:{message:"Success",log:""+log}});
                        }else{
                            resolve({src:src,dst:dst,status:"ok", detail:{message:"Success",log:""+log}});
                        }
                    }catch(e){
                        if(e instanceof LoggedError){
                            reject({src:src,dst:dst,status:"failed", detail:{message:e.message, log:e.logId}});
                        }else{
                            reject({src:src,dst:dst,status:"failed", detail:{message:e.message, log:""}});
                        }
                        
                    }
                }
            }else{
                let id = SyncLog.log("warning", "connect_crosspoint", "Connect command without destination.")
                reject({src:src,dst:dst,status:"nc", detail:{message:"Destination missing",log:id}});
            }
        });
    }


    reconnectOnChangesFromNmos( senderId:string ){
        if(!this.settings.reconnectOnSdpChanges){
            return;
        }
        let nmos_senderId = "nmos_"+senderId
        let src:CrosspointFlow = null;
        for(let dev of this.crosspointState.devices){
            for(let type of Object.keys(dev.senders)){
                for( let flow of dev.senders[type]){
                    if(flow.id == nmos_senderId){
                       src = flow;
                       break;
                    }
                }
            }
        }

        if(src){
            for(let dev of this.crosspointState.devices){
                for(let type of Object.keys(dev.receivers)){
                    for( let flow of dev.receivers[type]){
                        if(flow.connectedFlow == nmos_senderId){
                           let dst = flow;
                           this.executeConnection(src,dst).then(()=>{}).catch(()=>{});
                           SyncLog.info("crosspoint","Executed reconnection on SDP Changed: " + src.id +" > "+dst.id);
                        }
                    }
                }
            }
        }
    }
    
    updateReturn(data: any) {
        if(data.hasOwnProperty("crosspointState")){
            const prev = this.crosspointState;
            this.crosspointState = data.crosspointState;
            
            // Update optimized lookup maps for O(1) performance
            this.optimizedLookup.updateFromCrosspointState(this.crosspointState);
            
            this.syncCrosspoint.setState(this.crosspointState);
            // Notify subscribers
            try{
                this.updateCallbacks.forEach(cb => {
                    try{ cb(this.crosspointState, prev); }catch(e){
                        SyncLog.log("error", "crosspoint", "Update callback failed", e);
                    }
                });
            }catch(e){}
        }

        if(data.hasOwnProperty("log")){
            SyncLog.log(data.log.severity, data.log.topic, data.log.text, data.log.raw);
        }

        if(data.hasOwnProperty("nmosSetMulticast")){
            NmosRegistryConnector.instance.setFlowMulticast(data.nmosSetMulticast.nmosId,data.nmosSetMulticast.multicast);
        }
    }
    
    updateFromNmos(nmosState: any) {
        const isFirstUpdate = !this.nmosState;
        this.nmosState = nmosState;
        this.worker.postMessage(JSON.stringify({
            nmosState: this.nmosState
        }));
        
        // On first NMOS update: check IS-13 support, load existing aliases, and migrate local aliases (only once)
        if (isFirstUpdate) {
            // Small delay to ensure worker thread has processed NMOS state first
            setTimeout(async () => {
                // Check and log IS-13 support status
                this.checkIs13Support();
                
                // First load any existing aliases from NMOS description fields
                this.loadNmosAliases();
                
                // Then migrate existing local aliases to NMOS description fields (one-time only)
                // Additional delay to let loadNmosAliases complete first
                setTimeout(async () => {
                    try {
                        await this.migrateExistingAliasesToNmosOnce();
                    } catch (error) {
                        SyncLog.log("warning", "alias", `Alias migration failed: ${error instanceof Error ? error.message : String(error)}`);
                    }
                }, 2000);
            }, 1000);
        }
    }

    
    
}


export interface CrosspointEndpoint {
    type: "flow" | "device" | "channel",
    id: string
};

export interface CrosspointCapabilities {
    mediaTypes:string[],
    transport:string,
    dash7:boolean
};

export interface CrosspointFlowBitrate {
    v:number,
    hint:string
}


export interface CrosspointFlow {
    id:string,
    order : number,
    available:boolean,
    active:boolean,
    staged:boolean,
    num:number,
    dynamic:boolean,
    name:string,

    alias:string,
    hidden:boolean,

    connectedFlow:string,

    type:"video" | "audio" | "data" | "mqtt" | "websocket" | "audiochannel" | "unknown",
    format: string,
    manifestOk:boolean,
    capabilities:CrosspointCapabilities,
    capLimits:string,
    channelNumber: number,
    sourceNumber: number,
    bitrate:CrosspointFlowBitrate
};



export interface CrosspointDevice {
    id:string,
    order:number,
    available:boolean,
    num:number,
    dynamic:boolean,
    name:string,
    ip:string,
    alias:string,
    hidden:boolean,
    senderIds:string[],
    receiverIds:string[],
    connectedFlows:string[],

    senders:  {
        audio: CrosspointFlow[],
        audiochannel:CrosspointFlow[],
        video: CrosspointFlow[],
        data: CrosspointFlow[],
        websocket:CrosspointFlow[],
        mqtt: CrosspointFlow[],
        unknown: CrosspointFlow[],
    },
    receivers:  {
        audio: CrosspointFlow[],
        audiochannel:CrosspointFlow[],
        video: CrosspointFlow[],
        data: CrosspointFlow[],
        websocket:CrosspointFlow[],
        mqtt: CrosspointFlow[],
        unknown: CrosspointFlow[],
    },
    
  }
export interface CrosspointState {
    devices: CrosspointDevice[]
}


export interface CrosspointShadowFlow {
    id:string,
    num:number,
    order : number,
    name:string,
    type:"video" | "audio" | "data" | "mqtt" | "websocket" | "audiochannel" | "unknown",
    channelNumber: number,
};

export interface CrosspointConnectionSenderInfo {
    senderId:string,
    manifestFile:string,
    interfaces:any[],
    active:boolean,
    error:string,
    transport:string,
    // Sender TCP endpoint per leg, required to stage a Matrox USB receiver. Only set for
    // transport "usb"; other transports derive their parameters on the receiver side.
    senderLegs?:{source_ip:string, source_port:number}[]
}

export interface CrosspointShadowDevice {
    id:string,
    num:number,
    order:number,
    name:string,
    senders:  {
        audio: { [name: string]: CrosspointShadowFlow },
        audiochannel: { [name: string]: CrosspointShadowFlow },
        video: { [name: string]: CrosspointShadowFlow },
        data: { [name: string]: CrosspointShadowFlow },
        websocket: { [name: string]: CrosspointShadowFlow },
        mqtt: { [name: string]: CrosspointShadowFlow },
        unknown: { [name: string]: CrosspointShadowFlow },
    },
    receivers:  {
        audio: { [name: string]: CrosspointShadowFlow },
        audiochannel: { [name: string]: CrosspointShadowFlow },
        video: { [name: string]: CrosspointShadowFlow },
        data: { [name: string]: CrosspointShadowFlow },
        websocket: { [name: string]: CrosspointShadowFlow },
        mqtt: { [name: string]: CrosspointShadowFlow },
        unknown: { [name: string]: CrosspointShadowFlow },
    },
    
  }
export interface CrosspointShadowState {
    devices: {
        [name: string]: CrosspointShadowDevice
    }

}