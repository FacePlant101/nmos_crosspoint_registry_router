import { CrosspointAbstraction, CrosspointFlow, CrosspointState } from "./crosspointAbstraction";
import { SyncLog } from "./syncLog";

export interface PredictiveStagerOptions {
  enabled: boolean;
  cooldownMs: number;
  perReceiver?: { [receiverFlowId: string]: { enabled?: boolean; cooldownMs?: number } };
}

export default class PredictiveStager {
  private crosspoint: CrosspointAbstraction;
  private cooldownMs: number;
  private perReceiver: Map<string, { enabled: boolean; cooldownMs: number }> = new Map();

  // History: receiverFlowId -> (senderFlowId -> count)
  private history: Map<string, Map<string, number>> = new Map();
  private lastStageAt: Map<string, number> = new Map();
  private lastMultiviewerState: Map<string, boolean> = new Map();

  constructor(crosspoint: CrosspointAbstraction, options: PredictiveStagerOptions){
    this.crosspoint = crosspoint;
    this.cooldownMs = options?.cooldownMs ?? 10000;
    if(options?.perReceiver){
      for(const [rid, cfg] of Object.entries(options.perReceiver)){
        this.perReceiver.set(rid, {
          enabled: cfg.enabled !== false,
          cooldownMs: typeof cfg.cooldownMs === 'number' ? cfg.cooldownMs : this.cooldownMs,
        })
      }
    }

    SyncLog.info("predictive", `PredictiveStager initialized. cooldown=${this.cooldownMs}ms`);
    this.crosspoint.registerUpdateCallback((state, prev)=>{
      try{ this.onCrosspointUpdate(state, prev); }catch(e){
        SyncLog.log("error", "predictive", "Predictive update failed", e);
      }
    });
  }

  private onCrosspointUpdate(state: CrosspointState, prev: CrosspointState | null){
    if(!prev){ return; }

    const prevConn = this.indexReceiverConnections(prev);
    const currConn = this.indexReceiverConnections(state);

    for(const [receiverId, currentSenderId] of currConn.entries()){
      const before = prevConn.get(receiverId) ?? "";
      if(before !== currentSenderId){
        // Record usage on actual connection
        if(currentSenderId){
          this.recordUsage(receiverId, currentSenderId);
        }
        // Try to stage next likely (different from current)
        this.stagePrediction(receiverId, state, currentSenderId);
      }
    }
  }

  private recordUsage(receiverId: string, senderId: string){
    let map = this.history.get(receiverId);
    if(!map){ map = new Map(); this.history.set(receiverId, map); }
    map.set(senderId, (map.get(senderId) ?? 0) + 1);
  }

  private predict(receiverId: string, exclude?: string): string | null{
    const map = this.history.get(receiverId);
    if(!map || map.size === 0){ return null; }
    let best: {id: string, count: number} | null = null;
    for(const [senderId, count] of map.entries()){
      if(exclude && senderId === exclude){ continue; }
      if(!best || count > best.count){ best = {id: senderId, count}; }
    }
    return best ? best.id : null;
  }

  private stagePrediction(receiverId: string, state: CrosspointState, currentSenderId: string){
    const cfg = this.perReceiver.get(receiverId);
    const enabled = cfg ? cfg.enabled !== false : true;
    const cooldown = cfg ? cfg.cooldownMs : this.cooldownMs;
    if(!enabled){ return; }

    const multiviewerStatus = this.getMultiviewerStatus(receiverId);
    if (multiviewerStatus.changed) {
      this.lastStageAt.delete(receiverId);
    }
    if (multiviewerStatus.skip) {
      return;
    }

    const last = this.lastStageAt.get(receiverId) ?? 0;
    const now = Date.now();

    // Hard rate limit. This must not depend on which sender is predicted: predict() excludes the
    // current sender, so on A->B->A switching the prediction flips every time and any
    // per-sender condition would never engage, leaving the receiver unthrottled.
    if(now - last < cooldown){ return; }

    const predicted = this.predict(receiverId, currentSenderId);
    if(!predicted || predicted === currentSenderId){ return; }

    // No "already staged" shortcut: this only runs after a switch, and activating any sender
    // replaces the receiver's staged parameters, so an earlier staging is never still pending.

    const dst = this.findFlowById(state, receiverId, false);
    const src = this.findFlowById(state, predicted, true);
    if(!dst || !src){ return; }

    this.lastStageAt.set(receiverId, now);
    SyncLog.log("info", "predictive", `Staging prediction for ${receiverId}: ${predicted}`);
    this.crosspoint.executeConnectionPrepare(src, dst)
      .then(()=>{ SyncLog.log("success", "predictive", `Staged ${predicted} -> ${receiverId}`); })
      .catch((e)=>{ SyncLog.log("warning", "predictive", `Failed to stage ${predicted} -> ${receiverId}: ${e?.message || e}`); });
  }

  private indexReceiverConnections(state: CrosspointState): Map<string, string>{
    const out = new Map<string, string>();
    for(const dev of state.devices){
      const groups: any = dev.receivers as any;
      for(const type of Object.keys(groups)){
        const arr: CrosspointFlow[] = groups[type] || [];
        for(const flow of arr){
          const receiverId = flow.id; // expected to be like 'nmos_<receiver>'
          const senderId = (flow.connectedFlow || "");
          out.set(receiverId, senderId);
        }
      }
    }
    return out;
  }

  private getMultiviewerStatus(receiverId: string): { skip: boolean; changed: boolean } {
    let skip = false;
    try {
      // Lazy require: matroxConvertIp imports the crosspoint modules.
      const MediaDevMatroxConvertIp = require('../mediaDevices/matroxConvertIp').default;
      skip = MediaDevMatroxConvertIp.isMultiviewReceiver(receiverId);
    } catch (error) {
      SyncLog.log("warning", "predictive",
        `Error checking multiviewer state for receiver ${receiverId}: ${error instanceof Error ? error.message : String(error)}`);
      return { skip: false, changed: false };
    }
    if (skip) {
      // A multiviewer decoder is already decoding four streams; staging more would overload it.
      SyncLog.log("debug", "predictive", `Skipping receiver ${receiverId}: Matrox multiviewer enabled`);
    }
    const previous = this.lastMultiviewerState.get(receiverId);
    this.lastMultiviewerState.set(receiverId, skip);
    return { skip, changed: previous !== undefined && previous !== skip };
  }

  private findFlowById(state: CrosspointState, id: string, isSender: boolean): CrosspointFlow | null{
    for(const dev of state.devices){
      const groups: any = isSender ? dev.senders : dev.receivers;
      for(const type of Object.keys(groups)){
        const arr: CrosspointFlow[] = groups[type] || [];
        for(const flow of arr){ if(flow.id === id){ return flow; } }
      }
    }
    return null;
  }
}
