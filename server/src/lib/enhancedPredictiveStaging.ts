import { SyncLog } from "./syncLog";
import { NmosHealthMonitor } from "./nmosHealthMonitor";
import { ParallelNmosConnector } from "./parallelNmosConnector";
import { NmosRegistryConnector } from "./nmosConnector";
import { CrosspointOptimizedLookup } from "./crosspointOptimizedLookup";

export interface StagingPrediction {
    senderId: string;
    receiverIds: string[];
    confidence: number;
    reason: string;
    timestamp: number;
}

export interface StagingCache {
    senderId: string;
    receiverId: string;
    stagedAt: number;
    expiresAt: number;
    isReady: boolean;
}

export class EnhancedPredictiveStaging {
    private static instance: EnhancedPredictiveStaging;
    private stagingCache = new Map<string, StagingCache>();
    private connectionPatterns = new Map<string, { count: number; lastUsed: number }>();
    private healthMonitor: NmosHealthMonitor;
    private parallelConnector: ParallelNmosConnector;
    private optimizedLookup: CrosspointOptimizedLookup;
    
    // Configuration
    private readonly maxStagingCacheSize = 100;
    private readonly stagingExpiryMs = 10 * 60 * 1000; // 10 minutes
    private readonly patternConfidenceThreshold = 0.7;
    private readonly maxPredictiveStaging = 20;

    constructor() {
        EnhancedPredictiveStaging.instance = this;
        this.healthMonitor = NmosHealthMonitor.getInstance();
        this.parallelConnector = ParallelNmosConnector.getInstance();
        
        // Get optimized lookup from CrosspointAbstraction
        const CrosspointAbstraction = require('./crosspointAbstraction').CrosspointAbstraction;
        if (CrosspointAbstraction.instance) {
            this.optimizedLookup = CrosspointAbstraction.instance.optimizedLookup;
        }
        
        // Cleanup expired staging periodically
        setInterval(() => {
            this.cleanupExpiredStaging();
        }, 2 * 60 * 1000); // Every 2 minutes
    }

    static getInstance(): EnhancedPredictiveStaging {
        if (!EnhancedPredictiveStaging.instance) {
            EnhancedPredictiveStaging.instance = new EnhancedPredictiveStaging();
        }
        return EnhancedPredictiveStaging.instance;
    }

    /**
     * Record a connection pattern for future prediction
     */
    recordConnectionPattern(senderId: string, receiverId: string): void {
        const pattern = `${senderId}->${receiverId}`;
        const existing = this.connectionPatterns.get(pattern);
        
        this.connectionPatterns.set(pattern, {
            count: (existing?.count || 0) + 1,
            lastUsed: Date.now()
        });
        
        // Trigger predictive staging if pattern is frequent
        if (existing && existing.count >= 3) {
            this.stagePredictiveConnection(senderId, receiverId, "frequent_pattern");
        }
    }

    /**
     * Get predictions for likely next connections, grouped by sender for parallel staging
     */
    getPredictions(currentContext?: { senderId?: string; receiverId?: string }): StagingPrediction[] {
        const senderReceiverMap = new Map<string, { receiverIds: string[], patterns: { confidence: number, reason: string, count: number }[] }>();
        const now = Date.now();
        
        // Analyze connection patterns and group by sender
        for (const [pattern, data] of this.connectionPatterns.entries()) {
            const [senderId, receiverId] = pattern.split('->');
            
            // Skip if recently used or already staged
            if (now - data.lastUsed > 60 * 60 * 1000) continue; // 1 hour
            if (this.isAlreadyStaged(senderId, receiverId)) continue;
            
            const confidence = Math.min(0.9, data.count / 10);
            
            if (confidence >= this.patternConfidenceThreshold) {
                if (!senderReceiverMap.has(senderId)) {
                    senderReceiverMap.set(senderId, { receiverIds: [], patterns: [] });
                }
                
                const senderData = senderReceiverMap.get(senderId)!;
                senderData.receiverIds.push(receiverId);
                senderData.patterns.push({
                    confidence,
                    reason: `Frequent pattern (${data.count} times)`,
                    count: data.count
                });
            }
        }
        
        // Context-based predictions - group related receivers
        if (currentContext?.senderId) {
            const relatedReceivers = this.findRelatedReceivers(currentContext.senderId)
                .filter(receiverId => !this.isAlreadyStaged(currentContext.senderId!, receiverId));
            
            if (relatedReceivers.length > 0) {
                if (!senderReceiverMap.has(currentContext.senderId)) {
                    senderReceiverMap.set(currentContext.senderId, { receiverIds: [], patterns: [] });
                }
                
                const senderData = senderReceiverMap.get(currentContext.senderId)!;
                relatedReceivers.forEach(receiverId => {
                    senderData.receiverIds.push(receiverId);
                    senderData.patterns.push({
                        confidence: 0.6,
                        reason: "Related to current connection",
                        count: 1
                    });
                });
            }
        }
        
        // Convert grouped data to predictions with multiple receivers per sender
        const predictions: StagingPrediction[] = [];
        
        for (const [senderId, data] of senderReceiverMap.entries()) {
            if (data.receiverIds.length === 0) continue;
            
            // Calculate average confidence for this sender group
            const avgConfidence = data.patterns.reduce((sum, p) => sum + p.confidence, 0) / data.patterns.length;
            
            // Generate reason summary
            const totalCount = data.patterns.reduce((sum, p) => sum + p.count, 0);
            const reasons = [...new Set(data.patterns.map(p => p.reason))].join(', ');
            const reason = data.receiverIds.length > 1 
                ? `${data.receiverIds.length} receivers: ${reasons} (total: ${totalCount} patterns)`
                : reasons;
            
            predictions.push({
                senderId,
                receiverIds: data.receiverIds,
                confidence: avgConfidence,
                reason,
                timestamp: now
            });
        }
        
        // Sort by confidence and limit total staging operations
        return predictions
            .sort((a, b) => {
                // Prefer predictions with more receivers (better parallelization)
                if (Math.abs(b.confidence - a.confidence) < 0.1) {
                    return b.receiverIds.length - a.receiverIds.length;
                }
                return b.confidence - a.confidence;
            })
            .slice(0, this.maxPredictiveStaging);
    }

    /**
     * Stage connections predictively with multiple receivers per sender in parallel
     */
    async executePredictiveStaging(predictions: StagingPrediction[]): Promise<void> {
        if (predictions.length === 0) return;
        
        const totalReceivers = predictions.reduce((sum, p) => sum + p.receiverIds.length, 0);
        SyncLog.log("info", "predictive_staging", 
            `Executing predictive staging: ${predictions.length} senders, ${totalReceivers} total receivers`);
        
        const stagingPromises = predictions.map(async (prediction) => {
            try {
                // Use health monitoring to prioritize healthy devices and apply multiviewer skip logic
                const prioritizedReceivers = prediction.receiverIds.filter(id => {
                    // Skip unhealthy devices
                    if (this.healthMonitor.shouldAvoidDevice(id)) {
                        return false;
                    }
                    
                    // Skip receivers on Matrox decoders with multiviewer enabled: they are already
                    // decoding four streams and staging more would overload them.
                    try {
                        const MediaDevMatroxConvertIp = require('../mediaDevices/matroxConvertIp').default;
                        if (MediaDevMatroxConvertIp.isMultiviewReceiver(id)) {
                            SyncLog.log("debug", "predictive_staging", `Skipping receiver ${id}: Matrox multiviewer enabled`);
                            return false;
                        }
                    } catch (error) {
                        SyncLog.log("warning", "predictive_staging",
                            `Failed to query multiviewer state for receiver ${id}: ${error instanceof Error ? error.message : String(error)}`);
                    }
                    
                    return true;
                });
                
                if (prioritizedReceivers.length === 0) {
                    SyncLog.log("warning", "predictive_staging", 
                        `Skipped sender ${prediction.senderId}: all ${prediction.receiverIds.length} receivers unhealthy or on a multiviewer`);
                    return;
                }
                
                const startTime = Date.now();
                
                // Stage multiple receivers from same sender in parallel
                const results = await this.parallelConnector.makeBatchConnection(
                    prediction.senderId,
                    prioritizedReceivers,
                    true // prepareOnly = true for staging
                );
                
                const stagingLatency = Date.now() - startTime;
                let successCount = 0;
                
                // Cache successful staging
                results.forEach((result, index) => {
                    if (result.success) {
                        const receiverId = prioritizedReceivers[index];
                        this.cacheStagedConnection(prediction.senderId, receiverId);
                        successCount++;
                    }
                });
                
                SyncLog.log("info", "predictive_staging", 
                    `Parallel staging completed: ${prediction.senderId} -> ${successCount}/${prioritizedReceivers.length} receivers`, {
                        confidence: prediction.confidence,
                        reason: prediction.reason,
                        latency: stagingLatency,
                        parallelizationGain: prioritizedReceivers.length > 1 ? `${prioritizedReceivers.length}x receivers` : "single"
                    });
                
            } catch (error) {
                SyncLog.log("warning", "predictive_staging", 
                    `Failed to stage prediction for sender ${prediction.senderId}: ${error instanceof Error ? error.message : String(error)}`);
            }
        });
        
        await Promise.allSettled(stagingPromises);
    }

    /**
     * Check if a connection is already staged and ready
     */
    isStagedAndReady(senderId: string, receiverId: string): boolean {
        const key = `${senderId}->${receiverId}`;
        const cached = this.stagingCache.get(key);
        
        return cached !== undefined && 
               cached.isReady && 
               cached.expiresAt > Date.now();
    }

    /**
     * Activate a pre-staged connection instantly
     */
    async activateStagedConnection(senderId: string, receiverId: string): Promise<boolean> {
        if (!this.isStagedAndReady(senderId, receiverId)) {
            return false;
        }
        
        try {
            // Get sender info (should be cached from staging)
            let senderInfo;
            if (senderId === "disconnect") {
                senderInfo = {
                    senderId: "disconnect",
                    interfaces: [],
                    manifestFile: "",
                    active: false,
                    error: "",
                    transport: ""
                };
            } else {
                const nmosId = senderId.startsWith("nmos_") ? senderId.slice(5) : senderId;
                senderInfo = await NmosRegistryConnector.instance.connectionGetSenderInfo(nmosId);
            }
            
            // Activate the staged connection
            const nmosReceiverId = receiverId.startsWith("nmos_") ? receiverId.slice(5) : receiverId;
            await NmosRegistryConnector.instance.makeConnection(nmosReceiverId, senderInfo, false);
            
            // Remove from staging cache
            const key = `${senderId}->${receiverId}`;
            this.stagingCache.delete(key);
            
            SyncLog.log("success", "predictive_staging", 
                `Instantly activated staged connection: ${senderId} -> ${receiverId}`);
            
            return true;
        } catch (error) {
            SyncLog.log("error", "predictive_staging", 
                `Failed to activate staged connection: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    /**
     * Proactive staging based on current system state
     */
    async runProactiveStaging(): Promise<void> {
        const predictions = this.getPredictions();
        if (predictions.length > 0) {
            await this.executePredictiveStaging(predictions);
        }
    }

    private stagePredictiveConnection(senderId: string, receiverId: string, reason: string): void {
        if (this.isAlreadyStaged(senderId, receiverId)) return;
        if (this.stagingCache.size >= this.maxStagingCacheSize) return;
        
        // Check if we can batch this with other pending connections for same sender
        const prediction: StagingPrediction = {
            senderId,
            receiverIds: [receiverId],
            confidence: 0.5,
            reason,
            timestamp: Date.now()
        };
        
        // Queue for staging with batching opportunity
        setTimeout(async () => {
            try {
                await this.executePredictiveStaging([prediction]);
            } catch (error) {
                // Silent fail for predictive staging
            }
        }, 100); // Small delay to avoid overwhelming the system
    }

    private isAlreadyStaged(senderId: string, receiverId: string): boolean {
        const key = `${senderId}->${receiverId}`;
        const cached = this.stagingCache.get(key);
        return cached !== undefined && cached.expiresAt > Date.now();
    }

    private cacheStagedConnection(senderId: string, receiverId: string): void {
        const key = `${senderId}->${receiverId}`;
        const now = Date.now();
        
        this.stagingCache.set(key, {
            senderId,
            receiverId,
            stagedAt: now,
            expiresAt: now + this.stagingExpiryMs,
            isReady: true
        });
    }

    private findRelatedReceivers(senderId: string): string[] {
        const related: { receiverId: string, count: number, lastUsed: number }[] = [];
        
        // Find receivers that have been used with this sender
        for (const [pattern, data] of this.connectionPatterns.entries()) {
            const [patternSender, patternReceiver] = pattern.split('->');
            if (patternSender === senderId && data.count >= 2) {
                related.push({
                    receiverId: patternReceiver,
                    count: data.count,
                    lastUsed: data.lastUsed
                });
            }
        }
        
        // Sort by usage frequency and recency, return more receivers for batching
        return related
            .sort((a, b) => {
                // Prioritize by count, then by recency
                if (b.count !== a.count) return b.count - a.count;
                return b.lastUsed - a.lastUsed;
            })
            .slice(0, 8) // Increased from 5 to 8 for better parallel staging
            .map(r => r.receiverId);
    }

    private cleanupExpiredStaging(): void {
        const now = Date.now();
        let cleaned = 0;
        
        for (const [key, cache] of this.stagingCache.entries()) {
            if (cache.expiresAt <= now) {
                this.stagingCache.delete(key);
                cleaned++;
            }
        }
        
        if (cleaned > 0) {
            SyncLog.log("info", "predictive_staging", `Cleaned up ${cleaned} expired staged connections`);
        }
    }

}
