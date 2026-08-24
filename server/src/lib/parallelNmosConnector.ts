import { NmosRegistryConnector } from "./nmosConnector";
import { CrosspointConnectionSenderInfo } from "./crosspointAbstraction";
import { SyncLog } from "./syncLog";

export interface ParallelConnectionRequest {
    receiverId: string;
    senderInfo: CrosspointConnectionSenderInfo;
    prepareOnly?: boolean;
}

export interface ParallelConnectionResult {
    receiverId: string;
    success: boolean;
    logId?: string;
    error?: string;
    latency: number;
}

export class ParallelNmosConnector {
    private static instance: ParallelNmosConnector;

    static getInstance(): ParallelNmosConnector {
        if (!ParallelNmosConnector.instance) {
            ParallelNmosConnector.instance = new ParallelNmosConnector();
        }
        return ParallelNmosConnector.instance;
    }

    /**
     * Execute multiple NMOS connections in parallel
     * Reduces total latency by running HTTP PATCH requests concurrently
     */
    async makeParallelConnections(requests: ParallelConnectionRequest[]): Promise<ParallelConnectionResult[]> {
        const startTime = performance.now();
        
        SyncLog.log("info", "parallel_nmos", `Starting parallel connection batch: ${requests.length} receivers`);

        // Execute all connections in parallel
        const connectionPromises = requests.map(async (request): Promise<ParallelConnectionResult> => {
            const requestStartTime = performance.now();
            
            try {
                const logId = await NmosRegistryConnector.instance.makeConnection(
                    request.receiverId, 
                    request.senderInfo, 
                    request.prepareOnly ?? false
                );
                
                const latency = performance.now() - requestStartTime;
                
                return {
                    receiverId: request.receiverId,
                    success: true,
                    logId: String(logId),
                    latency: Math.round(latency * 100) / 100
                };
            } catch (error) {
                const latency = performance.now() - requestStartTime;
                
                return {
                    receiverId: request.receiverId,
                    success: false,
                    error: error instanceof Error ? error.message : String(error),
                    latency: Math.round(latency * 100) / 100
                };
            }
        });

        // Wait for all connections to complete
        const results = await Promise.allSettled(connectionPromises);
        
        const finalResults: ParallelConnectionResult[] = results.map((result, index) => {
            if (result.status === 'fulfilled') {
                return result.value;
            } else {
                return {
                    receiverId: requests[index].receiverId,
                    success: false,
                    error: result.reason instanceof Error ? result.reason.message : String(result.reason),
                    latency: 0
                };
            }
        });

        const totalLatency = performance.now() - startTime;
        const successCount = finalResults.filter(r => r.success).length;
        const avgIndividualLatency = finalResults.reduce((sum, r) => sum + r.latency, 0) / finalResults.length;
        
        SyncLog.log("info", "parallel_nmos", `Parallel connection batch completed`, {
            totalRequests: requests.length,
            successCount,
            failureCount: requests.length - successCount,
            totalLatency: Math.round(totalLatency * 100) / 100,
            avgIndividualLatency: Math.round(avgIndividualLatency * 100) / 100,
            parallelizationGain: Math.round((avgIndividualLatency * requests.length - totalLatency) * 100) / 100
        });

        return finalResults;
    }

    /**
     * Batch multiple same-sender connections efficiently
     * Uses parallel execution with shared sender info lookup
     */
    async makeBatchConnection(
        senderId: string, 
        receiverIds: string[], 
        prepareOnly: boolean = false
    ): Promise<ParallelConnectionResult[]> {
        
        if (receiverIds.length === 0) return [];
        
        // Get sender info once for all receivers
        let senderInfo: CrosspointConnectionSenderInfo;
        try {
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
        } catch (error) {
            // If sender info fails, return failure for all receivers
            return receiverIds.map(receiverId => ({
                receiverId,
                success: false,
                error: `Failed to get sender info: ${error instanceof Error ? error.message : String(error)}`,
                latency: 0
            }));
        }

        // Create parallel connection requests
        const requests: ParallelConnectionRequest[] = receiverIds.map(receiverId => ({
            receiverId: receiverId.startsWith("nmos_") ? receiverId.slice(5) : receiverId,
            senderInfo,
            prepareOnly
        }));

        return this.makeParallelConnections(requests);
    }
}
