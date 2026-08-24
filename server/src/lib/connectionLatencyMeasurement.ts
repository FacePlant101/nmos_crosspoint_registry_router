import { SyncObject } from "./SyncServer/syncObject";
import { SyncLog } from "./syncLog";
import { NmosRegistryConnector } from "./nmosConnector";
import axios from "axios";

const crypto = require('crypto');

export interface LatencyTimingContext {
    connectionId: string;
    startTime: number;
    phases: {
        deviceResolution?: number;
        senderInfoRetrieved?: number;
        patchSent?: number;
        patchResponse?: number;
        streamActive?: number;
    };
    connectionData: {
        sourceId?: string;
        destinationId?: string;
        mode: 'immediate' | 'prepare' | 'preview';
    };
}

export interface LatencyMeasurement {
    connectionId: string;
    timestamp: number;
    totalLatency: number;
    phases: {
        deviceResolution: number;
        senderInfoRetrieval: number;
        nmosPatching: number;
        streamActivation?: number;
    };
    connectionData: {
        sourceId?: string;
        destinationId?: string;
        mode: 'immediate' | 'prepare' | 'preview';
    };
    success: boolean;
    error?: string;
}

export interface LatencyStats {
    measurements: LatencyMeasurement[];
    averageLatency: number;
    medianLatency: number;
    p95Latency: number;
    p99Latency: number;
    successRate: number;
    totalConnections: number;
    lastUpdated: number;
}

export class ConnectionLatencyMeasurement {
    private static instance: ConnectionLatencyMeasurement | null = null;
    private syncLatencyStats: SyncObject;
    private measurements: LatencyMeasurement[] = [];
    private activeConnections: Map<string, LatencyTimingContext> = new Map();
    private maxMeasurements = 1000; // Keep last 1000 measurements

    constructor() {
        ConnectionLatencyMeasurement.instance = this;
        this.syncLatencyStats = new SyncObject("latencyStats", this.getStats());
        
        // Clean up old measurements every 5 minutes
        setInterval(() => {
            this.cleanupOldMeasurements();
        }, 5 * 60 * 1000);
    }

    static getInstance(): ConnectionLatencyMeasurement {
        if (!ConnectionLatencyMeasurement.instance) {
            ConnectionLatencyMeasurement.instance = new ConnectionLatencyMeasurement();
        }
        return ConnectionLatencyMeasurement.instance;
    }

    /**
     * Start timing a new connection
     */
    startConnectionTiming(connectionData: {
        sourceId?: string;
        destinationId?: string;
        mode: 'immediate' | 'prepare' | 'preview';
    }): LatencyTimingContext {
        const context: LatencyTimingContext = {
            connectionId: crypto.randomUUID(),
            startTime: performance.now(),
            phases: {},
            connectionData
        };

        this.activeConnections.set(context.connectionId, context);
        
        SyncLog.log("info", "latency_measurement", `Started timing connection ${context.connectionId}`, {
            mode: connectionData.mode,
            source: connectionData.sourceId,
            destination: connectionData.destinationId
        });

        return context;
    }

    /**
     * Mark a timing phase completion
     */
    markPhase(connectionId: string, phase: keyof LatencyTimingContext['phases']): void {
        const context = this.activeConnections.get(connectionId);
        if (!context) {
            SyncLog.log("warning", "latency_measurement", `No active connection found for ID ${connectionId}`);
            return;
        }

        context.phases[phase] = performance.now();
        SyncLog.log("info", "latency_measurement", `Phase ${phase} completed for connection ${connectionId}`, {
            elapsed: Math.round((context.phases[phase]! - context.startTime) * 100) / 100
        });
    }

    /**
     * Complete a connection measurement
     */
    completeConnectionMeasurement(connectionId: string, success: boolean, error?: string): LatencyMeasurement | null {
        const context = this.activeConnections.get(connectionId);
        if (!context) {
            SyncLog.log("warning", "latency_measurement", `No active connection found for ID ${connectionId}`);
            return null;
        }

        const endTime = performance.now();
        const totalLatency = endTime - context.startTime;

        const measurement: LatencyMeasurement = {
            connectionId,
            timestamp: Date.now(),
            totalLatency,
            phases: {
                deviceResolution: (context.phases.deviceResolution || context.startTime) - context.startTime,
                senderInfoRetrieval: (context.phases.senderInfoRetrieved || context.phases.deviceResolution || context.startTime) - (context.phases.deviceResolution || context.startTime),
                nmosPatching: (context.phases.patchResponse || endTime) - (context.phases.patchSent || context.phases.senderInfoRetrieved || context.phases.deviceResolution || context.startTime),
                streamActivation: context.phases.streamActive ? context.phases.streamActive - (context.phases.patchResponse || endTime) : undefined
            },
            connectionData: context.connectionData,
            success,
            error
        };

        this.measurements.push(measurement);
        this.activeConnections.delete(connectionId);

        // Trim measurements if we exceed max
        if (this.measurements.length > this.maxMeasurements) {
            this.measurements = this.measurements.slice(-this.maxMeasurements);
        }

        // Update sync object with new stats
        this.syncLatencyStats.setState(this.getStats());

        SyncLog.log("info", "latency_measurement", `Connection measurement completed`, {
            connectionId,
            totalLatency: Math.round(totalLatency * 100) / 100,
            success,
            phases: {
                deviceResolution: Math.round(measurement.phases.deviceResolution * 100) / 100,
                senderInfoRetrieval: Math.round(measurement.phases.senderInfoRetrieval * 100) / 100,
                nmosPatching: Math.round(measurement.phases.nmosPatching * 100) / 100,
                streamActivation: measurement.phases.streamActivation ? Math.round(measurement.phases.streamActivation * 100) / 100 : undefined
            }
        });

        return measurement;
    }

    /**
     * Attempt to detect when a stream becomes active
     */
    async detectStreamActive(connectionId: string, receiverId: string, timeoutMs: number = 10000): Promise<void> {
        const context = this.activeConnections.get(connectionId);
        if (!context) return;

        const startTime = performance.now();
        const endTime = startTime + timeoutMs;

        try {
            // Poll receiver status until stream is active or timeout
            while (performance.now() < endTime) {
                try {
                    const isActive = await this.checkReceiverActive(receiverId);
                    if (isActive) {
                        this.markPhase(connectionId, 'streamActive');
                        SyncLog.log("info", "latency_measurement", `Stream active detected for connection ${connectionId}`, {
                            detectionLatency: performance.now() - startTime
                        });
                        return;
                    }
                } catch (e) {
                    // Continue polling on errors
                }

                // Wait 100ms before next poll
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            SyncLog.log("warning", "latency_measurement", `Stream active detection timed out for connection ${connectionId}`);
        } catch (e) {
            SyncLog.log("error", "latency_measurement", `Error detecting stream active for connection ${connectionId}`, e);
        }
    }

    /**
     * Check if a receiver is actively receiving a stream
     */
    private async checkReceiverActive(receiverId: string): Promise<boolean> {
        try {
            if (!receiverId.startsWith("nmos_")) return false;
            
            const nmosId = receiverId.slice(5);
            const nmosState = NmosRegistryConnector.instance?.getNmosState();
            const receiver = nmosState?.receivers?.[nmosId];
            
            if (!receiver) return false;

            const device = nmosState?.devices?.[receiver.device_id];
            if (!device || !device.controls || device.controls.length === 0) return false;

            // Try to get receiver active status from control endpoint
            for (const control of device.controls) {
                if (control.type.includes("sr-ctrl")) {
                    const activeHref = `${control.href.replace(/\/$/, '')}/single/receivers/${nmosId}/active`;
                    try {
                        const response = await axios.get(activeHref, { timeout: 2000 });
                        return response.data?.master_enable === true && response.data?.sender_id !== null;
                    } catch (e) {
                        // Try next control endpoint
                        continue;
                    }
                }
            }

            return false;
        } catch (e) {
            return false;
        }
    }

    /**
     * Get current latency statistics
     */
    private getStats(): LatencyStats {
        if (this.measurements.length === 0) {
            return {
                measurements: [],
                averageLatency: 0,
                medianLatency: 0,
                p95Latency: 0,
                p99Latency: 0,
                successRate: 0,
                totalConnections: 0,
                lastUpdated: Date.now()
            };
        }

        const latencies = this.measurements.map(m => m.totalLatency).sort((a, b) => a - b);
        const successfulConnections = this.measurements.filter(m => m.success).length;

        return {
            measurements: this.measurements.slice(-100), // Return last 100 measurements
            averageLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length,
            medianLatency: latencies[Math.floor(latencies.length / 2)],
            p95Latency: latencies[Math.floor(latencies.length * 0.95)],
            p99Latency: latencies[Math.floor(latencies.length * 0.99)],
            successRate: successfulConnections / this.measurements.length,
            totalConnections: this.measurements.length,
            lastUpdated: Date.now()
        };
    }

    /**
     * Clean up old measurements to prevent memory leaks
     */
    private cleanupOldMeasurements(): void {
        const cutoffTime = Date.now() - (24 * 60 * 60 * 1000); // 24 hours ago
        const initialCount = this.measurements.length;
        
        this.measurements = this.measurements.filter(m => m.timestamp > cutoffTime);
        
        if (this.measurements.length < initialCount) {
            SyncLog.log("info", "latency_measurement", `Cleaned up ${initialCount - this.measurements.length} old measurements`);
            this.syncLatencyStats.setState(this.getStats());
        }
    }

    /**
     * Get detailed measurement for a specific connection
     */
    getMeasurement(connectionId: string): LatencyMeasurement | undefined {
        return this.measurements.find(m => m.connectionId === connectionId);
    }

    /**
     * Get recent measurements with optional filtering
     */
    getRecentMeasurements(count: number = 50, mode?: 'immediate' | 'prepare' | 'preview'): LatencyMeasurement[] {
        let filtered = this.measurements;
        
        if (mode) {
            filtered = filtered.filter(m => m.connectionData.mode === mode);
        }
        
        return filtered.slice(-count);
    }
}
