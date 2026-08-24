import { SyncLog } from "./syncLog";
import { SyncObject } from "./SyncServer/syncObject";

export interface DeviceHealthMetrics {
    deviceId: string;
    deviceName: string;
    avgLatency: number;
    successRate: number;
    totalConnections: number;
    lastConnectionTime: number;
    consecutiveFailures: number;
    isHealthy: boolean;
    priority: 'high' | 'medium' | 'low';
}

export interface ConnectionAttempt {
    deviceId: string;
    latency: number;
    success: boolean;
    timestamp: number;
    errorMessage?: string;
}

export class NmosHealthMonitor {
    private static instance: NmosHealthMonitor;
    private deviceMetrics = new Map<string, DeviceHealthMetrics>();
    private recentAttempts = new Map<string, ConnectionAttempt[]>();
    private syncHealthStats: SyncObject;
    
    // Configuration
    private readonly maxHistoryPerDevice = 50;
    private readonly healthThreshold = 0.8; // 80% success rate
    private readonly latencyThreshold = 1000; // 1 second
    private readonly maxConsecutiveFailures = 3;
    private readonly cleanupIntervalMs = 5 * 60 * 1000; // 5 minutes

    constructor() {
        NmosHealthMonitor.instance = this;
        this.syncHealthStats = new SyncObject("nmosHealthStats", this.getHealthSummary());
        
        // Cleanup old data periodically
        setInterval(() => {
            this.cleanupOldData();
        }, this.cleanupIntervalMs);
    }

    /** The `nmosHealthStats` sync object. Exposed so server.ts can register it
     *  with the sync server — it was created but never registered, so the UI
     *  could not subscribe to it. */
    public getSyncHealthStats(): SyncObject {
        return this.syncHealthStats;
    }

    static getInstance(): NmosHealthMonitor {
        if (!NmosHealthMonitor.instance) {
            NmosHealthMonitor.instance = new NmosHealthMonitor();
        }
        return NmosHealthMonitor.instance;
    }

    /**
     * Record a connection attempt result
     */
    recordConnectionAttempt(attempt: ConnectionAttempt): void {
        const { deviceId } = attempt;
        
        // Add to recent attempts
        if (!this.recentAttempts.has(deviceId)) {
            this.recentAttempts.set(deviceId, []);
        }
        
        const attempts = this.recentAttempts.get(deviceId)!;
        attempts.push(attempt);
        
        // Keep only recent attempts
        if (attempts.length > this.maxHistoryPerDevice) {
            attempts.splice(0, attempts.length - this.maxHistoryPerDevice);
        }
        
        // Update device metrics
        this.updateDeviceMetrics(deviceId);
        
        // Update sync object
        this.syncHealthStats.setState(this.getHealthSummary());
        
        // Log health issues
        const metrics = this.deviceMetrics.get(deviceId);
        if (metrics && !metrics.isHealthy) {
            SyncLog.log("warning", "nmos_health", 
                `Device ${metrics.deviceName} (${deviceId}) health degraded`, {
                    successRate: metrics.successRate,
                    avgLatency: metrics.avgLatency,
                    consecutiveFailures: metrics.consecutiveFailures
                });
        }
    }

    /**
     * Get prioritized device list for connection attempts
     */
    getPrioritizedDevices(): DeviceHealthMetrics[] {
        const devices = Array.from(this.deviceMetrics.values());
        
        return devices.sort((a, b) => {
            // Sort by priority first, then by health metrics
            const priorityOrder = { high: 3, medium: 2, low: 1 };
            const aPriority = priorityOrder[a.priority];
            const bPriority = priorityOrder[b.priority];
            
            if (aPriority !== bPriority) {
                return bPriority - aPriority;
            }
            
            // Within same priority, prefer healthier devices
            if (a.isHealthy !== b.isHealthy) {
                return a.isHealthy ? -1 : 1;
            }
            
            // Finally sort by combined health score
            const aScore = a.successRate - (a.avgLatency / 1000);
            const bScore = b.successRate - (b.avgLatency / 1000);
            return bScore - aScore;
        });
    }

    /**
     * Check if a device should be avoided for new connections
     */
    shouldAvoidDevice(deviceId: string): boolean {
        const metrics = this.deviceMetrics.get(deviceId);
        if (!metrics) return false;
        
        return !metrics.isHealthy || 
               metrics.consecutiveFailures >= this.maxConsecutiveFailures ||
               metrics.avgLatency > this.latencyThreshold * 2;
    }

    /**
     * Get optimal timeout for a device based on its performance
     */
    getOptimalTimeout(deviceId: string): number {
        const metrics = this.deviceMetrics.get(deviceId);
        if (!metrics) return 5000; // Default 5s
        
        // Base timeout on average latency with safety margin
        const baseTimeout = Math.max(1000, metrics.avgLatency * 2);
        
        // Adjust based on success rate
        const reliabilityMultiplier = metrics.successRate < 0.8 ? 1.5 : 1.0;
        
        return Math.min(10000, baseTimeout * reliabilityMultiplier);
    }

    /**
     * Update metrics for a specific device
     */
    private updateDeviceMetrics(deviceId: string): void {
        const attempts = this.recentAttempts.get(deviceId);
        if (!attempts || attempts.length === 0) return;
        
        const successfulAttempts = attempts.filter(a => a.success);
        const recentAttempts = attempts.slice(-10); // Last 10 attempts for consecutive failures
        
        const successRate = successfulAttempts.length / attempts.length;
        const avgLatency = attempts.reduce((sum, a) => sum + a.latency, 0) / attempts.length;
        
        // Count consecutive failures from the end
        let consecutiveFailures = 0;
        for (let i = recentAttempts.length - 1; i >= 0; i--) {
            if (!recentAttempts[i].success) {
                consecutiveFailures++;
            } else {
                break;
            }
        }
        
        const isHealthy = successRate >= this.healthThreshold && 
                         avgLatency <= this.latencyThreshold &&
                         consecutiveFailures < this.maxConsecutiveFailures;
        
        // Determine priority based on performance
        let priority: 'high' | 'medium' | 'low' = 'medium';
        if (successRate >= 0.95 && avgLatency <= 500) {
            priority = 'high';
        } else if (successRate < 0.7 || avgLatency > this.latencyThreshold) {
            priority = 'low';
        }
        
        const lastAttempt = attempts[attempts.length - 1];
        
        this.deviceMetrics.set(deviceId, {
            deviceId,
            deviceName: this.getDeviceName(deviceId),
            avgLatency: Math.round(avgLatency * 100) / 100,
            successRate: Math.round(successRate * 1000) / 1000,
            totalConnections: attempts.length,
            lastConnectionTime: lastAttempt.timestamp,
            consecutiveFailures,
            isHealthy,
            priority
        });
    }

    /**
     * Get device name from ID (fallback to ID if name not found)
     */
    private getDeviceName(deviceId: string): string {
        // This would ideally integrate with the NMOS state to get device names
        // For now, return a cleaned up version of the ID
        return deviceId.replace(/^nmos_/, '').substring(0, 12) + '...';
    }

    /**
     * Get health summary for sync object
     */
    private getHealthSummary() {
        const devices = Array.from(this.deviceMetrics.values());
        const healthyDevices = devices.filter(d => d.isHealthy).length;
        const totalDevices = devices.length;
        
        const avgSuccessRate = devices.length > 0 
            ? devices.reduce((sum, d) => sum + d.successRate, 0) / devices.length 
            : 1.0;
        
        const avgLatency = devices.length > 0
            ? devices.reduce((sum, d) => sum + d.avgLatency, 0) / devices.length
            : 0;
        
        return {
            totalDevices,
            healthyDevices,
            unhealthyDevices: totalDevices - healthyDevices,
            avgSuccessRate: Math.round(avgSuccessRate * 1000) / 1000,
            avgLatency: Math.round(avgLatency * 100) / 100,
            lastUpdated: Date.now(),
            topDevices: devices
                .sort((a, b) => (b.successRate - b.avgLatency/1000) - (a.successRate - a.avgLatency/1000))
                .slice(0, 5)
                .map(d => ({
                    deviceId: d.deviceId,
                    deviceName: d.deviceName,
                    successRate: d.successRate,
                    avgLatency: d.avgLatency,
                    priority: d.priority
                }))
        };
    }

    /**
     * Clean up old connection attempt data
     */
    private cleanupOldData(): void {
        const cutoffTime = Date.now() - (24 * 60 * 60 * 1000); // 24 hours ago
        let cleanedDevices = 0;
        
        for (const [deviceId, attempts] of this.recentAttempts.entries()) {
            const filteredAttempts = attempts.filter(a => a.timestamp > cutoffTime);
            
            if (filteredAttempts.length === 0) {
                this.recentAttempts.delete(deviceId);
                this.deviceMetrics.delete(deviceId);
                cleanedDevices++;
            } else if (filteredAttempts.length !== attempts.length) {
                this.recentAttempts.set(deviceId, filteredAttempts);
                this.updateDeviceMetrics(deviceId);
            }
        }
        
        if (cleanedDevices > 0) {
            SyncLog.log("info", "nmos_health", `Cleaned up ${cleanedDevices} inactive devices from health monitoring`);
            this.syncHealthStats.setState(this.getHealthSummary());
        }
    }
}
