import { CrosspointAbstraction, CrosspointFlow, CrosspointState } from "./crosspointAbstraction";
import { NmosRegistryConnector } from "./nmosConnector";
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
  private lastStagedSender: Map<string, { senderId: string; at: number }> = new Map();
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

    const multiviewerStatus = this.getMultiviewerStatus(receiverId, state);
    if (multiviewerStatus.changed) {
      this.lastStageAt.delete(receiverId);
      this.lastStagedSender.delete(receiverId);
    }
    if (multiviewerStatus.skip) {
      return;
    }

    const last = this.lastStageAt.get(receiverId) ?? 0;
    const now = Date.now();

    // The staged connection was taken up by this switch, so it is no longer pending.
    const lastStaged = this.lastStagedSender.get(receiverId);
    if (lastStaged && lastStaged.senderId === currentSenderId) {
      this.lastStagedSender.delete(receiverId);
    }

    // Hard rate limit. This must not depend on which sender is predicted: predict() excludes the
    // current sender, so on A->B->A switching the prediction flips every time and any
    // per-sender condition would never engage, leaving the receiver unthrottled.
    if(now - last < cooldown){ return; }

    const predicted = this.predict(receiverId, currentSenderId);
    if(!predicted || predicted === currentSenderId){ return; }

    // Already staged and still pending - re-issuing the same prepare would be a no-op.
    const staged = this.lastStagedSender.get(receiverId);
    if (staged && staged.senderId === predicted) {
      return;
    }

    const dst = this.findFlowById(state, receiverId, false);
    const src = this.findFlowById(state, predicted, true);
    if(!dst || !src){ return; }

    this.lastStageAt.set(receiverId, now);
    this.lastStagedSender.set(receiverId, { senderId: predicted, at: now });
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

  private getMultiviewerStatus(receiverId: string, state: CrosspointState): { skip: boolean; changed: boolean } {
    try {
      // Find device that contains this receiver flow
      for (const device of state.devices) {
        // Check if this device contains the receiver flow
        for (const [type, flows] of Object.entries(device.receivers)) {
          const flowArray = flows as any[];
          if (flowArray.some(f => f.id === receiverId)) {
            // Found the device, check if it's a Matrox ConvertIP decoder with multiviewer enabled.
            // Resolve via the receiver flow: legacy "nmosgrp_" device ids are md5 hashes and
            // cannot be mapped back to an NMOS device id.
            const deviceId = NmosRegistryConnector.nmosDeviceIdFromFlowId(receiverId);
            if (NmosRegistryConnector.isMatroxCipDevice(deviceId)) {
              try {
                const MediaDevMatroxConvertIp = require('../mediaDevices/matroxConvertIp').default;
                const matroxInstance = MediaDevMatroxConvertIp.instance;
                if (matroxInstance && matroxInstance.isMultiviewerEnabled(device.alias || device.name || device.num.toString())) {
                  // Skip ALL receivers on multiviewer-enabled Matrox decoders to prevent overload
                  SyncLog.log("debug", "predictive", 
                    `Skipping receiver ${receiverId} on Matrox decoder ${device.name}: multiviewer enabled (prevents overload from 4+ concurrent streams)`);
                  const previous = this.lastMultiviewerState.get(device.id);
                  const changed = previous !== undefined && previous !== true;
                  this.lastMultiviewerState.set(device.id, true);
                  return { skip: true, changed };
                }

                const previous = this.lastMultiviewerState.get(device.id);
                const changed = previous !== undefined && previous !== false;
                this.lastMultiviewerState.set(device.id, false);
                return { skip: false, changed };
              } catch (error) {
                SyncLog.log("warning", "predictive", 
                  `Failed to query multiviewer state for device ${device.name}: ${error instanceof Error ? error.message : String(error)}`);
                return { skip: false, changed: false };
              }
            }
            break; // Found the device, no need to continue searching
          }
        }
      }
    } catch (error) {
      SyncLog.log("warning", "predictive", 
        `Error checking multiviewer state for receiver ${receiverId}: ${error instanceof Error ? error.message : String(error)}`);
    }

    return { skip: false, changed: false }; // Default to allow staging if no multiviewer conflict detected
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
