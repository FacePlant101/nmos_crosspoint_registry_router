/* 
    NMOS Crosspoint
    Copyright (C) 2021 Johannes Grieb
*/

import * as WebSocket from "ws";

import * as Crypto from "crypto";

import { WebsocketSyncServer } from "./websocketSyncServer";

export class WebsocketClient {
    private ws: WebSocket;

    private authSeed: string = "";
    public user: string = "__noAuth"
    public sendPermissionDenied(type:string, data:any){
        this.send({
            type:"permissionDenied",
            requestType:type,
            data:data
        })
    }


    private env = {};
    public getEnv() {
        return this.env;
    }

    private subscriptionList = [];

    // Server-side heartbeat state — see the explainer on pingInterval below.
    private pingInterval: any = null;
    private pongPending: boolean = false;
    private pingIntervalMs = 15000;
    private pongTimeoutMs = 30000;
    private lastPongAt: number = Date.now();

    constructor(s: WebSocket, e: any) {
        this.ws = s;
        this.env = e;

        this.authSeed = Crypto.createHash('sha1').update(""+Math.random()).digest('hex');

        this.ws.on("message", (text: string) => {
            if (text == "ping" && this.ws.readyState === this.ws.OPEN) {
                this.ws.send("pong");
            } else {
                try {
                    const m = JSON.parse(text);
                    this.processMessage(m);
                } catch (e) {}
            }
        });
        // Native RFC 6455 pong frame — `ws` emits "pong" whenever the peer
        // answers a server-issued ping. Clearing pongPending here is what
        // lets the liveness timer below decide the socket is still alive.
        this.ws.on("pong", () => {
            this.pongPending = false;
            this.lastPongAt = Date.now();
        });

        this.ws.on("close", () => {
            if (this.pingInterval) {
                clearInterval(this.pingInterval);
                this.pingInterval = null;
            }
            WebsocketSyncServer.getInstance().disconnectClient(this);
        });

        // Server-side heartbeat. Every pingIntervalMs we send a native ping
        // frame; if no pong has arrived within pongTimeoutMs the connection
        // is treated as dead and terminated. This surfaces dead clients (NAT
        // drops, abrupt power-off) far faster than the OS TCP keepalive,
        // which is often over two hours by default.
        this.pingInterval = setInterval(() => {
            try {
                if (this.ws.readyState !== this.ws.OPEN) return;
                if (this.pongPending && (Date.now() - this.lastPongAt) > this.pongTimeoutMs) {
                    try { this.ws.terminate(); } catch (e) {}
                    return;
                }
                this.pongPending = true;
                this.ws.ping();
            } catch (e) {}
        }, this.pingIntervalMs);

        try{
            this.ws.send(JSON.stringify({
                type:"authseed",
                seed:this.authSeed
            }));
        }catch(e){}
    }

    destructor() {}
    isConnected() {
        // NOTE ws.OPEN / ws.CLOSED are the readyState CONSTANTS (1 / 3), not
        // the state itself — the old checks compared against those and were
        // always-false / always-true respectively.
        return this.ws.readyState === this.ws.OPEN;
    }

    private send(obj) {
        try{
            if (this.ws.readyState === this.ws.OPEN) {
                this.ws.send(JSON.stringify(obj));
            }
        }catch(e){}
    }

    sendObjectSyncData(channelName: string, action: string, objectId: any, state: any) {
        this.send({
            type: "sync",
            channel: channelName,
            objectId: objectId,
            action: action,
            data: state,
        });
    }

    private processMessage(message) {
        switch (message.type) {
            case "request":
                this.processRequest(message);
                break;
            case "sync":
            case "unsync":
                this.processSync(message);
                break;
            case "auth":
                this.processAuth(message);
                break;
        }
    }

    processRequest(message) {
        WebsocketSyncServer.getInstance()
            .request(message, this)
            .then((data) => {
                this.send(data);
            })
            .catch((e) => {
                this.send(e);
            });
    }

    processSync(message) {
        if (message.type === "sync") {
            if (typeof message.channel === "string") {
                let objectId = 0;
                if (typeof message.objectId === "string" || typeof message.objectId === "number") {
                    objectId = message.objectId;
                }
                WebsocketSyncServer.getInstance().subscribeSyncObject(message.channel, this, objectId);
            }
        } else if (message.type === "unsync") {
            if (typeof message.channel === "string") {
                let objectId = 0;
                if (typeof message.objectId === "string" || typeof message.objectId === "number") {
                    objectId = message.objectId;
                }
                WebsocketSyncServer.getInstance().unsubscribeSyncObject(message.channel, this, objectId);
            }
        }
    }

    
    processAuth(message:any){
        if(WebsocketSyncServer.getInstance().authData.users.hasOwnProperty(message.user)){
            let proof = WebsocketSyncServer.getInstance().authData.users[message.user].password + this.authSeed
            proof = Crypto.createHash('sha256').update(proof).digest('hex');

            if(proof == message.password){
                this.user = message.user;
                this.send({type:"auth", user:message.user});
            }else{
                this.send({type:"authfailed"});
            }
        }else{
            this.send({type:"authfailed"});
        }
    }
}
