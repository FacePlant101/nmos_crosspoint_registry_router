import { NetworkInfrastructureConnector } from "./networkInfrastructureConnector";

export class NetworkInfrastructureAbstrraction {
    settings:NetworkAuth;
    device:NetworkInfrastructure;

    updateCallback:any = null;

    connector:NetworkInfrastructureConnector | null = null;

    constructor( opt:NetworkAuth, callback:any){
        this.settings = opt;
        this.updateCallback = callback;
        console.log(`NetworkInfrastructureAbstrraction: Attempting to load connector for type: '${this.settings.type}' (Device Name: '${this.settings.name}')`);
        try{
            let loaded = require("./"+this.settings.type);
            console.log(`NetworkInfrastructureAbstrraction: Successfully required module for type: '${this.settings.type}'`);
            this.connector = new loaded.NIC_MOD(opt, (dev)=>{this.changed(dev)});
            console.log(`NetworkInfrastructureAbstrraction: Successfully instantiated connector for type: '${this.settings.type}'`);
            this.connector.changed = (dev)=>{this.changed(dev)  ;};
        }catch(e){
            console.error(`NetworkInfrastructureAbstrraction: FAILED to load or instantiate connector for type: '${this.settings.type}' (Device Name: '${this.settings.name}'). Error:`, e);
        }
        
    }

    changed(dev:NetworkInfrastructure){
        this.device = dev;
        if(this.updateCallback){
            this.updateCallback();
        }
    }
}





export interface NetworkAuth {
    name:string,
   type:string,
   connect:string,
   auth:string, 
   user?: string; 
   password?: string; 
   // Optional per-device tuning parameters
   pollIntervalMs?: number;
   startJitterMs?: number;
   fetchTimeoutMs?: number;
   retryMax?: number;
   retryBaseDelayMs?: number;
   retryJitterMs?: number;
   circuitBreaker?: {
       failureThreshold?: number;
       openDurationMs?: number;
   };
};

export interface NetworkInfrastructure {
    type:"switch"|"router",
    name:string,
    source:"config"|"detected",
    id:string,
    model?: string;
    serialNumber?: string;
    version?: string;
    interfaces:NetworkInterface[],
    rendering:any,
}

export interface NetworkDevice {
    type:"camera"|"converter"|"generic",
    name:string,
    source:"nmos",
    id:string,
    interfaces:NetworkInterface[],
    signals:NetworkDeviceSignal[],
    rendering:any,
};

interface NetworkDeviceSignal {
    name:string
}

export interface NetworkInterface {
    name:string,
    id:string,
    num:number,
    speed:number,
    mac:string,
    type:"rj45"|"sfp"|"qsfp"|"qsfp-split"|"unknown",
    maxspeed:number,
    linkState?: 'up' | 'down' | 'unknown';
    duplex?: string;
    attached: AttachedNetworkDevice | null;
    device?:NetworkDevice,
    port?:NetworkInterface
}

export interface AttachedNetworkDevice {
    chassisId: string;
    portId: string;
    name: string; 
}