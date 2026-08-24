import { NetworkAuth, NetworkInfrastructure, NetworkInterface, AttachedNetworkDevice } from "./networkDevice";
import { NetworkInfrastructureConnector } from "./networkInfrastructureConnector";
import { Agent } from 'undici';

// Helper function to safely get nested properties
const get = (obj: any, path: string, defaultValue: any = undefined) => {
    const properties = path.split('.');
    return properties.reduce((acc, prop) => (acc && typeof acc === 'object' && prop in acc) ? acc[prop] : defaultValue, obj);
};

// Model whitelist for M4350 variants (explicitly excluding PR460X)
const M4350_MODEL_WHITELIST = new Set<string>([
    'M4350-32F8V',
    'M4350-48G4XF',
    'M4350-24G4XF',
]);

// -----------------------------
// Inline M4350 REST API interfaces (minimal shapes used by this driver)
// -----------------------------
interface M4350LoginRequest {
    login: {
        username: string;
        password: string;
    };
}

interface M4350LoginToken {
    token: string;
    expiresIn?: number;
    expires_at?: string;
}

interface M4350DeviceInfo {
    model?: string;
    serialNumber?: string;
    swVer?: string;
    // Some firmware variants expose a human-friendly device name
    // under different keys; support common possibilities
    deviceName?: string;
    systemName?: string;
    sysName?: string;
    hostName?: string;
    hostname?: string;
    name?: string;
    [k: string]: unknown;
}

interface M4350DeviceInfoResponse {
    device_info?: M4350DeviceInfo;
    deviceInfo?: M4350DeviceInfo; // firmware variant observed
    [k: string]: unknown;
}

interface M4350PortNeighborInfo {
    chassisId?: string | number;
    portId?: string | number;
    name?: string;
    [k: string]: unknown;
}

interface M4350PortStat {
    portId: number | string;
    adminMode?: boolean;
    status?: number;
    myDesc?: string;
    portMacAddress?: string;
    speed?: number;
    duplex?: number | string;
    neighborInfo?: M4350PortNeighborInfo;
    [k: string]: unknown;
}

interface M4350PortStatsResponse {
    switchStatsPort?: M4350PortStat | M4350PortStat[] | Record<string, M4350PortStat>;
    portStats?: M4350PortStat[]; // firmware variant observed
    [k: string]: unknown;
}

interface M4350LldpRemoteDevice {
    local_port_id?: string | number;
    localPortId?: string | number;
    local_interface?: string | number;
    remote_chassis_id?: string;
    chassisId?: string;
    remote_port_id?: string;
    portId?: string;
    remote_system_name?: string;
    systemName?: string;
    [k: string]: unknown;
}

interface M4350LldpRemoteDevicesResponse {
    lldp_remote_devices?: {
        lldp_rem_dev_list?: M4350LldpRemoteDevice[];
        [k: string]: unknown;
    };
    lldp_rem_dev_list?: M4350LldpRemoteDevice[];
    [k: string]: unknown;
}

// Additional minimal interfaces for model-aware enrichment
interface M4350SwcfgPort {
    ID: number;
    description?: string;
    adminMode?: boolean;
    portSpeed?: number; // enum in spec
    duplexMode?: number; // enum in spec
    isPoE?: boolean;
}

interface M4350SwcfgPortResponse {
    switchPortConfig: M4350SwcfgPort;
}

interface M4350FiberOpticItem {
    port?: string; // e.g., "1/0/49" or similar
    nominalBitRate?: string; // Mbps as string
    possibleSpeedDetected?: string; // e.g., "10G", "25G", "1G"
    vendorName?: string;
    partNumber?: string;
    serialNumber?: string;
    [k: string]: unknown;
}

interface M4350FiberOpticsResponse {
    fiber_optics?: M4350FiberOpticItem | M4350FiberOpticItem[] | Record<string, M4350FiberOpticItem>;
    [k: string]: unknown;
}

export class NIC_MOD extends NetworkInfrastructureConnector {
    device: NetworkInfrastructure;
    private updateIntervalTimer: NodeJS.Timeout | null = null;
    private apiBaseUrl: string;
    private apiToken: string | null = null;
    private authOptions: NetworkAuth;
    private httpsAgent: Agent;
    private modelWhitelisted: boolean = false;
    private normalizedModel: string = '';
    private preferBasicAuth: boolean = false;
    private preferCookieAuth: boolean = false;
    private sessionCookieHeader: string | null = null;
    private isFetching: boolean = false;
    // Tuning knobs (defaults can be overridden via NetworkAuth)
    private pollIntervalMs: number = 30000;
    private startJitterMs: number = 0;
    private fetchTimeoutMs: number = 10000;
    private retryMax: number = 1;
    private retryBaseDelayMs: number = 300;
    private retryJitterMs: number = 100;
    // Throttle /device_info polling
    private deviceInfoCacheTtlMs: number = 5 * 60 * 1000;
    private lastDeviceInfoFetchAt: number = 0;
    // Circuit breaker
    private cbFailureThreshold: number = 3;
    private cbOpenDurationMs: number = 30000;
    private consecutiveFailures: number = 0;
    private circuitOpenUntil: number = 0;
    private startJitterTimer: NodeJS.Timeout | null = null;
    // Concurrency limiter for outbound requests to this device
    private maxInflight: number = 4;
    private inflightCount: number = 0;
    private inflightQueue: Array<() => void> = [];
    // Specific concurrency for per-port swcfg fetches
    private swcfgConcurrency: number = 4;

    // Generic helper: run async map with a concurrency limit
    private async mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
        const results: R[] = new Array(items.length) as any;
        let i = 0;
        const c = Math.max(1, Math.min(limit || 1, items.length || 1));
        const workers: Promise<void>[] = [];
        const worker = async () => {
            while (true) {
                const idx = i++;
                if (idx >= items.length) return;
                try {
                    results[idx] = await fn(items[idx], idx);
                } catch (e) {
                    // Store undefined/null on error to allow partial progress
                    (results as any)[idx] = undefined;
                }
            }
        };
        for (let k = 0; k < c; k++) workers.push(worker());
        await Promise.all(workers);
        return results;
    }

    constructor(auth: NetworkAuth, changedCallback: any) {
        super(auth, changedCallback);

        this.authOptions = auth;
        // Apply optional per-device tuning (with safe defaults)
        if (typeof auth.pollIntervalMs === 'number' && auth.pollIntervalMs > 0) this.pollIntervalMs = auth.pollIntervalMs;
        if (typeof auth.startJitterMs === 'number' && auth.startJitterMs >= 0) this.startJitterMs = auth.startJitterMs;
        if (typeof auth.fetchTimeoutMs === 'number' && auth.fetchTimeoutMs > 0) this.fetchTimeoutMs = auth.fetchTimeoutMs;
        if (typeof auth.retryMax === 'number' && auth.retryMax >= 0) this.retryMax = auth.retryMax;
        if (typeof auth.retryBaseDelayMs === 'number' && auth.retryBaseDelayMs >= 0) this.retryBaseDelayMs = auth.retryBaseDelayMs;
        if (typeof auth.retryJitterMs === 'number' && auth.retryJitterMs >= 0) this.retryJitterMs = auth.retryJitterMs;
        if (auth.circuitBreaker) {
            const cb = auth.circuitBreaker;
            if (typeof cb.failureThreshold === 'number' && cb.failureThreshold > 0) this.cbFailureThreshold = cb.failureThreshold;
            if (typeof cb.openDurationMs === 'number' && cb.openDurationMs > 0) this.cbOpenDurationMs = cb.openDurationMs;
        }
        // Optional concurrency overrides (ignore if not provided)
        const concAll = (auth as any).maxInflight;
        if (typeof concAll === 'number' && concAll > 0) this.maxInflight = concAll;
        const concSw = (auth as any).swcfgConcurrency;
        if (typeof concSw === 'number' && concSw > 0) this.swcfgConcurrency = concSw;

        // Create an undici Agent that allows self-signed certificates
        this.httpsAgent = new Agent({
            connect: {
                rejectUnauthorized: false
            }
        });

        this.device = {
            id: auth.name, // Unique ID, can be hostname or serial
            name: auth.name,
            model: "",
            serialNumber: "",
            version: "",
            interfaces: [],
            rendering: { mode: "m4350" }, // For UI rendering hints
            source: "config",
            type: "switch",
        };

        if (!auth.connect) {
            console.error(`M4350 (${auth.name}): Connection IP/hostname not provided.`);
            // Potentially throw an error or disable the connector
            this.apiBaseUrl = '';
            return;
        }
        this.apiBaseUrl = `https://${auth.connect}:8443/api/v1`;

        console.log(`M4350 connector initialized for: ${auth.name} at ${this.apiBaseUrl}`);

        this.fetchAndUpdateDeviceData().finally(() => {
            this.startPolling();
        });
    }

    // Build a Cookie header value from Set-Cookie header(s)
    private buildCookieHeaderFromSetCookie(setCookies: string[] | string | null): string | null {
        if (!setCookies) return null;
        const arr = Array.isArray(setCookies) ? setCookies : [setCookies];
        const pairs: string[] = [];
        for (const sc of arr) {
            if (!sc) continue;
            const first = sc.split(';')[0].trim();
            if (first) pairs.push(first);
        }
        return pairs.length ? pairs.join('; ') : null;
    }

    // Acquire a concurrency slot for performing a network request
    private async acquireSlot(): Promise<() => void> {
        if (this.inflightCount < this.maxInflight) {
            this.inflightCount++;
            return () => this.releaseSlot();
        }
        return new Promise<() => void>(resolve => {
            this.inflightQueue.push(() => {
                this.inflightCount++;
                resolve(() => this.releaseSlot());
            });
        });
    }

    // Release a previously acquired concurrency slot
    private releaseSlot(): void {
        this.inflightCount = Math.max(0, this.inflightCount - 1);
        const next = this.inflightQueue.shift();
        if (next) next();
    }

    private async login(): Promise<boolean> {
        if (!this.authOptions.user || !this.authOptions.password) {
            console.error(`M4350 (${this.device.name}): API credentials (user/password) not provided.`);
            return false;
        }

        const loginUrl = `${this.apiBaseUrl}/login`;
        const credentials: M4350LoginRequest = {
            login: {
                username: this.authOptions.user,
                password: this.authOptions.password,
            },
        };

        const timeoutMs = this.fetchTimeoutMs;
        const maxRetries = Math.min(1, this.retryMax);
        const baseDelayMs = this.retryBaseDelayMs;
        const jitterMax = this.retryJitterMs;

        const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));
        const isTransientStatus = (status: number) => status === 408 || status === 429 || (status >= 500 && status < 600);

        // Concurrency-aware login fetch
        const doTimedFetch = async () => {
            const queueStart = Date.now();
            const release = await this.acquireSlot();
            const queuedMs = Date.now() - queueStart;
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), timeoutMs);
            const reqStart = Date.now();
            try {
                const resp = await fetch(loginUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                    },
                    body: JSON.stringify(credentials),
                    dispatcher: this.httpsAgent,
                    signal: controller.signal,
                });
                const reqMs = Date.now() - reqStart;
                if (queuedMs > 0 || reqMs >= timeoutMs * 0.5) {
                    console.log(`M4350 (${this.device.name}): LOGIN ${loginUrl} timings: queuedMs=${queuedMs}, reqMs=${reqMs}, timeoutMs=${timeoutMs}, status=${resp.status}`);
                }
                return resp;
            } finally {
                clearTimeout(t);
                release();
            }
        };

        let attempt = 0;
        let responseText = '';
        while (true) {
            try {
                const response = await doTimedFetch();

                // Capture Set-Cookie(s) if present to support cookie-session auth
                try {
                    const getSetCookie = (response.headers as any).getSetCookie;
                    if (typeof getSetCookie === 'function') {
                        const cookies = getSetCookie.call(response.headers) as string[];
                        const cookieHeader = this.buildCookieHeaderFromSetCookie(cookies);
                        if (cookieHeader) this.sessionCookieHeader = cookieHeader;
                    } else {
                        const sc = response.headers.get('set-cookie');
                        const cookieHeader = this.buildCookieHeaderFromSetCookie(sc);
                        if (cookieHeader) this.sessionCookieHeader = cookieHeader;
                    }
                } catch {}

                responseText = await response.text();

                if (!response.ok) {
                    console.error(`M4350 (${this.device.name}): Login HTTP error! Status: ${response.status}`);
                    console.error(`M4350 (${this.device.name}): Response body: ${responseText}`);
                    if (isTransientStatus(response.status) && attempt < maxRetries) {
                        const jitter = Math.floor(Math.random() * jitterMax);
                        const backoff = baseDelayMs * Math.pow(2, attempt) + jitter;
                        console.warn(`M4350 (${this.device.name}): Transient login HTTP ${response.status}. Retry ${attempt + 1}/${maxRetries} in ${backoff}ms`);
                        attempt++;
                        await sleep(backoff);
                        continue;
                    }
                    return false;
                }

                // Try to parse the successful response text as JSON
                try {
                    const data = JSON.parse(responseText) as any;

                    // Accept multiple possible token shapes from device firmware
                    let token: unknown = get(data, 'token', undefined);
                    if (!token) token = get(data, 'login.token', undefined);
                    if (!token) token = get(data, 'Login.token', undefined);

                    let ok = false;
                    if (typeof token === 'string' && token.trim().length > 0) {
                        this.apiToken = token.trim();
                        console.log(`M4350 (${this.device.name}): Login successful. Token received.`);
                        ok = true;
                    }
                    if (this.sessionCookieHeader) {
                        this.preferCookieAuth = true;
                        console.log(`M4350 (${this.device.name}): Login session cookie acquired.`);
                        ok = true;
                    }
                    if (ok) return true;

                    // Enhanced diagnostics when neither token nor cookie is present
                    console.error(`M4350 (${this.device.name}): Login succeeded but no token/cookie in response. Top-level keys:`, Object.keys(data || {}));
                    console.error(`M4350 (${this.device.name}): Raw response body: ${responseText}`);
                    return false;
                } catch (jsonParseError) {
                    if (this.sessionCookieHeader) {
                        // Some firmwares may set cookie without JSON body
                        this.preferCookieAuth = true;
                        console.warn(`M4350 (${this.device.name}): Login response not JSON, but cookie acquired; proceeding with cookie auth.`);
                        return true;
                    }
                    console.error(`M4350 (${this.device.name}): Error parsing successful login response as JSON.`);
                    console.error(`M4350 (${this.device.name}): Raw response body: ${responseText}`);
                    console.error(jsonParseError);
                    return false;
                }

            } catch (fetchError: any) {
                console.error(`M4350 (${this.device.name}): Error during login request or reading response:`, fetchError.message);
                if (responseText) {
                    console.error(`M4350 (${this.device.name}): Raw response body (if available): ${responseText}`);
                }
                if (attempt < maxRetries) {
                    const jitter = Math.floor(Math.random() * jitterMax);
                    const backoff = baseDelayMs * Math.pow(2, attempt) + jitter;
                    console.warn(`M4350 (${this.device.name}): Login network error. Retry ${attempt + 1}/${maxRetries} in ${backoff}ms`);
                    attempt++;
                    await sleep(backoff);
                    continue;
                }
                return false;
            }
        }
    }

    // Fetch per-port config for a given port number
    private async fetchSwcfgPort(portNum: number): Promise<M4350SwcfgPort | null> {
        const url = `${this.apiBaseUrl}/swcfg_port?portid=${encodeURIComponent(portNum)}`;
        const response = await this.fetchWithAuth(url, { method: 'GET' });
        if (response && response.ok) {
            try {
                const data = await response.json() as M4350SwcfgPortResponse;
                return data.switchPortConfig || null;
            } catch (e) {
                console.warn(`M4350 (${this.device.name}): Failed parsing swcfg_port for port ${portNum}`, e);
            }
        }
        return null;
    }

    // Fetch fiber optics info (may be array/object/record depending on firmware)
    private async fetchFiberOptics(): Promise<M4350FiberOpticItem[]> {
        const url = `${this.apiBaseUrl}/fiber_optics`;
        const response = await this.fetchWithAuth(url, { method: 'GET' });
        if (response && response.ok) {
            try {
                const data = await response.json() as M4350FiberOpticsResponse;
                const fo = data.fiber_optics;
                if (!fo) return [];
                if (Array.isArray(fo)) return fo;
                if (typeof fo === 'object') {
                    // Could be a single object or a record of objects
                    if ('port' in fo || 'possibleSpeedDetected' in fo || 'nominalBitRate' in fo) {
                        return [fo as M4350FiberOpticItem];
                    }
                    const out: M4350FiberOpticItem[] = [];
                    for (const k of Object.keys(fo)) {
                        const v = (fo as Record<string, M4350FiberOpticItem>)[k];
                        if (v) out.push(v);
                    }
                    return out;
                }
            } catch (e) {
                console.warn(`M4350 (${this.device.name}): Failed parsing fiber_optics response`, e);
            }
        }
        return [];
    }

    // Parse speed strings like "10G", "25G", "1G", "100M" to Mbps
    private parseSpeedStringToMbps(s?: string): number | null {
        if (!s) return null;
        const t = s.trim().toUpperCase();
        const match = t.match(/^(\d+)(G|M)$/);
        if (!match) return null;
        const val = parseInt(match[1], 10);
        if (match[2] === 'G') return val * 1000;
        return val; // already Mbps
    }

    // Build a map of fiber optics entries keyed by numeric port (last segment of "x/y/z")
    private buildFiberMapByPortNum(items: M4350FiberOpticItem[]): Map<number, M4350FiberOpticItem> {
        const map = new Map<number, M4350FiberOpticItem>();
        for (const it of items) {
            const p = (it.port || '').toString();
            const parts = p.split('/');
            const last = parts.length ? parts[parts.length - 1] : p;
            const n = parseInt(last.replace(/[^0-9]/g, ''), 10);
            if (!Number.isNaN(n)) map.set(n, it);
        }
        return map;
    }

    // Enrich interfaces for whitelisted models using capability endpoints
    private async enrichModelAware(): Promise<void> {
        if (!this.modelWhitelisted || this.device.interfaces.length === 0) return;

        // Fetch fiber optics once
        const fiberItems = await this.fetchFiberOptics();
        const fiberByNum = this.buildFiberMapByPortNum(fiberItems);

        // Fetch per-port swcfg concurrently but safely
        const portNums = this.device.interfaces.map(i => {
            const idStr = String(i.id);
            if (idStr.includes(':')) {
                const baseStr = idStr.split(':')[0];
                const base = parseInt(baseStr.replace(/[^0-9]/g, ''), 10);
                return (!Number.isNaN(base) && base > 0) ? base : i.num;
            }
            return i.num;
        }).filter(n => typeof n === 'number' && n > 0) as number[];
        const uniquePortNums = Array.from(new Set(portNums));
        const swcfgResults = await this.mapWithConcurrency(uniquePortNums, this.swcfgConcurrency, async (n) => ({ n, cfg: await this.fetchSwcfgPort(n) }));
        const swcfgByNum = new Map<number, M4350SwcfgPort>();
        for (const { n, cfg } of swcfgResults) {
            if (cfg) swcfgByNum.set(n, cfg);
        }

        // Apply enrichment
        for (const iface of this.device.interfaces) {
            let baseNumForLookup = iface.num;
            const idStr = String(iface.id);
            if (idStr.includes(':')) {
                const baseStr = idStr.split(':')[0];
                const base = parseInt(baseStr.replace(/[^0-9]/g, ''), 10);
                if (!Number.isNaN(base) && base > 0) baseNumForLookup = base;
            }
            const sw = swcfgByNum.get(baseNumForLookup);
            const fo = fiberByNum.get(baseNumForLookup);

            // Determine type
            if (fo) {
                iface.type = 'sfp';
            } else if (sw) {
                // For whitelisted models, non-fiber ports are copper RJ45 regardless of PoE capability
                iface.type = 'rj45';
            }

            // Determine maxspeed (Mbps)
            let maxMbps: number | null = null;
            if (fo) {
                if (fo.nominalBitRate) {
                    const n = parseInt(fo.nominalBitRate, 10);
                    if (!Number.isNaN(n) && n > 0) maxMbps = n;
                }
                if (maxMbps == null && fo.possibleSpeedDetected) {
                    maxMbps = this.parseSpeedStringToMbps(fo.possibleSpeedDetected);
                }
                if (maxMbps == null) {
                    // Default for SFP/SFP+
                    maxMbps = 10000;
                }
            } else if (sw) {
                // RJ45 typical default for these models
                maxMbps = 1000;
            }
            if (maxMbps != null) iface.maxspeed = maxMbps;
        }
        console.log(`M4350 (${this.device.name}): Model-aware enrichment applied to ${this.device.interfaces.length} interfaces.`);
    }

    private async fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response | null> {
        const method = (options.method || 'GET').toString().toUpperCase();

        const makeHeaders = (mode: 'bearer' | 'basic' | 'cookie' | null): Record<string, string> => {
            const headers: Record<string, string> = {
                ...(options.headers as Record<string, string> || {}),
                'Accept': 'application/json',
            };
            if ((method === 'POST' || method === 'PUT' || method === 'PATCH') && (options as any).body != null) {
                if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
            } else {
                if ('Content-Type' in headers) delete headers['Content-Type'];
            }
            if (mode === 'bearer' && this.apiToken) {
                headers['Authorization'] = `Bearer ${this.apiToken}`;
            } else if (mode === 'basic' && this.authOptions.user && this.authOptions.password) {
                const basic = Buffer.from(`${this.authOptions.user}:${this.authOptions.password}`).toString('base64');
                headers['Authorization'] = `Basic ${basic}`;
            } else if (mode === 'cookie' && this.sessionCookieHeader) {
                headers['Cookie'] = this.sessionCookieHeader;
            }
            return headers;
        };

        // Transient classification and retry parameters (configurable)
        const maxRetries = Math.min(1, this.retryMax);
        const baseDelayMs = this.retryBaseDelayMs;
        // per-endpoint timeout
        const timeoutMs =
            url.includes('/device_info') ? 30000 :
            url.includes('/sw_portstats') ? 15000 :
            this.fetchTimeoutMs;

        const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

        const isTransientStatus = (status: number) => {
            return status === 408 || status === 429 || (status >= 500 && status < 600);
        };
        // Hard network errors that should not be retried
        const isHardNetworkError = (code: string, name: string) => {
            return code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'EHOSTDOWN' || code === 'ECONNREFUSED' || code === 'ENOTFOUND';
        };

        const doTimedFetch = async (mode: 'bearer' | 'basic' | 'cookie' | null) => {
            const headers = makeHeaders(mode);
            const queueStart = Date.now();
            const release = await this.acquireSlot();
            const queuedMs = Date.now() - queueStart;
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), timeoutMs);
            const reqStart = Date.now();
            try {
                const resp = await fetch(url, { ...options, headers, dispatcher: this.httpsAgent, signal: controller.signal });
                const reqMs = Date.now() - reqStart;
                if (!resp.ok) {
                    console.warn(`M4350 (${this.device.name}): ${method} ${url} (mode=${mode}) timings: queuedMs=${queuedMs}, reqMs=${reqMs}, timeoutMs=${timeoutMs}, status=${resp.status}`);
                } else if (queuedMs > 0 || reqMs >= timeoutMs * 0.5) {
                    console.log(`M4350 (${this.device.name}): ${method} ${url} (mode=${mode}) timings: queuedMs=${queuedMs}, reqMs=${reqMs}, timeoutMs=${timeoutMs}, status=${resp.status}`);
                }
                return resp;
            } catch (err: any) {
                const reqMs = Date.now() - reqStart;
                const code = err?.cause?.code || err?.code || '';
                const name = err?.name || '';
                const message = err?.message || String(err);
                console.warn(`M4350 (${this.device.name}): ${method} ${url} (mode=${mode}) FAILED timings: queuedMs=${queuedMs}, reqMs=${reqMs}, timeoutMs=${timeoutMs}, errorName=${name}, errorCode=${code}, msg='${message}'`);
                throw err;
            } finally {
                clearTimeout(t);
                release();
            }
        };

        const fetchWithRetry = async (mode: 'bearer' | 'basic' | 'cookie' | null) => {
            let attempt = 0;
            while (true) {
                try {
                    const resp = await doTimedFetch(mode);
                    // Retry on transient HTTP status codes
                    if (!resp.ok && isTransientStatus(resp.status) && attempt < maxRetries) {
                        const jitter = Math.floor(Math.random() * this.retryJitterMs);
                        const backoff = baseDelayMs * Math.pow(2, attempt) + jitter;
                        console.warn(`M4350 (${this.device.name}): Transient HTTP ${resp.status} on ${url} (mode=${mode}). Retry ${attempt + 1}/${maxRetries} in ${backoff}ms`);
                        attempt++;
                        await sleep(backoff);
                        continue;
                    }
                    return resp;
                } catch (err: any) { // Catch any error during fetch or response.text()
                    const code = err?.cause?.code || err?.code || '';
                    const name = err?.name || '';
                    const message = err?.message || String(err);
                    if (name === 'AbortError') {
                        console.warn(`M4350 (${this.device.name}): Fetch aborted (likely timeout after ${timeoutMs}ms) for ${url} (mode=${mode}).`);
                    }
                    if (isHardNetworkError(code, name)) {
                        console.warn(`M4350 (${this.device.name}): Hard network error on ${url} (mode=${mode}) [${name} ${code}] '${message}'. Not retrying.`);
                        throw err;
                    }
                    if (attempt < maxRetries) {
                        const jitter = Math.floor(Math.random() * this.retryJitterMs);
                        const backoff = baseDelayMs * Math.pow(2, attempt) + jitter;
                        console.warn(`M4350 (${this.device.name}): Network error on ${url} (mode=${mode}) [${name} ${code}] '${message}'. Retry ${attempt + 1}/${maxRetries} in ${backoff}ms`);
                        attempt++;
                        await sleep(backoff);
                        continue;
                    }
                    console.error(`M4350 (${this.device.name}): Exhausted retries for ${url} (mode=${mode}). Last error:`, err);
                    throw err;
                }
            }
        };

        // Decide the first auth mode
        let firstMode: 'bearer' | 'basic' | 'cookie' | null = null;
        if (this.preferCookieAuth && this.sessionCookieHeader) {
            firstMode = 'cookie';
        } else if (this.preferBasicAuth) {
            firstMode = 'basic';
        } else if (this.apiToken) {
            firstMode = 'bearer';
        } else if (this.authOptions.user && this.authOptions.password) {
            // If no token yet, try Basic first based on observed firmware behavior
            firstMode = 'basic';
        } else {
            // Try to obtain a token if credentials exist
            if (this.authOptions.user && this.authOptions.password) {
                const loggedIn = await this.login();
                if (loggedIn) {
                    if (this.sessionCookieHeader) firstMode = 'cookie';
                    else if (this.apiToken) firstMode = 'bearer';
                }
            }
        }

        // If still no mode, we cannot authenticate
        if (!firstMode) {
            console.error(`M4350 (${this.device.name}): No available auth method (no token and no credentials).`);
            return null;
        }

        try {
            let response = await fetchWithRetry(firstMode);
            if (response.status === 401 || response.status === 403) {
                const wwwAuth = response.headers.get('www-authenticate');
                let bodySnippet = '';
                try {
                    const txt = await response.text();
                    bodySnippet = txt.slice(0, 500);
                } catch {}
                console.warn(`M4350 (${this.device.name}): Auth error (${response.status}) with mode=${firstMode} to ${url}`);
                if (wwwAuth) console.warn(`M4350 (${this.device.name}): WWW-Authenticate: ${wwwAuth}`);
                if (bodySnippet) console.warn(`M4350 (${this.device.name}): Auth response body snippet: ${bodySnippet}`);

                if (firstMode === 'bearer') {
                    // Try re-login once, then retry bearer
                    this.apiToken = null;
                    const loggedIn = await this.login();
                    if (loggedIn) {
                        if (this.sessionCookieHeader) {
                            const cookieRetry = await fetchWithRetry('cookie');
                            if (cookieRetry.ok) {
                                this.preferCookieAuth = true;
                                console.log(`M4350 (${this.device.name}): Cookie auth succeeded post-login. Will prefer Cookie for subsequent requests.`);
                                return cookieRetry;
                            }
                            response = cookieRetry;
                        }
                        if (this.apiToken) {
                            const retry = await fetchWithRetry('bearer');
                            if (retry.ok) return retry;
                            response = retry; // carry on to basic fallback
                        }
                    }
                    // Fallback to Basic if creds available
                    if (this.authOptions.user && this.authOptions.password) {
                        const basicResp = await fetchWithRetry('basic');
                        if (basicResp.ok) {
                            this.preferBasicAuth = true;
                            console.log(`M4350 (${this.device.name}): Basic auth succeeded. Will prefer Basic for subsequent requests.`);
                            return basicResp;
                        }
                        return basicResp;
                    }
                    return response;
                } else if (firstMode === 'basic') {
                    // Try bearer as fallback if possible
                    if (!this.apiToken && !this.sessionCookieHeader) {
                        const loggedIn = await this.login();
                        if (!loggedIn) return response;
                    }
                    if (this.sessionCookieHeader) {
                        const cookieResp = await fetchWithRetry('cookie');
                        if (cookieResp.ok) {
                            this.preferCookieAuth = true;
                            console.log(`M4350 (${this.device.name}): Cookie auth succeeded. Will prefer Cookie for subsequent requests.`);
                            return cookieResp;
                        }
                        response = cookieResp;
                    }
                    if (this.apiToken) {
                        const bearerResp = await fetchWithRetry('bearer');
                        if (bearerResp.ok) {
                            this.preferBasicAuth = false;
                            return bearerResp;
                        }
                        return bearerResp;
                    }
                    return response;
                } else if (firstMode === 'cookie') {
                    // Refresh login to renew cookie, then try cookie -> bearer -> basic
                    const loggedIn = await this.login();
                    if (loggedIn && this.sessionCookieHeader) {
                        const cookieRetry = await fetchWithRetry('cookie');
                        if (cookieRetry.ok) {
                            this.preferCookieAuth = true;
                            return cookieRetry;
                        }
                        response = cookieRetry;
                    }
                    if (this.apiToken) {
                        const bearerResp = await fetchWithRetry('bearer');
                        if (bearerResp.ok) {
                            this.preferCookieAuth = false;
                            return bearerResp;
                        }
                        response = bearerResp;
                    }
                    if (this.authOptions.user && this.authOptions.password) {
                        const basicResp = await fetchWithRetry('basic');
                        if (basicResp.ok) {
                            this.preferBasicAuth = true;
                            this.preferCookieAuth = false;
                            return basicResp;
                        }
                        return basicResp;
                    }
                    return response;
                }
            }
            // Success or non-auth error
            if (response.ok) {
                if (firstMode === 'basic') this.preferBasicAuth = true;
                if (firstMode === 'cookie') this.preferCookieAuth = true;
            }
            return response;
        } catch (error) {
            console.error(`M4350 (${this.device.name}): Error during fetch to ${url}:`, error);
            throw error;
        }
    }

    private async fetchDeviceInfo(): Promise<void> {
        const url = `${this.apiBaseUrl}/device_info`;
        // Throttle and cache: only fetch at most once per deviceInfoCacheTtlMs
        const now = Date.now();
        const age = now - this.lastDeviceInfoFetchAt;
        if (this.lastDeviceInfoFetchAt > 0 && age < this.deviceInfoCacheTtlMs) {
            console.log(`M4350 (${this.device.name}): Skipping /device_info fetch; using cached data (age ${Math.round(age/1000)}s).`);
            return;
        }
        const response = await this.fetchWithAuth(url, { method: 'GET' });

        if (response && response.ok) {
            // Mark successful refresh time only on success
            this.lastDeviceInfoFetchAt = Date.now();
            const data = await response.json() as M4350DeviceInfoResponse;
            const respStatus = get(data, 'resp.status', '');
            if (respStatus && respStatus !== 'success') {
                console.warn(`M4350 (${this.device.name}): /device_info resp.status='${respStatus}'`);
            }
            const d = get(data, 'device_info', get(data, 'deviceInfo', {} as any)) as any;
            // Prefer real device-reported name when available
            try {
                const reportedName = String(
                    (d && (d.deviceName || d.systemName || d.sysName || d.hostName || d.hostname || d.name)) || ''
                ).trim();
                if (reportedName && reportedName.length > 0 && reportedName !== this.device.name) {
                    const oldName = this.device.name;
                    this.device.name = reportedName;
                    try { (this.device.rendering as any).displayName = reportedName; } catch {}
                    console.log(`M4350 (${oldName}): Device reported name set to '${reportedName}'.`);
                }
            } catch {}
            this.device.model = get(d, 'model', '');
            this.device.serialNumber = get(d, 'serialNumber', '');
            this.device.version = get(d, 'swVer', ''); // swVer for software version
            // Determine whitelist status based on model
            const modelRaw = this.device.model || '';
            const norm = String(modelRaw).trim().toUpperCase();
            const isPR460X = norm === 'PR460X';
            this.normalizedModel = norm;
            this.modelWhitelisted = !isPR460X && M4350_MODEL_WHITELIST.has(norm);
            // Expose hint to UI via rendering
            try {
                (this.device.rendering as any).whitelisted = this.modelWhitelisted;
                (this.device.rendering as any).model = modelRaw;
            } catch {}

            if (this.modelWhitelisted) {
                console.log(`M4350 (${this.device.name}): Model '${modelRaw}' is whitelisted for model-aware logic.`);
            } else if (modelRaw) {
                console.warn(`M4350 (${this.device.name}): Model '${modelRaw}' is not in whitelist (or excluded). Using generic mapping.`);
            }

            if (this.device.model && this.device.serialNumber && this.device.version) {
                console.log(`M4350 (${this.device.name}): Fetched device info - Model: ${this.device.model}, SN: ${this.device.serialNumber}, Ver: ${this.device.version}`);
            } else {
                console.warn(`M4350 (${this.device.name}): Partially fetched device info. Some fields might be missing. Raw data:`, JSON.stringify(data, null, 2));
            }
        } else if (response) {
            console.error(`M4350 (${this.device.name}): Failed to fetch device info - ${response.status} ${response.statusText}`);
        } else {
            // fetchWithAuth returned null (e.g. login failure)
            // Error already logged by fetchWithAuth or login
        }
    }

    private async fetchInterfaceStatus(): Promise<void> {
        const url = `${this.apiBaseUrl}/sw_portstats?portid=ALL`;
        const response = await this.fetchWithAuth(url, { method: 'GET' });
        const newInterfaces: NetworkInterface[] = [];

        if (response && response.ok) {
            const data = await response.json() as M4350PortStatsResponse;
            const respStatus = get(data, 'resp.status', '');
            if (respStatus && respStatus !== 'success') {
                console.warn(`M4350 (${this.device.name}): /sw_portstats resp.status='${respStatus}'`);
            }
            const rawStats = get(data, 'switchStatsPort', get(data, 'portStats', null)) as any;
            let portStatsList: M4350PortStat[] = [];
            if (Array.isArray(rawStats)) {
                portStatsList = rawStats as M4350PortStat[];
            } else if (rawStats && typeof rawStats === 'object') {
                if ('portId' in rawStats) {
                    portStatsList = [rawStats as M4350PortStat];
                } else {
                    portStatsList = Object.values(rawStats as Record<string, M4350PortStat>);
                }
            }
            console.log(`M4350 (${this.device.name}): Parsed /sw_portstats entries: ${Array.isArray(portStatsList) ? portStatsList.length : 0}`);

            if (!portStatsList || !Array.isArray(portStatsList) || portStatsList.length === 0) {
                console.warn(`M4350 (${this.device.name}): No usable entries from /sw_portstats.`);
            }

            for (const ifaceData of portStatsList) {
                const portId = String(ifaceData.portId);
                // Link status per spec: status 0 = LINK_UP, 1 = LINK_DOWN
                const linkUp = ifaceData.adminMode === true && ifaceData.status === 0;

                let attachedDevice: AttachedNetworkDevice | null = null;
                if ((ifaceData as any).neighborInfo && (ifaceData as any).neighborInfo.chassisId) {
                    const n = (ifaceData as any).neighborInfo;
                    attachedDevice = {
                        chassisId: String(n.chassisId),
                        portId: String(n.portId || ''),
                        name: String(n.name || '')
                    };
                }
                
                // Derive stable numeric port index with breakout awareness (e.g., "49:1" => 49*10+1)
                let numericPort: number;
                if (portId.includes(':')) {
                    const [baseStr, laneStr] = portId.split(':');
                    const base = Number.parseInt(baseStr.replace(/[^0-9]/g, ''), 10);
                    const lane = Number.parseInt(laneStr.replace(/[^0-9]/g, ''), 10);
                    numericPort = (!Number.isNaN(base) && !Number.isNaN(lane)) ? (base * 10 + lane) : Number.parseInt(portId.replace(/[^0-9]/g, ''), 10);
                } else {
                    const parsedFromId = Number.parseInt(portId.replace(/[^0-9]/g, ''), 10);
                    numericPort = !Number.isNaN(parsedFromId) && parsedFromId !== 0
                        ? parsedFromId
                        : (typeof (ifaceData as any).portId === 'number' ? (ifaceData as any).portId : Number.parseInt(String((ifaceData as any).portId), 10) || 0);
                }

                newInterfaces.push({
                    id: portId,
                    name: (ifaceData as any).myDesc || `Port ${portId}`,
                    mac: (ifaceData as any).portMacAddress || '',
                    // Speed and MaxSpeed: Keep raw value if present; model-aware enrichment may correct later
                    speed: typeof (ifaceData as any).speed === 'number' ? (ifaceData as any).speed : 0, 
                    maxspeed: typeof (ifaceData as any).speed === 'number' ? (ifaceData as any).speed : 0,
                    num: numericPort,
                    type: 'unknown',
                    linkState: linkUp ? 'up' : 'down',
                    duplex: String((ifaceData as any).duplex ?? '') || 'unknown',
                    attached: attachedDevice,
                });
            }
            this.device.interfaces = newInterfaces;
            console.log(`M4350 (${this.device.name}): Updated ${newInterfaces.length} interfaces from /sw_portstats.`);
        } else if (response) {
            console.error(`M4350 (${this.device.name}): Failed to fetch interface status - ${response.status} ${response.statusText}`);
        }
    }

    // Normalize a variety of port id formats into a set of candidate strings
    // Examples:
    //  - "1/0/49" => ["1/0/49", "49", "49"]
    //  - "49:1"   => ["49:1", "49", "491", "49"] (digits/colon forms)
    //  - 49        => ["49"]
    private normalizePortIdCandidates(port: string | number | null | undefined): string[] {
        const s = String(port ?? '').trim();
        if (!s) return [];
        const out = new Set<string>();
        out.add(s);
        const digitsColon = s.replace(/[^0-9:]/g, '');
        if (digitsColon) out.add(digitsColon);
        const slashParts = s.split('/');
        if (slashParts.length > 1) {
            const last = slashParts[slashParts.length - 1];
            out.add(last);
            const lastDigitsColon = last.replace(/[^0-9:]/g, '');
            if (lastDigitsColon) out.add(lastDigitsColon);
        }
        const digitsOnly = s.replace(/[^0-9]/g, '');
        if (digitsOnly) out.add(digitsOnly);
        const colonIdx = digitsColon.indexOf(':');
        if (colonIdx > 0) out.add(digitsColon.substring(0, colonIdx));
        return Array.from(out);
    }

    private async fetchLldpInfo(): Promise<void> {
        const url = `${this.apiBaseUrl}/lldp_remote_devices`;
        const response = await this.fetchWithAuth(url, { method: 'GET' });

        if (response && response.ok) {
            const data = await response.json() as M4350LldpRemoteDevicesResponse;
            const rawLldp = get(data, 'lldp_remote_devices', get(data, 'lldp_rem_dev_list', null)) as any;
            let lldpList: M4350LldpRemoteDevice[] = [];
            if (Array.isArray(rawLldp)) {
                lldpList = rawLldp as M4350LldpRemoteDevice[];
            } else if (rawLldp && typeof rawLldp === 'object') {
                const maybeList = get(rawLldp, 'lldp_rem_dev_list', null);
                if (Array.isArray(maybeList)) {
                    lldpList = maybeList as M4350LldpRemoteDevice[];
                } else {
                    lldpList = [rawLldp as M4350LldpRemoteDevice];
                }
            }

            if (!lldpList || lldpList.length === 0) {
                console.warn(`M4350 (${this.device.name}): No LLDP data found in /lldp_remote_devices response. Raw data:`, JSON.stringify(data, null, 2));
            }

            let updatedCount = 0;
            for (const lldpData of lldpList) {
                // Field names below are broad to accommodate variants
                const localPortIdRaw = (lldpData as any).local_port_id || (lldpData as any).localPortId || (lldpData as any).local_interface || '';
                const candidates = this.normalizePortIdCandidates(localPortIdRaw);
                const existingInterface = this.device.interfaces.find(i => {
                    const idStr = String(i.id);
                    const numStr = String(i.num);
                    return candidates.includes(idStr) || candidates.includes(numStr);
                });
                if (existingInterface) {
                    existingInterface.attached = {
                        chassisId: (lldpData as any).remote_chassis_id || (lldpData as any).chassisId || '',
                        portId: (lldpData as any).remote_port_id || (lldpData as any).portId || '',
                        name: (lldpData as any).remote_system_name || (lldpData as any).systemName || '',
                    };
                    updatedCount++;
                }
            }
            if (updatedCount > 0) {
                console.log(`M4350 (${this.device.name}): Updated LLDP info for ${updatedCount} interfaces.`);
            }
        } else if (response) {
            console.error(`M4350 (${this.device.name}): Failed to fetch LLDP info - ${response.status} ${response.statusText}`);
        }
    }

    private async fetchAndUpdateDeviceData(): Promise<boolean> {
        if (this.isFetching) {
            console.warn(`M4350 (${this.device.name}): Previous fetch cycle still in progress. Skipping this tick.`);
            return true; // neutral (do not count as failure)
        }
        this.isFetching = true;
        const cycleStart = Date.now();
        console.log(`M4350 (${this.device.name}): Starting data fetch cycle.`);
        if (!this.apiBaseUrl) {
            console.warn(`M4350 (${this.device.name}): API base URL not set. Skipping fetch.`);
            this.isFetching = false;
            return false;
        }

        let cycleSuccess = true;
        try {
            // Do not force login up-front; fetchWithAuth() will handle Basic/Bearer selection and fallback.
            // This allows devices that only accept Basic to succeed without a prior /login.

            // Fetch endpoints sequentially to reduce device/API stress
            await this.fetchDeviceInfo();
            await this.fetchInterfaceStatus();

            // Model-aware enrichment (type/maxspeed/breakout-aware num already handled) for whitelisted models
            if (this.modelWhitelisted && this.device.interfaces.length > 0) {
                await this.enrichModelAware();
            }

            // Fetch LLDP info after interfaces are populated
            if (this.device.interfaces.length > 0) {
                await this.fetchLldpInfo();
            }

            console.log(`M4350 (${this.device.name}): Data fetch cycle completed.`);
            super.update(this.device); // Notify the base class of changes

        } catch (error) {
            console.error(`M4350 (${this.device.name}): Error during data fetch cycle:`, error);
            cycleSuccess = false;
            // Let polling continue; circuit breaker may pause if repeated.
        } finally {
            this.isFetching = false;
            const duration = Date.now() - cycleStart;
            console.log(`M4350 (${this.device.name}): Fetch cycle metrics: { durationMs: ${duration}, success: ${cycleSuccess} }`);
            if (cycleSuccess) {
                this.consecutiveFailures = 0;
            } else {
                this.consecutiveFailures++;
                console.warn(`M4350 (${this.device.name}): Consecutive failures: ${this.consecutiveFailures}/${this.cbFailureThreshold}`);
                if (this.consecutiveFailures >= this.cbFailureThreshold) {
                    this.circuitOpenUntil = Date.now() + this.cbOpenDurationMs;
                    this.consecutiveFailures = 0; // reset counter when opening circuit
                    const until = new Date(this.circuitOpenUntil).toISOString();
                    console.warn(`M4350 (${this.device.name}): Circuit opened for ${this.cbOpenDurationMs}ms (until ${until}).`);
                }
            }
        }
        return cycleSuccess;
    }

    private startPolling(): void {
        if (this.updateIntervalTimer) {
            clearInterval(this.updateIntervalTimer);
        }
        // Ensure polling doesn't start if base URL isn't set (constructor failed)
        if (!this.apiBaseUrl) {
            console.warn(`M4350 (${this.device.name}): API base URL not configured. Polling will not start.`);
            return;
        }
        const intervalMs = this.pollIntervalMs > 0 ? this.pollIntervalMs : 30000;
        const initialDelay = this.startJitterMs > 0 ? Math.floor(Math.random() * this.startJitterMs) : 0;
        if (this.startJitterTimer) {
            clearTimeout(this.startJitterTimer);
            this.startJitterTimer = null;
        }
        this.startJitterTimer = setTimeout(() => {
            this.updateIntervalTimer = setInterval(async () => {
                if (Date.now() < this.circuitOpenUntil) {
                    const remaining = this.circuitOpenUntil - Date.now();
                    console.warn(`M4350 (${this.device.name}): Circuit open. Skipping poll. Opens for ${remaining}ms more.`);
                    return;
                }
                await this.fetchAndUpdateDeviceData();
            }, intervalMs);
            console.log(`M4350 (${this.device.name}): Polling started every ${intervalMs / 1000}s (initial jitter ${initialDelay}ms)`);
            this.startJitterTimer = null;
        }, initialDelay);
    }

    public stopPolling(): void {
        if (this.updateIntervalTimer) {
            clearInterval(this.updateIntervalTimer);
            this.updateIntervalTimer = null;
            console.log(`M4350 (${this.device.name}): Polling stopped`);
        }
        if (this.startJitterTimer) {
            clearTimeout(this.startJitterTimer);
            this.startJitterTimer = null;
        }
    }

    public cleanup(): void {
        this.stopPolling();
        this.apiToken = null; // Clear token on cleanup
        this.sessionCookieHeader = null;
        this.preferCookieAuth = false;
        console.log(`M4350 (${this.device.name}): Cleaned up connector.`);
    }
}
