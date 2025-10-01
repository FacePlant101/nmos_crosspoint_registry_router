/*
    NMOS Crosspoint - Atomic State Manager
    Copyright (C) 2024 
    
    Implements atomic state changes for NMOS resources following the Matrox NMOS Advanced 
    Streaming Architecture principles:
    - Immutable Sources and Flows (read-only after creation)
    - Mutable Senders and Receivers (anchor points for atomic updates)
    - Consistent state management during switching operations
*/

import { SyncLog } from "./syncLog";
import { SyncObject } from "./SyncServer/syncObject";

export interface AtomicNmosState {
    // Immutable resources - never updated, only created/deleted
    sources: { [id: string]: ImmutableSource };
    flows: { [id: string]: ImmutableFlow };
    
    // Mutable resources - can be updated atomically
    senders: { [id: string]: MutableSender };
    receivers: { [id: string]: MutableReceiver };
    
    // Infrastructure resources (mutable)
    nodes: { [id: string]: any };
    devices: { [id: string]: any };
    
    // Additional state tracking
    resourceLifecycle: { [id: string]: ResourceLifecycle };
    pendingAtomicOperations: { [operationId: string]: AtomicOperation };
}

interface ImmutableSource {
    readonly id: string;
    readonly data: any;
    readonly version: string;
    readonly createdAt: number;
    readonly hash: string; // Hash of immutable data for validation
}

interface ImmutableFlow {
    readonly id: string;
    readonly data: any;
    readonly version: string;
    readonly createdAt: number;
    readonly hash: string;
    readonly parentSources: string[]; // References to source IDs
}

interface MutableSender {
    id: string;
    data: any;
    version: string;
    lastUpdated: number;
    flow_id: string; // Key field for atomic updates
    activeConnections: string[]; // Receiver IDs connected to this sender
}

interface MutableReceiver {
    id: string;
    data: any;
    version: string;
    lastUpdated: number;
    sender_id: string | null; // Current sender connection
    stagingData?: any; // For prepare-only operations
}

interface ResourceLifecycle {
    id: string;
    type: 'source' | 'flow' | 'sender' | 'receiver';
    referencedBy: string[]; // IDs of resources that reference this one
    canGarbageCollect: boolean;
    lastReferenceCheck: number;
}

interface AtomicOperation {
    id: string;
    type: 'connection' | 'disconnection' | 'flow_switch';
    targetReceivers: string[];
    sourceData: {
        senderId?: string;
        flowId?: string;
        sourceIds?: string[];
    };
    startedAt: number;
    status: 'pending' | 'committing' | 'completed' | 'failed' | 'rolling_back';
    rollbackData?: any;
}

export class AtomicNmosStateManager {
    private state: AtomicNmosState;
    private syncObject: SyncObject;
    private garbageCollectionTimer: NodeJS.Timeout | null = null;
    private operationCounter = 0;

    constructor() {
        this.state = {
            sources: {},
            flows: {},
            senders: {},
            receivers: {},
            nodes: {},
            devices: {},
            resourceLifecycle: {},
            pendingAtomicOperations: {}
        };
        
        this.syncObject = new SyncObject("atomicNmosState", this.state);
        this.startGarbageCollectionTimer();
        
        SyncLog.log("info", "atomic_nmos", "Atomic NMOS State Manager initialized");
    }

    /**
     * Create or update immutable source (creates new version if data changes)
     */
    public createImmutableSource(id: string, data: any, version: string): string {
        const hash = this.calculateHash(data);
        const existingSource = this.state.sources[id];
        
        // If source exists with same hash, return existing ID
        if (existingSource && existingSource.hash === hash) {
            return id;
        }
        
        // If data changed, create new source with versioned ID
        const versionedId = existingSource ? `${id}_v${Date.now()}` : id;
        
        const immutableSource: ImmutableSource = {
            id: versionedId,
            data: this.deepFreeze(data),
            version,
            createdAt: Date.now(),
            hash
        };
        
        this.state.sources[versionedId] = immutableSource;
        this.updateResourceLifecycle(versionedId, 'source');
        
        SyncLog.log("debug", "atomic_nmos", `Created immutable source: ${versionedId}`);
        return versionedId;
    }

    /**
     * Create or update immutable flow (creates new version if data changes)
     */
    public createImmutableFlow(id: string, data: any, version: string, parentSources: string[]): string {
        const hash = this.calculateHash(data);
        const existingFlow = this.state.flows[id];
        
        // If flow exists with same hash and sources, return existing ID
        if (existingFlow && existingFlow.hash === hash && 
            JSON.stringify(existingFlow.parentSources) === JSON.stringify(parentSources)) {
            return id;
        }
        
        // If data changed, create new flow with versioned ID
        const versionedId = existingFlow ? `${id}_v${Date.now()}` : id;
        
        const immutableFlow: ImmutableFlow = {
            id: versionedId,
            data: this.deepFreeze(data),
            version,
            createdAt: Date.now(),
            hash,
            parentSources: [...parentSources]
        };
        
        this.state.flows[versionedId] = immutableFlow;
        this.updateResourceLifecycle(versionedId, 'flow');
        
        // Update references to parent sources
        parentSources.forEach(sourceId => {
            this.addReference(sourceId, versionedId);
        });
        
        SyncLog.log("debug", "atomic_nmos", `Created immutable flow: ${versionedId}`);
        return versionedId;
    }

    /**
     * Update mutable sender (can be modified in place)
     */
    public updateMutableSender(id: string, data: any, version: string): void {
        const now = Date.now();
        
        if (!this.state.senders[id]) {
            this.state.senders[id] = {
                id,
                data: {},
                version: '',
                lastUpdated: now,
                flow_id: '',
                activeConnections: []
            };
            this.updateResourceLifecycle(id, 'sender');
        }
        
        const sender = this.state.senders[id];
        sender.data = data;
        sender.version = version;
        sender.lastUpdated = now;
        sender.flow_id = data.flow_id || '';
        
        SyncLog.log("debug", "atomic_nmos", `Updated mutable sender: ${id}`);
    }

    /**
     * Update mutable receiver (can be modified in place)
     */
    public updateMutableReceiver(id: string, data: any, version: string): void {
        const now = Date.now();
        
        if (!this.state.receivers[id]) {
            this.state.receivers[id] = {
                id,
                data: {},
                version: '',
                lastUpdated: now,
                sender_id: null
            };
            this.updateResourceLifecycle(id, 'receiver');
        }
        
        const receiver = this.state.receivers[id];
        receiver.data = data;
        receiver.version = version;
        receiver.lastUpdated = now;
        receiver.sender_id = data.subscription?.sender_id || null;
        
        SyncLog.log("debug", "atomic_nmos", `Updated mutable receiver: ${id}`);
    }

    /**
     * Perform atomic connection switch by updating only sender's flow_id
     */
    public async performAtomicConnectionSwitch(
        receiverIds: string[],
        newSenderId: string,
        newFlowId: string,
        sourceIds: string[]
    ): Promise<string> {
        const operationId = `atomic_op_${++this.operationCounter}_${Date.now()}`;
        
        const operation: AtomicOperation = {
            id: operationId,
            type: 'connection',
            targetReceivers: receiverIds,
            sourceData: {
                senderId: newSenderId,
                flowId: newFlowId,
                sourceIds
            },
            startedAt: Date.now(),
            status: 'pending',
            rollbackData: {}
        };
        
        // Store rollback data before making changes
        operation.rollbackData = {
            senderState: receiverIds.map(id => ({
                id,
                previousSenderId: this.state.receivers[id]?.sender_id
            }))
        };
        
        this.state.pendingAtomicOperations[operationId] = operation;
        
        try {
            operation.status = 'committing';
            
            // Atomic update: modify only receiver sender_id references
            receiverIds.forEach(receiverId => {
                if (this.state.receivers[receiverId]) {
                    this.state.receivers[receiverId].sender_id = newSenderId;
                    this.state.receivers[receiverId].lastUpdated = Date.now();
                }
            });
            
            // Update sender's active connections
            if (this.state.senders[newSenderId]) {
                this.state.senders[newSenderId].activeConnections = [
                    ...new Set([...this.state.senders[newSenderId].activeConnections, ...receiverIds])
                ];
                this.state.senders[newSenderId].lastUpdated = Date.now();
            }
            
            operation.status = 'completed';
            this.syncState();
            
            SyncLog.log("info", "atomic_nmos", 
                `Atomic connection switch completed: ${receiverIds.length} receivers to sender ${newSenderId}`,
                { operationId, duration: Date.now() - operation.startedAt });
            
            return operationId;
            
        } catch (error) {
            operation.status = 'failed';
            SyncLog.log("error", "atomic_nmos", 
                `Atomic connection switch failed: ${error.message}`, { operationId });
            throw error;
        } finally {
            // Clean up completed operations after a delay
            setTimeout(() => {
                delete this.state.pendingAtomicOperations[operationId];
            }, 30000);
        }
    }

    /**
     * Get current state for external access (read-only)
     */
    public getState(): Readonly<AtomicNmosState> {
        return this.state;
    }

    /**
     * Check if a resource can be safely garbage collected
     */
    private canGarbageCollect(resourceId: string): boolean {
        const lifecycle = this.state.resourceLifecycle[resourceId];
        if (!lifecycle) return false;
        
        return lifecycle.canGarbageCollect && 
               lifecycle.referencedBy.length === 0 &&
               Date.now() - lifecycle.lastReferenceCheck > 60000; // 1 minute grace period
    }

    /**
     * Perform garbage collection of unreferenced immutable resources
     */
    private performGarbageCollection(): void {
        const collectableResources: string[] = [];
        
        // Check sources
        Object.keys(this.state.sources).forEach(sourceId => {
            if (this.canGarbageCollect(sourceId)) {
                collectableResources.push(sourceId);
                delete this.state.sources[sourceId];
                delete this.state.resourceLifecycle[sourceId];
            }
        });
        
        // Check flows
        Object.keys(this.state.flows).forEach(flowId => {
            if (this.canGarbageCollect(flowId)) {
                collectableResources.push(flowId);
                delete this.state.flows[flowId];
                delete this.state.resourceLifecycle[flowId];
            }
        });
        
        if (collectableResources.length > 0) {
            SyncLog.log("info", "atomic_nmos", 
                `Garbage collected ${collectableResources.length} unused immutable resources`,
                { collected: collectableResources });
            this.syncState();
        }
    }

    private updateResourceLifecycle(resourceId: string, type: ResourceLifecycle['type']): void {
        if (!this.state.resourceLifecycle[resourceId]) {
            this.state.resourceLifecycle[resourceId] = {
                id: resourceId,
                type,
                referencedBy: [],
                canGarbageCollect: type === 'source' || type === 'flow',
                lastReferenceCheck: Date.now()
            };
        }
    }

    private addReference(resourceId: string, referencingId: string): void {
        const lifecycle = this.state.resourceLifecycle[resourceId];
        if (lifecycle && !lifecycle.referencedBy.includes(referencingId)) {
            lifecycle.referencedBy.push(referencingId);
            lifecycle.lastReferenceCheck = Date.now();
        }
    }

    private calculateHash(data: any): string {
        return Buffer.from(JSON.stringify(data)).toString('base64').slice(0, 16);
    }

    private deepFreeze(obj: any): any {
        Object.freeze(obj);
        Object.getOwnPropertyNames(obj).forEach(prop => {
            if (obj[prop] !== null && (typeof obj[prop] === "object" || typeof obj[prop] === "function")) {
                this.deepFreeze(obj[prop]);
            }
        });
        return obj;
    }

    private syncState(): void {
        this.syncObject.setState(this.state);
    }

    private startGarbageCollectionTimer(): void {
        this.garbageCollectionTimer = setInterval(() => {
            this.performGarbageCollection();
        }, 300000); // Run garbage collection every 5 minutes
    }

    public destroy(): void {
        if (this.garbageCollectionTimer) {
            clearInterval(this.garbageCollectionTimer);
            this.garbageCollectionTimer = null;
        }
    }
}
