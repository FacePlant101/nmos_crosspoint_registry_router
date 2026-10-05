/**
 * Advanced NMOS Stream Compatibility Management
 * Based on IS-11 Stream Compatibility and MatroxOnly advanced capabilities
 * 
 * Optimizes switching speed by:
 * 1. Pre-validating stream compatibility before PATCH operations
 * 2. Optimizing transport parameters for faster connection establishment
 * 3. Enabling dynamic stream reconfiguration without full reconnection
 */

import { SyncLog } from "./syncLog";
import { NmosRegistryConnector } from "./nmosConnector";
import { isUsbTransport } from "./functions";

export interface StreamCompatibilityResult {
    compatible: boolean;
    reason?: string;
    optimizedTransportParams?: any;
    confidence: number;
    warnings: string[];
}

export interface StreamCapabilities {
    formats: string[];
    resolutions: string[];
    frameRates: number[];
    colorspaces: string[];
    bitDepths: number[];
    maxBitrate: number;
    transports: string[];
    constraints: any;
    // Concrete media types (sender: the flow's media_type, receiver: caps.media_types). An exact
    // match here is compatible on its own; it is what lets a urn:x-nmos:format:mux sender reach a
    // mux receiver, since neither the format URN nor "application/AM824" names a category.
    mediaTypes?: string[];
}

export interface OptimizedTransportParams {
    // RTP specific, absent for non-RTP transports such as USB (see isUsbTransport)
    rtp_enabled?: boolean;
    rtcp_enabled?: boolean;
    destination_ip?: string;
    destination_port?: number;
    source_ip?: string;
    source_port?: number;
    rtcp_destination_ip?: string;
    rtcp_destination_port?: number;
    packet_time?: number;
    fec_enabled?: boolean;
    fec_destination_ip?: string;
    fec_mode?: string;
    rtcp_mode?: string;
}

export class AdvancedNmosCompatibility {
    private static instance: AdvancedNmosCompatibility;
    private compatibilityCache = new Map<string, { result: StreamCompatibilityResult; timestamp: number }>();
    private capabilitiesCache = new Map<string, { capabilities: StreamCapabilities; timestamp: number }>();
    
    // Configuration
    private readonly cacheExpiryMs = 5 * 60 * 1000; // 5 minutes
    private readonly compatibilityThreshold = 0.85;

    constructor() {
        AdvancedNmosCompatibility.instance = this;
        
        // Cleanup caches periodically
        setInterval(() => {
            this.cleanupExpiredCache();
        }, 2 * 60 * 1000); // Every 2 minutes
    }

    static getInstance(): AdvancedNmosCompatibility {
        if (!AdvancedNmosCompatibility.instance) {
            AdvancedNmosCompatibility.instance = new AdvancedNmosCompatibility();
        }
        return AdvancedNmosCompatibility.instance;
    }

    /**
     * Pre-validate stream compatibility before attempting NMOS connection
     * This eliminates retry latency from failed connections
     */
    async validateStreamCompatibility(senderId: string, receiverId: string): Promise<StreamCompatibilityResult> {
        const cacheKey = `${senderId}->${receiverId}`;
        const cached = this.compatibilityCache.get(cacheKey);
        
        if (cached && (Date.now() - cached.timestamp) < this.cacheExpiryMs) {
            return cached.result;
        }

        try {
            const senderCapabilities = await this.getSenderCapabilities(senderId);
            const receiverCapabilities = await this.getReceiverCapabilities(receiverId);
            
            const result = this.computeCompatibility(senderCapabilities, receiverCapabilities, senderId, receiverId);
            
            // Cache the result
            this.compatibilityCache.set(cacheKey, {
                result,
                timestamp: Date.now()
            });
            
            SyncLog.log("info", "compatibility", 
                `Stream compatibility check: ${senderId} -> ${receiverId} = ${result.compatible ? 'COMPATIBLE' : 'INCOMPATIBLE'}`,
                { confidence: result.confidence, warnings: result.warnings.length });
            
            return result;
        } catch (error) {
            const errorResult: StreamCompatibilityResult = {
                compatible: false,
                reason: `Compatibility check failed: ${error instanceof Error ? error.message : String(error)}`,
                confidence: 0,
                warnings: []
            };
            
            SyncLog.log("warning", "compatibility", 
                `Stream compatibility check failed: ${senderId} -> ${receiverId}`, error);
            
            return errorResult;
        }
    }

    /**
     * Get optimized transport parameters for faster connection establishment
     */
    async getOptimizedTransportParams(senderId: string, receiverId: string): Promise<OptimizedTransportParams> {
        try {
            const nmosState = NmosRegistryConnector.instance.getNmosState();
            const sender = nmosState.senders[senderId];
            const receiver = nmosState.receivers[receiverId];
            const flow = sender ? nmosState.flows[sender.flow_id] : null;

            if (!sender || !receiver || !flow) {
                throw new Error("Required NMOS resources not found");
            }

            // Everything below is RTP specific. Non-RTP transports (USB, see isUsbTransport)
            // have no optimizable parameters here, so return an empty set rather than RTP defaults.
            if (isUsbTransport(sender.transport)) {
                return {};
            }

            const optimizedParams: OptimizedTransportParams = {
                rtp_enabled: true,
                rtcp_enabled: true,
                rtcp_mode: "rfc3550"
            };

            // Optimize based on flow characteristics
            if (flow.media_type === "video") {
                // Video-specific optimizations
                optimizedParams.packet_time = this.calculateOptimalPacketTime(flow);
                
                // Enable FEC for high-bitrate video
                if (flow.bit_rate && flow.bit_rate > 100000000) { // 100 Mbps
                    optimizedParams.fec_enabled = true;
                    optimizedParams.fec_mode = "XOR";
                }
            } else if (flow.media_type === "audio") {
                // Audio-specific optimizations
                optimizedParams.packet_time = 1.0; // 1ms for low-latency audio
                optimizedParams.rtcp_enabled = false; // Less critical for audio
            }

            // Network-specific optimizations
            if (receiver.interface_bindings && receiver.interface_bindings.length > 0) {
                const binding = receiver.interface_bindings[0];
                if (binding.includes("127.0.0.1") || binding.includes("localhost")) {
                    // Loopback optimizations
                    optimizedParams.rtcp_enabled = false;
                    optimizedParams.packet_time = 0.125; // Smaller packets for loopback
                }
            }

            SyncLog.log("debug", "compatibility", 
                `Generated optimized transport params for ${senderId} -> ${receiverId}`, optimizedParams);

            return optimizedParams;
        } catch (error) {
            SyncLog.log("warning", "compatibility", 
                `Failed to generate optimized transport params: ${error instanceof Error ? error.message : String(error)}`);
            
            // Return default parameters
            return {
                rtp_enabled: true,
                rtcp_enabled: true,
                rtcp_mode: "rfc3550"
            };
        }
    }

    /**
     * Check if dynamic reconfiguration is possible instead of full reconnection
     */
    async canUseReconfiguration(senderId: string, receiverId: string, newParams: any): Promise<boolean> {
        try {
            const nmosState = NmosRegistryConnector.instance.getNmosState();
            const receiver = nmosState.receivers[receiverId];
            
            if (!receiver || !receiver.subscription || !receiver.subscription.sender_id) {
                return false; // No existing connection to reconfigure
            }
            
            const currentSenderId = receiver.subscription.sender_id;
            if (currentSenderId !== senderId) {
                return false; // Different sender requires full reconnection
            }
            
            // Check if only transport parameters are changing
            const currentParams = receiver.subscription.transport_params || [];
            const hasOnlyTransportChanges = this.compareTransportParams(currentParams, newParams);
            
            if (hasOnlyTransportChanges) {
                SyncLog.log("info", "compatibility", 
                    `Dynamic reconfiguration available for ${senderId} -> ${receiverId}`);
                return true;
            }
            
            return false;
        } catch (error) {
            SyncLog.log("warning", "compatibility", 
                `Failed to check reconfiguration possibility: ${error instanceof Error ? error.message : String(error)}`);
            return false;
        }
    }

    /**
     * Perform dynamic stream reconfiguration without full disconnect/reconnection
     * This optimizes switching speed by updating only transport parameters
     */
    async performDynamicReconfiguration(
        senderId: string, 
        receiverId: string, 
        newTransportParams: any,
        manifestFile?: string
    ): Promise<boolean> {
        const reconfigStartTime = Date.now();
        
        try {
            const nmosState = NmosRegistryConnector.instance.getNmosState();
            const receiver = nmosState.receivers[receiverId];
            
            if (!receiver || !receiver.subscription) {
                throw new Error("No active connection to reconfigure");
            }

            // Build receiver-compliant transport_params for staged update.
            // Receivers must not receive sender-only fields; use minimal params only.
            const legCount = Array.isArray(receiver.interface_bindings) && receiver.interface_bindings.length > 0
                ? receiver.interface_bindings.length
                : 1;
            const sanitizedParams = Array.from({ length: legCount }, () => ({ interface_ip: "auto" }));
            const reconfigPatch: any = {
                transport_params: sanitizedParams,
                activation: {
                    mode: "activate_immediate",
                    requested_time: null,
                }
            };

            // Include manifest file if provided (non-empty) and transport supports it
            const trimmedManifest = typeof manifestFile === 'string' ? manifestFile.trim() : '';
            if (trimmedManifest && (receiver.transport === "urn:x-nmos:transport:rtp" || 
                                   receiver.transport === "urn:x-nmos:transport:rtp.mcast" ||
                                   isUsbTransport(receiver.transport))) {
                reconfigPatch.transport_file = {
                    type: "application/sdp",
                    data: trimmedManifest,
                };
            }

            // Find the receiver's control endpoints
            const device = nmosState.devices[receiver.device_id];
            const node = device ? nmosState.nodes[device.node_id] : null;
            
            if (!node || !node.controls) {
                throw new Error("No control endpoints available for reconfiguration");
            }

            // Determine the best control endpoint version
            const controlTypes = [
                {type:"urn:x-nmos:control:sr-ctrl/v1.3",version:"v1.3"},
                {type:"urn:x-nmos:control:sr-ctrl/v1.2",version:"v1.2"},
                {type:"urn:x-nmos:control:sr-ctrl/v1.1",version:"v1.1"},
                {type:"urn:x-nmos:control:sr-ctrl/v1.0",version:"v1.0"}
            ];

            let controlHrefs: { href: string; version: string }[] = [];
            let versionFound = false;

            for (const type of controlTypes) {
                node.controls.forEach((control: any) => {
                    if (control.type === type.type) {
                        controlHrefs.push({href: control.href, version: type.version});
                        versionFound = true;
                    }
                });
                if (versionFound) break;
            }

            if (controlHrefs.length === 0) {
                throw new Error("No compatible control endpoints found");
            }

            // Attempt dynamic reconfiguration via PATCH to staged endpoint
            for (const href of controlHrefs) {
                try {
                    const fixSlash = href.href.endsWith("/") ? "" : "/";
                    const patchHref = `${href.href}${fixSlash}single/receivers/${receiverId}/staged`;
                    
                    SyncLog.log("info", "dynamic_reconfig", 
                        `Attempting dynamic reconfiguration: ${patchHref}`, reconfigPatch);

                    // Use axios with optimized settings for reconfiguration
                    const axios = require('axios');
                    const result = await axios.patch(patchHref, reconfigPatch, {
                        timeout: 5000, // Shorter timeout for reconfig vs full connection
                        headers: {
                            'Cache-Control': 'no-cache',
                            'Connection': 'keep-alive'
                        },
                        validateStatus: (status: number) => status < 300
                    });

                    const reconfigLatency = Date.now() - reconfigStartTime;
                    SyncLog.log("success", "dynamic_reconfig", 
                        `Dynamic reconfiguration completed: ${senderId} -> ${receiverId}`,
                        { 
                            latency: reconfigLatency, 
                            endpoint: patchHref,
                            responseStatus: result.status 
                        });

                    // Update our internal state to reflect the reconfiguration
                    if (receiver.subscription) {
                        receiver.subscription.transport_params = reconfigPatch.transport_params;
                    }

                    return true;

                } catch (patchError) {
                    if (require('axios').isAxiosError(patchError)) {
                        if (patchError.code === "ETIMEDOUT") {
                            SyncLog.log("info", "dynamic_reconfig", 
                                `Reconfiguration timed out on ${receiverId}, trying next endpoint.`);
                            continue; // Try next endpoint
                        } else {
                            SyncLog.log("warning", "dynamic_reconfig", 
                                `Reconfiguration failed on ${receiverId}: ${patchError.code}`,
                                { 
                                    endpoint: href.href,
                                    error: patchError.response?.data,
                                    message: patchError.message 
                                });
                            continue; // Try next endpoint
                        }
                    } else {
                        SyncLog.log("warning", "dynamic_reconfig", 
                            `Unexpected error during reconfiguration: ${patchError instanceof Error ? patchError.message : String(patchError)}`);
                        continue;
                    }
                }
            }

            throw new Error("All control endpoints failed for dynamic reconfiguration");

        } catch (error) {
            const reconfigLatency = Date.now() - reconfigStartTime;
            SyncLog.log("error", "dynamic_reconfig", 
                `Dynamic reconfiguration failed: ${error instanceof Error ? error.message : String(error)}`,
                { latency: reconfigLatency });
            return false;
        }
    }

    private async getSenderCapabilities(senderId: string): Promise<StreamCapabilities> {
        const cached = this.capabilitiesCache.get(`sender-${senderId}`);
        if (cached && (Date.now() - cached.timestamp) < this.cacheExpiryMs) {
            return cached.capabilities;
        }

        try {
            const nmosState = NmosRegistryConnector.instance.getNmosState();
            const sender = nmosState.senders[senderId];
            const flow = sender ? nmosState.flows[sender.flow_id] : null;
            const source = flow ? nmosState.sources[flow.source_id] : null;

            const capabilities: StreamCapabilities = {
                formats: [],
                resolutions: [],
                frameRates: [],
                colorspaces: [],
                bitDepths: [],
                maxBitrate: 0,
                transports: [],
                constraints: {}
            };

            if (flow) {
                capabilities.formats.push(flow.format || 'unknown');
                capabilities.mediaTypes = flow.media_type ? [flow.media_type] : [];
                
                if (flow.media_type === 'video' && flow.frame_width && flow.frame_height) {
                    capabilities.resolutions.push(`${flow.frame_width}x${flow.frame_height}`);
                }
                
                if (flow.frame_rate) {
                    capabilities.frameRates.push(flow.frame_rate.numerator / flow.frame_rate.denominator);
                }
                
                if (flow.colorspace) {
                    capabilities.colorspaces.push(flow.colorspace);
                }
                
                if (flow.bit_rate) {
                    capabilities.maxBitrate = flow.bit_rate;
                }
            }

            if (sender && sender.transport) {
                capabilities.transports.push(sender.transport);
            }

            this.capabilitiesCache.set(`sender-${senderId}`, {
                capabilities,
                timestamp: Date.now()
            });

            return capabilities;
        } catch (error) {
            throw new Error(`Failed to get sender capabilities: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async getReceiverCapabilities(receiverId: string): Promise<StreamCapabilities> {
        const cached = this.capabilitiesCache.get(`receiver-${receiverId}`);
        if (cached && (Date.now() - cached.timestamp) < this.cacheExpiryMs) {
            return cached.capabilities;
        }

        try {
            const nmosState = NmosRegistryConnector.instance.getNmosState();
            const receiver = nmosState.receivers[receiverId];

            const capabilities: StreamCapabilities = {
                formats: [],
                resolutions: [],
                frameRates: [],
                colorspaces: [],
                bitDepths: [],
                maxBitrate: 0,
                transports: [],
                constraints: receiver?.caps || {}
            };

            if (receiver) {
                // Extract capabilities from receiver constraints
                if (receiver.caps) {
                    if (receiver.caps.media_types) {
                        capabilities.formats = receiver.caps.media_types;
                        capabilities.mediaTypes = receiver.caps.media_types;
                    }
                    if (receiver.caps.constraint_sets) {
                        receiver.caps.constraint_sets.forEach((constraint: any) => {
                            if (constraint.frame_width && constraint.frame_height) {
                                capabilities.resolutions.push(`${constraint.frame_width.minimum || constraint.frame_width}x${constraint.frame_height.minimum || constraint.frame_height}`);
                            }
                            if (constraint.frame_rate) {
                                const rate = constraint.frame_rate.minimum || constraint.frame_rate;
                                if (rate.numerator && rate.denominator) {
                                    capabilities.frameRates.push(rate.numerator / rate.denominator);
                                }
                            }
                        });
                    }
                }

                if (receiver.transport) {
                    capabilities.transports.push(receiver.transport);
                }
            }

            this.capabilitiesCache.set(`receiver-${receiverId}`, {
                capabilities,
                timestamp: Date.now()
            });

            return capabilities;
        } catch (error) {
            throw new Error(`Failed to get receiver capabilities: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private computeCompatibility(
        senderCaps: StreamCapabilities, 
        receiverCaps: StreamCapabilities,
        senderId: string,
        receiverId: string
    ): StreamCompatibilityResult {
        const warnings: string[] = [];
        let confidence = 1.0;
        let compatible = true;
        let reason = "";

        // Check transport compatibility
        if (senderCaps.transports.length > 0 && receiverCaps.transports.length > 0) {
            // Both USB URNs (urn:x-matrox:transport:usb, urn:x-nmos:transport:usb) are the same transport.
            const sameTransport = (a: string, b: string) => a === b || (isUsbTransport(a) && isUsbTransport(b));
            const transportMatch = senderCaps.transports.some(st => receiverCaps.transports.some(rt => sameTransport(st, rt)));
            if (!transportMatch) {
                compatible = false;
                reason = `Transport incompatible: sender ${senderCaps.transports} vs receiver ${receiverCaps.transports}`;
            }
        }

        // Check format compatibility with intelligent format mapping
        if (compatible && senderCaps.formats.length > 0 && receiverCaps.formats.length > 0) {
            const mediaTypeMatch = (senderCaps.mediaTypes || []).some(m => (receiverCaps.mediaTypes || []).includes(m));
            const formatCompatible = mediaTypeMatch
                ? { compatible: true, requiresTranslation: false, translationInfo: undefined }
                : this.checkFormatCompatibility(senderCaps.formats, receiverCaps.formats);
            if (!formatCompatible.compatible) {
                compatible = false;
                reason = `Format incompatible: sender ${senderCaps.formats} vs receiver ${receiverCaps.formats}`;
            } else if (formatCompatible.requiresTranslation) {
                warnings.push(`Format translation required: ${formatCompatible.translationInfo}`);
                confidence *= 0.95; // Slight confidence reduction for format translation
            }
        }

        // Check resolution compatibility
        if (compatible && senderCaps.resolutions.length > 0 && receiverCaps.resolutions.length > 0) {
            const resolutionMatch = senderCaps.resolutions.some(sr => receiverCaps.resolutions.includes(sr));
            if (!resolutionMatch) {
                warnings.push(`Resolution mismatch: sender ${senderCaps.resolutions} vs receiver ${receiverCaps.resolutions}`);
                confidence *= 0.8;
            }
        }

        // Check bitrate constraints
        if (compatible && senderCaps.maxBitrate > 0 && receiverCaps.maxBitrate > 0) {
            if (senderCaps.maxBitrate > receiverCaps.maxBitrate) {
                warnings.push(`Bitrate warning: sender ${senderCaps.maxBitrate} exceeds receiver limit ${receiverCaps.maxBitrate}`);
                confidence *= 0.9;
            }
        }

        // Generate optimized transport parameters if compatible
        let optimizedTransportParams: any = undefined;
        if (compatible) {
            optimizedTransportParams = this.generateOptimizedParams(senderCaps, receiverCaps);
        }

        return {
            compatible: compatible && confidence >= this.compatibilityThreshold,
            reason,
            optimizedTransportParams,
            confidence,
            warnings
        };
    }

    private generateOptimizedParams(senderCaps: StreamCapabilities, receiverCaps: StreamCapabilities): any {
        const params: any = {};
        
        // Optimize based on capabilities intersection
        if (senderCaps.transports.includes('urn:x-nmos:transport:rtp') && 
            receiverCaps.transports.includes('urn:x-nmos:transport:rtp')) {
            params.rtp_enabled = true;
            
            // Optimize packet timing based on content type
            if (senderCaps.formats.includes('video')) {
                params.packet_time = this.calculateOptimalVideoPacketTime(senderCaps);
            } else if (senderCaps.formats.includes('audio')) {
                params.packet_time = 1.0; // 1ms for low-latency audio
            }
        }
        
        return params;
    }

    private calculateOptimalPacketTime(flow: any): number {
        // Calculate optimal packet time based on flow characteristics
        if (!flow.bit_rate) return 1.0;
        
        // Higher bitrate = smaller packet time for better granularity
        if (flow.bit_rate > 500000000) return 0.125; // 500+ Mbps: 0.125ms
        if (flow.bit_rate > 100000000) return 0.25;  // 100+ Mbps: 0.25ms
        if (flow.bit_rate > 50000000) return 0.5;    // 50+ Mbps: 0.5ms
        return 1.0; // Default: 1ms
    }

    private calculateOptimalVideoPacketTime(senderCaps: StreamCapabilities): number {
        // Calculate based on resolution and frame rate
        const resolution = senderCaps.resolutions[0];
        const frameRate = senderCaps.frameRates[0];
        
        if (resolution && resolution.includes('3840x2160')) return 0.125; // 4K: 0.125ms
        if (resolution && resolution.includes('1920x1080')) return 0.25;  // HD: 0.25ms
        if (frameRate && frameRate >= 60) return 0.25; // High frame rate: 0.25ms
        return 0.5; // Default: 0.5ms
    }

    private compareTransportParams(current: any[], newParams: any): boolean {
        // Simplified comparison - in reality this would be more sophisticated
        return JSON.stringify(current) !== JSON.stringify(newParams);
    }

    /**
     * Intelligent format compatibility checking with device-specific format mapping
     * Handles Matrox-specific formats and standard NMOS format translations
     */
    private checkFormatCompatibility(senderFormats: string[], receiverFormats: string[]): {
        compatible: boolean;
        requiresTranslation: boolean;
        translationInfo?: string;
    } {
        // First check for exact format matches
        const exactMatch = senderFormats.some(sf => receiverFormats.includes(sf));
        if (exactMatch) {
            return { compatible: true, requiresTranslation: false };
        }

        // Device-specific format compatibility mappings
        const formatMappings: { [key: string]: string[] } = {
            // Standard NMOS formats to Matrox formats
            'urn:x-nmos:format:video': ['video', 'video/colibri', 'video/hdmi', 'video/sdi'],
            'urn:x-nmos:format:audio': ['audio', 'audio/colibri', 'audio/hdmi', 'audio/sdi'],
            // Matrox USB streams are data flows carrying the 'application/usb' media type
            'urn:x-nmos:format:data': ['data', 'application/usb'],
            'application/usb': ['urn:x-nmos:format:data', 'data'],
            
            // Matrox to standard NMOS and cross-format mappings
            'video': ['urn:x-nmos:format:video', 'video/colibri', 'video/hdmi', 'video/sdi'],
            'video/colibri': ['urn:x-nmos:format:video', 'video', 'video/hdmi', 'video/sdi'],
            'video/hdmi': ['urn:x-nmos:format:video', 'video', 'video/colibri', 'video/sdi'],
            'video/sdi': ['urn:x-nmos:format:video', 'video', 'video/colibri', 'video/hdmi'],
            'audio': ['urn:x-nmos:format:audio', 'audio/colibri', 'audio/hdmi', 'audio/sdi'],
            'audio/colibri': ['urn:x-nmos:format:audio', 'audio', 'audio/hdmi', 'audio/sdi'],
            'audio/hdmi': ['urn:x-nmos:format:audio', 'audio', 'audio/colibri', 'audio/sdi'],
            'audio/sdi': ['urn:x-nmos:format:audio', 'audio', 'audio/colibri', 'audio/hdmi']
        };

        // Check for compatible format mappings
        for (const senderFormat of senderFormats) {
            const mappedFormats = formatMappings[senderFormat] || [];
            
            for (const receiverFormat of receiverFormats) {
                // Check if sender format maps to receiver format
                if (mappedFormats.includes(receiverFormat)) {
                    return {
                        compatible: true,
                        requiresTranslation: true,
                        translationInfo: `${senderFormat} -> ${receiverFormat}`
                    };
                }
                
                // Check reverse mapping (receiver format maps to sender format)
                const receiverMappedFormats = formatMappings[receiverFormat] || [];
                if (receiverMappedFormats.includes(senderFormat)) {
                    return {
                        compatible: true,
                        requiresTranslation: true,
                        translationInfo: `${senderFormat} -> ${receiverFormat}`
                    };
                }
            }
        }

        // Check for broad category compatibility (video-to-video, audio-to-audio)
        const senderCategories = this.extractFormatCategories(senderFormats);
        const receiverCategories = this.extractFormatCategories(receiverFormats);
        
        const categoryMatch = senderCategories.some(sc => receiverCategories.includes(sc));
        if (categoryMatch) {
            const matchedCategory = senderCategories.find(sc => receiverCategories.includes(sc));
            return {
                compatible: true,
                requiresTranslation: true,
                translationInfo: `Category match: ${matchedCategory} (sender: ${senderFormats}, receiver: ${receiverFormats})`
            };
        }

        // No compatibility found
        return { compatible: false, requiresTranslation: false };
    }

    /**
     * Extract format categories (video, audio, data) from format strings
     */
    private extractFormatCategories(formats: string[]): string[] {
        const categories = new Set<string>();
        
        for (const format of formats) {
            if (format.includes('video') || format.includes('urn:x-nmos:format:video')) {
                categories.add('video');
            }
            if (format.includes('audio') || format.includes('urn:x-nmos:format:audio')) {
                categories.add('audio');
            }
            if (format.includes('data') || format.includes('urn:x-nmos:format:data')) {
                categories.add('data');
            }
        }
        
        return Array.from(categories);
    }

    private cleanupExpiredCache(): void {
        const now = Date.now();
        let cleaned = 0;

        for (const [key, cache] of this.compatibilityCache.entries()) {
            if ((now - cache.timestamp) > this.cacheExpiryMs) {
                this.compatibilityCache.delete(key);
                cleaned++;
            }
        }

        for (const [key, cache] of this.capabilitiesCache.entries()) {
            if ((now - cache.timestamp) > this.cacheExpiryMs) {
                this.capabilitiesCache.delete(key);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            SyncLog.log("debug", "compatibility", `Cleaned up ${cleaned} expired cache entries`);
        }
    }
}
