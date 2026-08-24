/* 
    NMOS Crosspoint
    Copyright (C) 2021 Johannes Grieb
*/

import { Request, Response } from 'express';
import { WebsocketSyncServer } from './SyncServer/websocketSyncServer';
import { SyncLog } from './syncLog';
import MediaDevMatroxConvertIp from '../mediaDevices/matroxConvertIp';

/**
 * Simple authentication helper for Matrox CIP devices
 * Provides auto-login functionality without complex proxying
 */
export class MatroxAuthHelper {
    private static instance: MatroxAuthHelper;
    
    public static getInstance(): MatroxAuthHelper {
        if (!MatroxAuthHelper.instance) {
            MatroxAuthHelper.instance = new MatroxAuthHelper();
        }
        return MatroxAuthHelper.instance;
    }

    /**
     * Handle device access requests with auto-authentication
     */
    public handleDeviceAccess = async (req: Request, res: Response) => {
        const deviceId = req.params.deviceId;
        
        // Check user permissions
        const user = this.extractUserFromRequest(req);
        const server = WebsocketSyncServer.getInstance();
        
        if (!server.checkPermission(user, "global", false)) {
            SyncLog.log("warning", "MatroxAuthHelper", `Permission denied for user ${user}`);
            return res.status(403).json({ error: 'Permission denied' });
        }

        // Get device information
        const matroxCip = MediaDevMatroxConvertIp.instance;
        if (!matroxCip) {
            SyncLog.log("error", "MatroxAuthHelper", "MediaDevMatroxConvertIp instance not available");
            return res.status(500).json({ error: 'Service unavailable' });
        }

        const deviceInfo = this.findDevice(matroxCip, deviceId);
        if (!deviceInfo) {
            SyncLog.log("warning", "MatroxAuthHelper", `Device not found: ${deviceId}`);
            return res.status(404).json({ error: 'Device not found' });
        }

        // Get device IP
        const targetIP = deviceInfo.ipList && deviceInfo.ipList.length > 0 ? deviceInfo.ipList[0] : null;
        if (!targetIP) {
            SyncLog.log("warning", "MatroxAuthHelper", `No IP address available for device: ${deviceInfo.sn}`);
            return res.status(503).json({ error: 'Device IP not available' });
        }

        // Get existing authentication tokens
        const authData = this.getDeviceAuthToken(matroxCip, deviceInfo.sn);
        if (!authData) {
            SyncLog.log("warning", "MatroxAuthHelper", `No authentication tokens available for device: ${deviceInfo.sn}`);
            return res.status(401).json({ error: 'Device authentication not available' });
        }

        SyncLog.log("info", "MatroxAuthHelper", `Providing token-based access for device ${deviceInfo.sn} at ${targetIP}`);

        // Create authenticated session using stored tokens
        const deviceUrl = `https://${targetIP}`;
        await this.proxyAuthenticatedRequest(req, res, deviceUrl, authData.bearerToken, authData.sessionCookie);
    };

    /**
     * Proxy authenticated request to device using stored tokens
     */
    private async proxyAuthenticatedRequest(req: Request, res: Response, deviceUrl: string, bearerToken: string, sessionCookie: string): Promise<void> {
        try {
            SyncLog.log("debug", "MatroxAuthHelper", `Making authenticated request to ${deviceUrl}`);
            
            // Import axios dynamically since it's used in the project
            const axios = require('axios');
            const https = require('https');
            
            // Create HTTPS agent that accepts self-signed certificates
            const httpsAgent = new https.Agent({
                rejectUnauthorized: false
            });
            
            // Make authenticated request to device main page
            const response = await axios.get(deviceUrl, {
                headers: {
                    'Authorization': `Bearer ${bearerToken}`,
                    'Cookie': sessionCookie,
                    'User-Agent': 'NMOS-Crosspoint-AuthHelper/1.0'
                },
                httpsAgent: httpsAgent,
                timeout: 10000,
                maxRedirects: 5
            });
            
            SyncLog.log("info", "MatroxAuthHelper", `Successfully authenticated with device, got ${response.status}`);
            
            // Extract cookies from response
            let responseCookies = '';
            if (response.headers['set-cookie']) {
                responseCookies = response.headers['set-cookie'].map(cookie => cookie.split(';')[0]).join('; ');
            }
            
            // Forward the device response with authentication cookies
            res.setHeader('Content-Type', response.headers['content-type'] || 'text/html');
            
            // Set the session cookies in the response so browser maintains session
            if (responseCookies) {
                res.setHeader('Set-Cookie', response.headers['set-cookie']);
            }
            
            // Rewrite HTML to fix asset URLs (if it's HTML content)
            let responseData = response.data;
            if (response.headers['content-type']?.includes('text/html')) {
                // Convert to string if needed
                if (typeof responseData !== 'string') {
                    responseData = responseData.toString();
                }
                
                // Extract device IP from URL
                const deviceIP = deviceUrl.replace('https://', '').replace('http://', '');
                const serverIP = req.get('host'); // Get the NMOS server IP
                
                SyncLog.log("debug", "MatroxAuthHelper", `Original HTML length: ${responseData.length}`);
                SyncLog.log("debug", "MatroxAuthHelper", `Rewriting URLs: Device=${deviceIP}, Server=${serverIP}`);
                
                // Count replacements for debugging
                let replacements = 0;
                
                // Fix ALL relative URLs starting with / (not just specific file types)
                const originalData = responseData;
                responseData = responseData.replace(/src="\/([^"]+)"/g, (match, path) => {
                    replacements++;
                    return `src="/device/${deviceIP}/asset/${path}"`;
                });
                responseData = responseData.replace(/href="\/([^"]+)"/g, (match, path) => {
                    replacements++;  
                    return `href="/device/${deviceIP}/asset/${path}"`;
                });
                responseData = responseData.replace(/url\(\/([^)]+)\)/g, (match, path) => {
                    replacements++;
                    return `url(/device/${deviceIP}/asset/${path})`;
                });
                
                // Fix JavaScript string literals that reference relative paths
                responseData = responseData.replace(/['"`]\/([^'"`]+)['"`]/g, (match, path) => {
                    // Only rewrite if it looks like a resource path
                    if (path.includes('.') || path.includes('api') || path.includes('assets') || path.includes('device')) {
                        replacements++;
                        return match.charAt(0) + `/device/${deviceIP}/asset/${path}` + match.charAt(match.length - 1);
                    }
                    return match;
                });
                
                // Fix absolute URLs pointing to any server (remove file type restrictions)
                responseData = responseData.replace(/src="https?:\/\/[^"]*\/([^"]+)"/g, (match, path) => {
                    replacements++;
                    return `src="/device/${deviceIP}/asset/${path}"`;
                });
                responseData = responseData.replace(/href="https?:\/\/[^"]*\/([^"]+)"/g, (match, path) => {
                    replacements++;
                    return `href="/device/${deviceIP}/asset/${path}"`;
                });
                
                // Fix fetch() calls in JavaScript
                responseData = responseData.replace(/fetch\s*\(\s*['"`]\/([^'"`]+)['"`]/g, (match, path) => {
                    replacements++;
                    return match.replace(`'/${path}'`, `'/device/${deviceIP}/asset/${path}'`)
                                .replace(`"/${path}"`, `"/device/${deviceIP}/asset/${path}"`)
                                .replace(`\`/${path}\``, `\`/device/${deviceIP}/asset/${path}\``);
                });
                
                // Inject JavaScript to intercept and redirect remaining requests + base tag
                const interceptScript = `
                <script>
                    (function() {
                        console.log('🔧 NMOS Auth Helper: Installing request interceptors for device ${deviceIP}');
                        
                        // Intercept fetch requests
                        if (window.fetch) {
                            const originalFetch = window.fetch;
                            window.fetch = function(url, options) {
                                if (typeof url === 'string') {
                                    // Catch relative URLs
                                    if (url.startsWith('/') && !url.startsWith('/device/')) {
                                        console.log('🔧 Redirecting fetch:', url, '→', '/device/${deviceIP}/asset' + url);
                                        url = '/device/${deviceIP}/asset' + url;
                                    } 
                                    // Catch absolute URLs pointing to wrong server
                                    else if (url.includes('10.10.230.100') || url.includes(':443/')) {
                                        const pathPart = url.split('://')[1]?.split('/').slice(1).join('/') || '';
                                        if (pathPart) {
                                            console.log('🔧 Redirecting absolute fetch:', url, '→', '/device/${deviceIP}/asset/' + pathPart);
                                            url = '/device/${deviceIP}/asset/' + pathPart;
                                        }
                                    }
                                    // Catch any requests to device-like paths
                                    else if (url.match(/\\/device\\/\\w+$/) && !url.includes('/device/${deviceIP}/')) {
                                        console.log('🔧 Redirecting device path:', url, '→', '/device/${deviceIP}/asset' + url.substring(url.lastIndexOf('/')));
                                        url = '/device/${deviceIP}/asset' + url.substring(url.lastIndexOf('/'));
                                    }
                                }
                                return originalFetch.call(this, url, options);
                            };
                        }
                        
                        // Intercept XMLHttpRequest
                        if (window.XMLHttpRequest) {
                            const originalOpen = XMLHttpRequest.prototype.open;
                            XMLHttpRequest.prototype.open = function(method, url, ...args) {
                                if (typeof url === 'string') {
                                    // Catch relative URLs
                                    if (url.startsWith('/') && !url.startsWith('/device/')) {
                                        console.log('🔧 Redirecting XHR:', url, '→', '/device/${deviceIP}/asset' + url);
                                        url = '/device/${deviceIP}/asset' + url;
                                    }
                                    // Catch absolute URLs pointing to wrong server
                                    else if (url.includes('10.10.230.100') || url.includes(':443/')) {
                                        const pathPart = url.split('://')[1]?.split('/').slice(1).join('/') || '';
                                        if (pathPart) {
                                            console.log('🔧 Redirecting absolute XHR:', url, '→', '/device/${deviceIP}/asset/' + pathPart);
                                            url = '/device/${deviceIP}/asset/' + pathPart;
                                        }
                                    }
                                    // Catch device API calls specifically
                                    else if (url.includes('/device/caps') || url.includes('/device/')) {
                                        console.log('🔧 Redirecting device API:', url, '→', '/device/${deviceIP}/asset/device/caps');
                                        url = '/device/${deviceIP}/asset/device/caps';
                                    }
                                }
                                return originalOpen.call(this, method, url, ...args);
                            };
                        }
                        
                        console.log('✅ NMOS Auth Helper: Request interceptors installed');
                    })();
                </script>`;
                
                // Add base tag and interceptor script
                if (responseData.includes('<head>')) {
                    responseData = responseData.replace('<head>', `<head>\n    <base href="/device/${deviceIP}/asset/">${interceptScript}`);
                    replacements++;
                }
                
                // Log sample of changes for debugging
                if (replacements > 0) {
                    SyncLog.log("info", "MatroxAuthHelper", `Made ${replacements} URL replacements for device ${deviceIP}`);
                    // Log first 500 chars to see what changed
                    const preview = responseData.substring(0, 500);
                    SyncLog.log("debug", "MatroxAuthHelper", `HTML preview: ${preview}...`);
                } else {
                    SyncLog.log("warning", "MatroxAuthHelper", `No URL replacements made - HTML may not contain expected patterns`);
                    // Log first 1000 chars to debug
                    const preview = responseData.substring(0, 1000);
                    SyncLog.log("debug", "MatroxAuthHelper", `Original HTML: ${preview}...`);
                }
            }
            
            // Send the modified response
            res.send(responseData);
            
        } catch (error: any) {
            SyncLog.log("error", "MatroxAuthHelper", `Failed to proxy authenticated request: ${error.message}`);
            
            // If authentication failed, provide a helpful error page
            const errorHtml = `
<!DOCTYPE html>
<html>
<head>
    <title>Authentication Error</title>
    <style>
        body { font-family: Arial, sans-serif; padding: 2rem; background: #f5f5f5; }
        .error { background: white; padding: 2rem; border-radius: 8px; max-width: 600px; margin: 0 auto; }
        .error-icon { color: #e74c3c; font-size: 3rem; text-align: center; margin-bottom: 1rem; }
        h2 { color: #e74c3c; text-align: center; }
        .details { background: #f8f9fa; padding: 1rem; border-radius: 4px; margin: 1rem 0; }
        .retry { text-align: center; margin-top: 2rem; }
        .retry a { background: #3498db; color: white; padding: 0.5rem 1rem; text-decoration: none; border-radius: 4px; }
    </style>
</head>
<body>
    <div class="error">
        <div class="error-icon">⚠️</div>
        <h2>Device Authentication Failed</h2>
        <p>Could not access the Matrox device using stored authentication tokens.</p>
        <div class="details">
            <strong>Error:</strong> ${error.message}<br>
            <strong>Status:</strong> ${error.response?.status || 'Network Error'}
        </div>
        <p>This may happen if:</p>
        <ul>
            <li>The device session has expired</li>
            <li>The device was restarted</li>
            <li>Network connectivity issues</li>
        </ul>
        <div class="retry">
            <a href="javascript:window.location.reload()">Try Again</a>
        </div>
    </div>
</body>
</html>`;
            
            res.status(502).send(errorHtml);
        }
    }

    /**
     * Handle requests for device assets (CSS, JS, images, etc.)
     */
    private handleDeviceAsset = async (req: Request, res: Response): Promise<void> => {
        const deviceId = req.params.deviceId;
        const assetPath = req.params[0] || req.url.split('/asset/')[1]; // Capture everything after /asset/
        
        SyncLog.log("debug", "MatroxAuthHelper", `Asset request for device ${deviceId}, asset: ${assetPath}`);
        
        // Check user permissions
        const user = this.extractUserFromRequest(req);
        const server = WebsocketSyncServer.getInstance();
        const hasPermission = server.checkPermission(user, "global", false);
        
        if (!hasPermission) {
            return res.status(403).json({ error: 'Permission denied' });
        }
        
        // Get device and auth tokens
        const matroxCip = MediaDevMatroxConvertIp.instance;
        if (!matroxCip) {
            return res.status(500).json({ error: 'MediaDevMatroxConvertIp not available' });
        }
        
        const deviceInfo = this.findDevice(matroxCip, deviceId);
        if (!deviceInfo) {
            return res.status(404).json({ error: 'Device not found' });
        }
        
        const authData = this.getDeviceAuthToken(matroxCip, deviceInfo.sn);
        if (!authData) {
            return res.status(401).json({ error: 'Device authentication not available' });
        }
        
        const targetIP = deviceInfo.ipList?.[0];
        if (!targetIP) {
            return res.status(503).json({ error: 'Device IP not available' });
        }
        
        try {
            const axios = require('axios');
            const https = require('https');
            
            const httpsAgent = new https.Agent({
                rejectUnauthorized: false
            });
            
            // Clean up asset path - remove any leading slash
            const cleanAssetPath = assetPath.replace(/^\/+/, '');
            const assetUrl = `https://${targetIP}/${cleanAssetPath}`;
            
            SyncLog.log("debug", "MatroxAuthHelper", `Proxying asset: ${assetUrl}`);
            
            // Handle different HTTP methods (GET, POST, PUT, DELETE, etc.)
            const requestConfig: any = {
                url: assetUrl,
                method: req.method.toLowerCase(),
                headers: {
                    'Authorization': `Bearer ${authData.bearerToken}`,
                    'Cookie': authData.sessionCookie,
                    'User-Agent': 'NMOS-Crosspoint-AuthHelper/1.0',
                    // Forward original headers (excluding host and authorization)
                    ...Object.fromEntries(
                        Object.entries(req.headers).filter(([key]) => 
                            !['host', 'authorization', 'cookie'].includes(key.toLowerCase())
                        )
                    )
                },
                httpsAgent: httpsAgent,
                timeout: 10000
            };
            
            // Add request body for POST/PUT requests
            if (['post', 'put', 'patch'].includes(req.method.toLowerCase())) {
                requestConfig.data = req.body;
                requestConfig.responseType = 'json'; // API calls expect JSON
            } else {
                requestConfig.responseType = 'stream'; // Static assets need streaming
            }
            
            SyncLog.log("debug", "MatroxAuthHelper", `Proxying ${req.method} request: ${assetUrl}`);
            
            const response = await axios(requestConfig);
            
            // Forward response headers
            if (response.headers['content-type']) {
                res.setHeader('Content-Type', response.headers['content-type']);
            }
            if (response.headers['content-length']) {
                res.setHeader('Content-Length', response.headers['content-length']);
            }
            if (response.headers['cache-control']) {
                res.setHeader('Cache-Control', response.headers['cache-control']);
            }
            
            // Handle response based on request method
            if (['post', 'put', 'patch'].includes(req.method.toLowerCase())) {
                // API calls - send JSON response
                res.status(response.status).json(response.data);
            } else {
                // Static assets - pipe stream response
                response.data.pipe(res);
            }
            
        } catch (error: any) {
            SyncLog.log("error", "MatroxAuthHelper", `Failed to proxy asset ${assetPath}: ${error.message}`);
            
            // Return a more specific error for debugging
            const errorDetails = {
                error: 'Asset proxy failed',
                asset: assetPath,
                device: deviceId,
                targetIP: req.locals?.targetIP || 'unknown',
                message: error.message,
                status: error.response?.status
            };
            
            res.status(502).json(errorDetails);
        }
    };
    
    /**
     * Get authentication tokens for a device (same as proxy implementation)
     */
    private getDeviceAuthToken(matroxCip: MediaDevMatroxConvertIp, deviceSn: string): {bearerToken: string, sessionCookie: string} | null {
        // Use the public method to get auth tokens
        return matroxCip.getAuthToken(deviceSn);
    }

    /**
     * Get device credentials (uses same logic as existing system)
     */
    private getDeviceCredentials(matroxCip: MediaDevMatroxConvertIp, deviceSn: string, deviceIP: string): {username: string, password: string} | null {
        // Try environment variables first
        const envUser = process.env.MATROX_CIP_USER;
        const envPassword = process.env.MATROX_CIP_PASSWORD;
        if (envUser && envPassword) {
            return { username: envUser, password: envPassword };
        }

        // Check device-specific credentials from config
        const config = matroxCip.config;
        if (config.manualDevices) {
            for (const device of config.manualDevices) {
                if (device.sn === deviceSn && device.auth) {
                    return { username: device.auth.user, password: device.auth.password };
                }
            }
        }

        // Fall back to global config credentials
        if (config.user && config.password) {
            return { username: config.user, password: config.password };
        }

        return null;
    }

    /**
     * Find device by various identifiers (same as proxy)
     */
    private findDevice(matroxCip: MediaDevMatroxConvertIp, deviceId: string): any {
        const devices = matroxCip.getDeviceState()?.devices;
        if (!devices) return null;

        // Try direct serial number lookup first
        if (devices.hasOwnProperty(deviceId)) {
            return devices[deviceId];
        }

        // Search by name, alias, or IP
        for (const sn in devices) {
            const device = devices[sn];
            
            // Check device name
            if (device.name === deviceId) {
                return device;
            }
            
            // Check IP addresses
            if (device.ipList && device.ipList.includes(deviceId)) {
                return device;
            }
        }

        return null;
    }

    /**
     * Extract user from request (same as proxy)
     */
    private extractUserFromRequest(req: Request): string {
        // Try to get user from custom header
        const userHeader = req.headers['x-nmos-user'] as string;
        if (userHeader) {
            return userHeader;
        }

        // Check for session cookie
        const cookies = req.headers.cookie;
        if (cookies) {
            const sessionMatch = cookies.match(/nmos-session=([^;]+)/);
            if (sessionMatch) {
                const sessionId = sessionMatch[1];
                SyncLog.log("debug", "MatroxAuthHelper", `Found session cookie: ${sessionId}`);
            }
        }

        // Check basic auth
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Basic ')) {
            const credentials = Buffer.from(authHeader.slice(6), 'base64').toString();
            const [username, password] = credentials.split(':');
            
            const server = WebsocketSyncServer.getInstance();
            const users = server.authData?.users;
            if (users && users[username]) {
                SyncLog.log("debug", "MatroxAuthHelper", `Basic auth attempt for user: ${username}`);
                return username;
            }
        }

        // Use first authenticated WebSocket client
        const server = WebsocketSyncServer.getInstance();
        const authenticatedClients = server.getAuthenticatedClients();
        
        if (authenticatedClients.length > 0) {
            const user = authenticatedClients[0].user;
            SyncLog.log("debug", "MatroxAuthHelper", `Using authenticated WebSocket user: ${user}`);
            return user;
        }

        return '__noAuth';
    }

    /**
     * Initialize authentication helper routes
     */
    public static initializeAuthHelper(): void {
        SyncLog.log("info", "MatroxAuthHelper", "Initializing authentication helper...");
        
        const server = WebsocketSyncServer.getInstance();
        const helper = MatroxAuthHelper.getInstance();
        
        if (!server) {
            SyncLog.log("error", "MatroxAuthHelper", "WebsocketSyncServer not initialized");
            return;
        }
        
        // Add device access endpoint
        server.addExpressMiddleware('/device/:deviceId/access', helper.handleDeviceAccess);
        
        // Add asset proxy endpoint for static assets from devices (with broad matching)
        server.addExpressMiddleware('/device/:deviceId/asset/*', helper.handleDeviceAsset);
        server.addExpressMiddleware('/device/:deviceId/asset', helper.handleDeviceAsset);
        
        // Add a catch-all debug middleware for device routes
        server.addExpressMiddleware('/device', (req, res, next) => {
            SyncLog.log("debug", "MatroxAuthHelper", `Device route request: ${req.method} ${req.url}`);
            next();
        });
        
        SyncLog.log("info", "MatroxAuthHelper", "Authentication helper initialized at /device/:deviceId/access and /device/:deviceId/asset/*");
    }
}
