import { CrosspointDevice, CrosspointFlow, CrosspointState } from "./crosspointAbstraction";
import { SyncLog } from "./syncLog";

/**
 * Optimized lookup service for crosspoint devices and flows
 * Replaces O(n²) nested loops with O(1) Map-based lookups for minimal switching latency
 */
export class CrosspointOptimizedLookup {
    private static instance: CrosspointOptimizedLookup | null = null;
    
    // Device lookup maps for O(1) performance
    private devicesByNum: Map<number, CrosspointDevice> = new Map();
    private devicesByName: Map<string, CrosspointDevice> = new Map();
    private devicesByAlias: Map<string, CrosspointDevice> = new Map();
    private devicesByNmosId: Map<string, CrosspointDevice> = new Map();
    
    // Flow lookup maps for O(1) performance
    private flowsById: Map<string, CrosspointFlow> = new Map();
    private flowsByDeviceAndNum: Map<string, CrosspointFlow> = new Map(); // key: "deviceId:flowNum"
    private senderFlowsByType: Map<string, CrosspointFlow[]> = new Map(); // key: "deviceId:type"
    private receiverFlowsByType: Map<string, CrosspointFlow[]> = new Map(); // key: "deviceId:type"
    
    // Compatibility cache for O(1) sender-receiver matching
    private compatibilityCache: Map<string, boolean> = new Map(); // key: "senderId:receiverId"
    private cacheExpiration: Map<string, number> = new Map();
    private readonly CACHE_DURATION_MS = 60000; // 1 minute cache
    
    // Update tracking
    private lastUpdateHash: string = "";
    
    static getInstance(): CrosspointOptimizedLookup {
        if (!CrosspointOptimizedLookup.instance) {
            CrosspointOptimizedLookup.instance = new CrosspointOptimizedLookup();
        }
        return CrosspointOptimizedLookup.instance;
    }
    
    /**
     * Update lookup maps when crosspoint state changes
     */
    updateFromCrosspointState(state: CrosspointState): void {
        const stateHash = this.generateStateHash(state);
        if (stateHash === this.lastUpdateHash) {
            return; // No changes, skip update
        }
        
        const startTime = performance.now();
        
        // Clear existing maps
        this.clearMaps();
        
        // Build optimized lookup maps
        for (const device of state.devices) {
            // Device lookups
            this.devicesByNum.set(device.num, device);
            this.devicesByName.set(device.name, device);
            if (device.alias) {
                this.devicesByAlias.set(device.alias, device);
            }
            
            // Handle NMOS device IDs
            if (device.id.startsWith("nmos_")) {
                this.devicesByNmosId.set(device.id, device);
            }
            
            // Build flow lookups for senders
            for (const [type, flows] of Object.entries(device.senders)) {
                const typeKey = `${device.id}:${type}`;
                this.senderFlowsByType.set(typeKey, flows as CrosspointFlow[]);
                
                for (const flow of flows as CrosspointFlow[]) {
                    this.flowsById.set(flow.id, flow);
                    const deviceFlowKey = `${device.id}:${flow.num}`;
                    this.flowsByDeviceAndNum.set(deviceFlowKey, flow);
                }
            }
            
            // Build flow lookups for receivers
            for (const [type, flows] of Object.entries(device.receivers)) {
                const typeKey = `${device.id}:${type}`;
                this.receiverFlowsByType.set(typeKey, flows as CrosspointFlow[]);
                
                for (const flow of flows as CrosspointFlow[]) {
                    this.flowsById.set(flow.id, flow);
                    const deviceFlowKey = `${device.id}:${flow.num}`;
                    this.flowsByDeviceAndNum.set(deviceFlowKey, flow);
                }
            }
        }
        
        // Clean expired compatibility cache entries
        this.cleanExpiredCache();
        
        const updateTime = performance.now() - startTime;
        this.lastUpdateHash = stateHash;
        
        SyncLog.log("debug", "crosspoint_optimization", `Optimized lookup maps updated in ${updateTime.toFixed(2)}ms`, {
            devices: state.devices.length,
            totalFlows: this.flowsById.size,
            cacheEntries: this.compatibilityCache.size
        });
    }
    
    /**
     * Fast device lookup by identifier (num, name, alias, or NMOS ID)
     */
    findDevice(identifier: string | number): CrosspointDevice | null {
        // Try numeric lookup first
        if (typeof identifier === "number" || !isNaN(Number(identifier))) {
            const numericId = typeof identifier === "number" ? identifier : Number(identifier);
            const device = this.devicesByNum.get(numericId);
            if (device) return device;
        }
        
        const stringId = String(identifier);
        
        // Try NMOS ID lookup
        if (stringId.startsWith("nmos_")) {
            const device = this.devicesByNmosId.get(stringId);
            if (device) return device;
        }
        
        // Try name lookup
        let device = this.devicesByName.get(stringId);
        if (device) return device;
        
        // Try alias lookup
        device = this.devicesByAlias.get(stringId);
        if (device) return device;
        
        return null;
    }
    
    /**
     * Fast flow lookup by ID
     */
    findFlow(flowId: string): CrosspointFlow | null {
        return this.flowsById.get(flowId) || null;
    }
    
    /**
     * Fast flow lookup by device and flow number
     */
    findFlowByDeviceAndNum(deviceId: string, flowNum: number): CrosspointFlow | null {
        const key = `${deviceId}:${flowNum}`;
        return this.flowsByDeviceAndNum.get(key) || null;
    }
    
    /**
     * Fast sender flows lookup by device and type
     */
    findSenderFlows(deviceId: string, type?: string): CrosspointFlow[] {
        if (!type) {
            // Return all sender flows for device
            const allFlows: CrosspointFlow[] = [];
            const types = ["video", "audio", "data", "audiochannel", "websocket", "mqtt", "unknown"];
            for (const flowType of types) {
                const key = `${deviceId}:${flowType}`;
                const flows = this.senderFlowsByType.get(key);
                if (flows) {
                    allFlows.push(...flows);
                }
            }
            return allFlows;
        }
        
        const key = `${deviceId}:${type}`;
        return this.senderFlowsByType.get(key) || [];
    }
    
    /**
     * Fast receiver flows lookup by device and type
     */
    findReceiverFlows(deviceId: string, type?: string): CrosspointFlow[] {
        if (!type) {
            // Return all receiver flows for device
            const allFlows: CrosspointFlow[] = [];
            const types = ["video", "audio", "data", "audiochannel", "websocket", "mqtt", "unknown"];
            for (const flowType of types) {
                const key = `${deviceId}:${flowType}`;
                const flows = this.receiverFlowsByType.get(key);
                if (flows) {
                    allFlows.push(...flows);
                }
            }
            return allFlows;
        }
        
        const key = `${deviceId}:${type}`;
        return this.receiverFlowsByType.get(key) || [];
    }
    
    /**
     * Fast compatibility check with caching
     */
    areFlowsCompatible(senderFlow: CrosspointFlow, receiverFlow: CrosspointFlow): boolean {
        const cacheKey = `${senderFlow.id}:${receiverFlow.id}`;
        const now = Date.now();
        
        // Check cache first
        if (this.compatibilityCache.has(cacheKey)) {
            const expiration = this.cacheExpiration.get(cacheKey);
            if (expiration && expiration > now) {
                return this.compatibilityCache.get(cacheKey)!;
            }
        }
        
        // Calculate compatibility
        const compatible = this.calculateFlowCompatibility(senderFlow, receiverFlow);
        
        // Cache result
        this.compatibilityCache.set(cacheKey, compatible);
        this.cacheExpiration.set(cacheKey, now + this.CACHE_DURATION_MS);
        
        return compatible;
    }
    
    /**
     * Find best matching sender for a receiver with O(1) lookups
     */
    findBestSender(receiverFlow: CrosspointFlow, availableSenders: CrosspointFlow[]): CrosspointFlow | null {
        let bestSender: CrosspointFlow | null = null;
        
        for (const sender of availableSenders) {
            if (this.areFlowsCompatible(sender, receiverFlow)) {
                if (!bestSender || (typeof sender.num === "number" && typeof bestSender.num === "number" && sender.num < bestSender.num)) {
                    bestSender = sender;
                }
            }
        }
        
        return bestSender;
    }
    
    /**
     * Calculate flow compatibility (cached)
     */
    private calculateFlowCompatibility(senderFlow: CrosspointFlow, receiverFlow: CrosspointFlow): boolean {
        // Type matching logic (optimized from original)
        if (receiverFlow.type === "audio" && senderFlow.type === "audio") return true;
        if (receiverFlow.type === "video" && senderFlow.type === "video") return true;
        if (receiverFlow.type === "data" && senderFlow.type === "data") return true;
        if (receiverFlow.type === senderFlow.type) return true;
        
        return false;
    }
    
    /**
     * Generate hash for state change detection
     */
    private generateStateHash(state: CrosspointState): string {
        // Hash includes device names and aliases to detect name changes
        let hash = `devices:${state.devices.length}`;
        for (const device of state.devices) {
            const senderCount = Object.values(device.senders).reduce((sum, flows) => sum + flows.length, 0);
            const receiverCount = Object.values(device.receivers).reduce((sum, flows) => sum + flows.length, 0);
            // Include device name and alias in hash to detect changes from "UNKNOWN" to proper names
            hash += `:${device.id}:${device.name || ''}:${device.alias || ''}:${senderCount}:${receiverCount}`;
        }
        return hash;
    }
    
    /**
     * Clear all lookup maps
     */
    private clearMaps(): void {
        this.devicesByNum.clear();
        this.devicesByName.clear();
        this.devicesByAlias.clear();
        this.devicesByNmosId.clear();
        this.flowsById.clear();
        this.flowsByDeviceAndNum.clear();
        this.senderFlowsByType.clear();
        this.receiverFlowsByType.clear();
    }
    
    /**
     * Clean expired cache entries
     */
    private cleanExpiredCache(): void {
        const now = Date.now();
        for (const [key, expiration] of this.cacheExpiration.entries()) {
            if (expiration <= now) {
                this.compatibilityCache.delete(key);
                this.cacheExpiration.delete(key);
            }
        }
    }
    
    /**
     * Get cache statistics for monitoring
     */
    getCacheStats(): { 
        totalEntries: number; 
        hitRate: number; 
        devices: number; 
        flows: number; 
    } {
        return {
            totalEntries: this.compatibilityCache.size,
            hitRate: 0, // Would need to track hits/misses to calculate
            devices: this.devicesByNum.size,
            flows: this.flowsById.size
        };
    }
}
