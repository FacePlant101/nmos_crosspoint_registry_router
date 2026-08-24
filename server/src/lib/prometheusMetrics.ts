import { Registry, Histogram, Gauge, Counter, collectDefaultMetrics } from 'prom-client';
import { ConnectionLatencyMeasurement } from './connectionLatencyMeasurement';
import { NmosHealthMonitor } from './nmosHealthMonitor';

export class PrometheusMetrics {
    private static instance: PrometheusMetrics | null = null;
    private registry: Registry;
    
    // Connection metrics
    private connectionLatencyHistogram: Histogram<string>;
    private connectionSuccessRate: Gauge<string>;
    private connectionCounter: Counter<string>;
    private phaseLatencyHistogram: Histogram<string>;
    
    // Device health metrics
    private deviceHealthGauge: Gauge<string>;
    private deviceLatencyGauge: Gauge<string>;
    private deviceSuccessRateGauge: Gauge<string>;
    private deviceConnectionsCounter: Counter<string>;
    private consecutiveFailuresGauge: Gauge<string>;
    
    // NMOS registry metrics
    private nmosRegistryStatus: Gauge<string>;
    private nmosDeviceCount: Gauge<string>;
    private nmosSenderCount: Gauge<string>;
    private nmosReceiverCount: Gauge<string>;
    
    constructor() {
        if (PrometheusMetrics.instance) {
            return PrometheusMetrics.instance;
        }
        
        this.registry = new Registry();
        collectDefaultMetrics({ register: this.registry });
        
        // Connection latency metrics
        this.connectionLatencyHistogram = new Histogram({
            name: 'nmos_connection_latency_seconds',
            help: 'Histogram of connection latencies in seconds',
            labelNames: ['mode', 'source_type', 'destination_type'],
            buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
            registers: [this.registry]
        });
        
        this.connectionSuccessRate = new Gauge({
            name: 'nmos_connection_success_rate',
            help: 'Success rate of connections (0-1)',
            registers: [this.registry]
        });
        
        this.connectionCounter = new Counter({
            name: 'nmos_connections_total',
            help: 'Total number of connection attempts',
            labelNames: ['status', 'mode'],
            registers: [this.registry]
        });
        
        this.phaseLatencyHistogram = new Histogram({
            name: 'nmos_connection_phase_latency_seconds',
            help: 'Latency of individual connection phases',
            labelNames: ['phase'],
            buckets: [0.01, 0.05, 0.1, 0.5, 1, 2, 5],
            registers: [this.registry]
        });
        
        // Device health metrics
        this.deviceHealthGauge = new Gauge({
            name: 'nmos_device_healthy',
            help: 'Device health status (1=healthy, 0=unhealthy)',
            labelNames: ['device_id', 'device_name', 'priority'],
            registers: [this.registry]
        });
        
        this.deviceLatencyGauge = new Gauge({
            name: 'nmos_device_avg_latency_seconds',
            help: 'Average latency for device connections',
            labelNames: ['device_id', 'device_name'],
            registers: [this.registry]
        });
        
        this.deviceSuccessRateGauge = new Gauge({
            name: 'nmos_device_success_rate',
            help: 'Success rate for device connections (0-1)',
            labelNames: ['device_id', 'device_name'],
            registers: [this.registry]
        });
        
        this.deviceConnectionsCounter = new Counter({
            name: 'nmos_device_connections_total',
            help: 'Total connections per device',
            labelNames: ['device_id', 'device_name'],
            registers: [this.registry]
        });
        
        this.consecutiveFailuresGauge = new Gauge({
            name: 'nmos_device_consecutive_failures',
            help: 'Number of consecutive failures for device',
            labelNames: ['device_id', 'device_name'],
            registers: [this.registry]
        });
        
        // NMOS registry metrics
        this.nmosRegistryStatus = new Gauge({
            name: 'nmos_registry_connected',
            help: 'NMOS registry connection status (1=connected, 0=disconnected)',
            labelNames: ['registry_url'],
            registers: [this.registry]
        });
        
        this.nmosDeviceCount = new Gauge({
            name: 'nmos_devices_total',
            help: 'Total number of NMOS devices discovered',
            registers: [this.registry]
        });
        
        this.nmosSenderCount = new Gauge({
            name: 'nmos_senders_total',
            help: 'Total number of NMOS senders discovered',
            registers: [this.registry]
        });
        
        this.nmosReceiverCount = new Gauge({
            name: 'nmos_receivers_total',
            help: 'Total number of NMOS receivers discovered',
            registers: [this.registry]
        });
        
        PrometheusMetrics.instance = this;
        
        // Update metrics every 30 seconds
        setInterval(() => this.updateMetrics(), 30000);
    }
    
    static getInstance(): PrometheusMetrics {
        if (!PrometheusMetrics.instance) {
            PrometheusMetrics.instance = new PrometheusMetrics();
        }
        return PrometheusMetrics.instance;
    }
    
    private updateMetrics(): void {
        this.updateConnectionMetrics();
        this.updateDeviceHealthMetrics();
    }
    
    private updateConnectionMetrics(): void {
        const latencyMeasurement = ConnectionLatencyMeasurement.getInstance();
        if (!latencyMeasurement) return;
        
        const stats = (latencyMeasurement as any).getStats();
        
        // Update connection success rate
        this.connectionSuccessRate.set(stats.successRate);
        
        // Update recent measurements
        for (const measurement of stats.measurements.slice(-100)) {
            const labels = {
                mode: measurement.connectionData.mode,
                source_type: measurement.connectionData.sourceId?.includes('_') ? 
                    measurement.connectionData.sourceId.split('_')[0] : 'unknown',
                destination_type: measurement.connectionData.destinationId?.includes('_') ? 
                    measurement.connectionData.destinationId.split('_')[0] : 'unknown'
            };
            
            // Record latency
            this.connectionLatencyHistogram.observe(labels, measurement.totalLatency / 1000);
            
            // Record connection attempt
            this.connectionCounter.inc({
                status: measurement.success ? 'success' : 'failure',
                mode: measurement.connectionData.mode
            });
            
            // Record phase latencies
            Object.entries(measurement.phases).forEach(([phase, latency]) => {
                if (typeof latency === 'number') {
                    this.phaseLatencyHistogram.observe({ phase }, latency / 1000);
                }
            });
        }
    }
    
    private updateDeviceHealthMetrics(): void {
        const healthMonitor = NmosHealthMonitor.getInstance();
        if (!healthMonitor) return;
        
        const healthStats = (healthMonitor as any).getHealthSummary();
        
        // Update per-device metrics
        for (const device of healthStats.topDevices || []) {
            const labels = {
                device_id: device.deviceId,
                device_name: device.deviceName || device.deviceId
            };
            
            this.deviceHealthGauge.set({
                ...labels,
                priority: device.priority
            }, device.isHealthy ? 1 : 0);
            
            this.deviceLatencyGauge.set(labels, device.avgLatency / 1000);
            this.deviceSuccessRateGauge.set(labels, device.successRate);
            this.consecutiveFailuresGauge.set(labels, device.consecutiveFailures);
        }
    }
    
    updateNmosRegistryMetrics(registries: Array<{url: string, connected: boolean}>, 
                             deviceCount: number, senderCount: number, receiverCount: number): void {
        // Update registry connection status
        for (const registry of registries) {
            this.nmosRegistryStatus.set(
                { registry_url: registry.url }, 
                registry.connected ? 1 : 0
            );
        }
        
        // Update counts
        this.nmosDeviceCount.set(deviceCount);
        this.nmosSenderCount.set(senderCount);
        this.nmosReceiverCount.set(receiverCount);
    }
    
    recordConnection(success: boolean, latency: number, mode: string): void {
        this.connectionCounter.inc({
            status: success ? 'success' : 'failure',
            mode
        });
        
        this.connectionLatencyHistogram.observe({
            mode,
            source_type: 'unknown',
            destination_type: 'unknown'
        }, latency / 1000);
    }
    
    async getMetrics(): Promise<string> {
        return await this.registry.metrics();
    }
    
    getRegistry(): Registry {
        return this.registry;
    }
}
