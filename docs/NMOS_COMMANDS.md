# NMOS Registry Commands Documentation

This document provides comprehensive documentation of all NMOS (Networked Media Open Specifications) registry REST API commands used by the NMOS Crosspoint Registry Router system.

The system communicates with NMOS registries and devices using two distinct API layers:
- **Client ↔ Server**: WebSocket API for real-time communication between UI/clients and the server
- **Server ↔ NMOS**: HTTP REST API calls to NMOS registries and devices for resource discovery and connection management

This document focuses on the **Server ↔ NMOS** layer - the actual NMOS registry REST API commands sent by the server.

## NMOS Registry Discovery and Subscription API
- **IS-04**: Discovery and Registration API
- **IS-05**: Device Connection Management API
- **Channel Mapping**: Audio channel mapping control

---

## NMOS IS-04 Registry API Commands

### Discovery & Subscription

#### Registry Subscription Setup (IS-04)

Establishes WebSocket connections to NMOS registries for real-time updates.

```http
POST {registry_base_url}/subscriptions
Content-Type: application/json
```

Payload:

```json
{
    "max_update_rate_ms": 50,
    "resource_path": "/nodes",
    "params": {},
    "persist": false,
    "secure": false
}
```

**Purpose**: Creates subscription for real-time updates to NMOS resources
**Response**: Returns WebSocket URL (`ws_href`) for receiving updates
**Resources**: Subscribes to nodes, devices, sources, flows, senders, receivers

### Query Registry Resources

#### Get All Nodes

```http
GET {registry_base_url}/nodes
```

**Purpose**: Retrieve all registered NMOS nodes

#### Get All Devices

```http
GET {registry_base_url}/devices
```

**Purpose**: Retrieve all registered NMOS devices

#### Manifest Data Retrieval
Retrieves SDP manifest files from NMOS senders.

```http
GET {sender.manifest_href}
```

- **Purpose**: Gets SDP manifest content for connection establishment
- **Used for**: Flow compatibility checking and transport parameter configuration

#### Active Configuration Queries

Retrieves current connection status and staged parameters.

#### Get Active Receiver Configuration

```http
GET {device_control_href}/single/receivers/{receiverId}/active/
```

**Purpose**: Get active connection parameters

#### Get Active Sender Configuration

```http
GET {device_control_href}/single/senders/{senderId}/active/
```

- **Control type**: `urn:x-nmos:control:sr-ctrl/v1.0`
- **Purpose**: Retrieves current sender transport configuration

---

## NMOS IS-05 Connection API Commands

### Receiver Connection Management

#### Connection/Disconnection
Establishes or removes connections between senders and receivers.

```http
PATCH {device_control_href}/single/receivers/{receiverId}/staged
Content-Type: application/json

{
    "sender_id": "{senderId}" | null,
    "transport_params": [
        { "interface_ip": "auto" },
        { "interface_ip": "auto" }
    ],
    "transport_file": {
        "type": "application/sdp",
        "data": "{sdp_manifest_content}"
    },
    "master_enable": true | false,
    "activation": {
        "mode": "activate_immediate",
        "requested_time": null
    }
}
```

**Key Parameters:**
- **`sender_id`**: Target sender ID (null for disconnect)
- **`transport_params`**: Interface-specific transport parameters
- **`transport_file`**: SDP manifest data for RTP streams
- **`master_enable`**: Enable/disable the connection
- **`activation.mode`**: `"activate_immediate"` for immediate connection

#### Prepare-Only Connection (Staging)
Prepares connections for later activation without immediate execution.

```http
PATCH {device_control_href}/single/receivers/{receiverId}/staged
Content-Type: application/json

{
    "sender_id": "{senderId}",
    "transport_params": [
        { "interface_ip": "auto" }
    ],
    "transport_file": {
        "type": "application/sdp", 
        "data": "{sdp_manifest_content}"
    }
    // Note: No activation or master_enable for staging
}
```

### Sender Control Commands

#### Enable/Disable Flow
Controls the activation state of NMOS senders.

**Enable Flow Example:**
```http
PATCH http://10.0.1.100/x-nmos/connection/v1.1/single/senders/abc123-sender/staged
Content-Type: application/json

{
    "receiver_id": null,
    "master_enable": true,
    "activation": {
        "mode": "activate_immediate",
        "requested_time": null
    },
    "transport_params": [
        { "rtp_enabled": true }
    ]
}
```

**Disable Flow Example:**
```http
PATCH http://10.0.1.100/x-nmos/connection/v1.1/single/senders/abc123-sender/staged
Content-Type: application/json

{
    "receiver_id": null,
    "master_enable": false,
    "activation": {
        "mode": "activate_immediate",
        "requested_time": null
    },
    "transport_params": [
        { "rtp_enabled": false }
    ]
}
```

#### Set Multicast Address
Configures multicast addressing for sender streams.

**Set Specific Multicast Address:**
```http
PATCH http://10.0.1.100/x-nmos/connection/v1.1/single/senders/abc123-sender/staged
Content-Type: application/json

{
    "receiver_id": null,
    "activation": {
        "mode": "activate_immediate", 
        "requested_time": null
    },
    "transport_params": [
        {
            "destination_ip": "239.1.1.100",
            "destination_port": 5004,
            "source_ip": "10.0.1.100",
            "ttl": 32
        }
    ]
}
```

**Multi-stream Configuration:**
```http
PATCH http://10.0.1.100/x-nmos/connection/v1.1/single/senders/abc123-sender/staged
Content-Type: application/json

{
    "receiver_id": null,
    "activation": {
        "mode": "activate_immediate", 
        "requested_time": null
    },
    "transport_params": [
        {
            "destination_ip": "239.1.1.100",
            "destination_port": 5004,
            "source_ip": "auto"
        },
        {
            "destination_ip": "239.1.1.101",
            "destination_port": 5006,
            "source_ip": "auto"
        }
    ]
}
```

**Return to Unicast:**

```http
PATCH http://10.0.1.100/x-nmos/connection/v1.1/single/senders/abc123-sender/staged
Content-Type: application/json

{
    "receiver_id": null,
    "activation": {
        "mode": "activate_immediate", 
        "requested_time": null
    },
    "transport_params": [
        {
            "destination_ip": "auto",
            "source_ip": "auto"
        }
    ]
}
```

---

## NMOS Channel Mapping API Commands

### I/O Configuration Management

#### Get I/O Configuration
Retrieves input/output channel mapping configuration.

```http
GET {channel_mapping_control_href}/io
```

- **Control type**: `urn:x-nmos:control:cm-ctrl/v1.0`
- **Purpose**: Retrieves input/output channel mapping configuration

#### Get Active Channel Map
Gets currently active channel mapping.

```http
GET {channel_mapping_control_href}/map/active
```

- **Purpose**: Gets currently active channel mapping

---

## Control API Versions & Priority

The system supports multiple NMOS Connection API versions with priority order:

1. **`urn:x-nmos:control:sr-ctrl/v1.3`** (highest priority)
2. **`urn:x-nmos:control:sr-ctrl/v1.2`**
3. **`urn:x-nmos:control:sr-ctrl/v1.1`**
4. **`urn:x-nmos:control:sr-ctrl/v1.0`** (fallback)

---

## HTTP Configuration

### Request Optimization

- **Timeout**: 10 seconds (connection), 30 seconds (flow control)
- **Headers**:
  - `Connection: keep-alive`
  - `Keep-Alive: timeout=10, max=1000`
  - `Cache-Control: no-cache`
  - `User-Agent: NMOS-Crosspoint/2.0`
- **Max Redirects**: 0 (disabled for speed)

### Transport Support

- **Supported**: `urn:x-nmos:transport:rtp.mcast`, `urn:x-nmos:transport:rtp`
- **Unsupported**: `websocket`, `mqtt` (explicitly rejected)

---

## Real-time Updates

### WebSocket Subscriptions

- **Connection**: Established via subscription response `ws_href`
- **Update Rate**: Maximum 50ms intervals
- **Resources**: Real-time updates for all NMOS resources
- **Message Format**: JSON patches with grain data structure

### Subscription Management

The system automatically handles:

- **Reconnection**: Automatic reconnection with exponential backoff
- **Version Negotiation**: Prefers newer API versions
- **Resource Filtering**: Subscribes to specific resource types
- **State Synchronization**: Maintains consistent state across reconnections

---

## Error Handling

### Common Error Responses

- **`ETIMEDOUT`**: Connection timeout, retry with next control URL
- **`ERR_BAD_REQUEST`**: Invalid patch data, connection fails
- **Connection failures**: Automatic reconnection with exponential backoff

### Retry Logic

The system implements intelligent retry mechanisms:

- **Control URL Fallback**: Tries multiple control URLs in priority order
- **Exponential Backoff**: Increasing delays between retry attempts
- **Version Fallback**: Falls back to older API versions if newer ones fail
- **Timeout Handling**: Different timeouts for different operation types

---

## Usage Examples

### Making a Connection

```http
PATCH http://device-ip/x-nmos/connection/v1.1/single/receivers/receiver-123/staged
Content-Type: application/json

{
    "sender_id": "sender-456",
    "transport_params": [
        { "interface_ip": "auto" }
    ],
    "transport_file": {
        "type": "application/sdp",
        "data": "v=0\r\no=- 123456 654321 IN IP4 192.168.1.100\r\n..."
    },
    "master_enable": true,
    "activation": {
        "mode": "activate_immediate",
        "requested_time": null
    }
}
```

### Disconnecting a Receiver

```http
PATCH http://device-ip/x-nmos/connection/v1.1/single/receivers/receiver-123/staged
Content-Type: application/json

{
    "sender_id": null,
    "master_enable": false,
    "activation": {
        "mode": "activate_immediate",
        "requested_time": null
    }
}
```

### Enabling a Sender

```http
PATCH http://device-ip/x-nmos/connection/v1.1/single/senders/sender-456/staged
Content-Type: application/json

{
    "receiver_id": null,
    "master_enable": true,
    "activation": {
        "mode": "activate_immediate",
        "requested_time": null
    },
    "transport_params": [
        { "rtp_enabled": true }
    ]
}
```

### Setting Multicast Address

```http
PATCH http://device-ip/x-nmos/connection/v1.1/single/senders/sender-456/staged
Content-Type: application/json

{
    "receiver_id": null,
    "activation": {
        "mode": "activate_immediate",
        "requested_time": null
    },
    "transport_params": [
        {
            "destination_ip": "239.1.1.100",
            "source_ip": "auto"
        }
    ]
}
```

---

## Integration Notes

API responses follow a consistent format:

**Success Response:**

```json
{
  "message": 200,
  "data": { /* response data */ }
}
```

**Error Response:**
```json
{
  "error": "Error description",
  "code": "ERROR_CODE"
}
```

Common error scenarios:
- **Authentication Required**: User authentication needed for protected routes
- **Permission Denied**: Insufficient permissions for the requested operation
- **Device Not Found**: Specified device serial number not found
- **Flow Not Found**: Specified flow ID not found
- **Invalid Parameters**: Missing or invalid request parameters

---

## Integration Notes

### Q-SYS Integration
The system includes comprehensive Lua scripts for Q-SYS integration:
- **File**: `scripts/q-sys-crosspoint-control.lua`
- **Features**: Real-time WebSocket communication, crosspoint control, Matrox multiviewer control
- **Commands**: Uses the same WebSocket API documented above

### Companion Integration
Integration with Bitfocus Companion for advanced control workflows and panel interfaces.

### TCP API (Legacy)
Based on memory references, there may be a TCP API server on port 2323 with commands:
- `join <encoder_name> <decoder_name[,decoder_name2,...]>`
- `stop <decoder_name[,decoder_name2,...]>`

---

## System Architecture

The NMOS Crosspoint system operates as follows:

```
┌─────────────────┐    WebSocket     ┌─────────────────┐
│   Web UI        │◄─────────────────►│  NMOS Crosspoint│
│   (Client)      │   Updates/Cmds   │   Server        │
└─────────────────┘                  └─────────────────┘
                                             │
                                    WebSocket│
                                   Subscribe │
                                             ▼
                                    ┌─────────────────┐
                                    │  NMOS Registry  │
                                    │                 │
                                    └─────────────────┘
                                             ▲
                                    Updates  │
                                    ┌────────┴────────┐
                                    │                 │
                            ┌───────▼──────┐  ┌───────▼──────┐
                            │ NMOS Node    │  │ NMOS Node    │
                            │ (Device 1)   │  │ (Device 2)   │
                            └──────────────┘  └──────────────┘
```

---

## Performance Considerations

- **Optimized Lookups**: The system uses O(1) Map-based lookups for device and flow resolution
- **Caching**: Flow compatibility caching with TTL to improve performance
- **Connection Latency**: Comprehensive latency measurement and optimization targeting
- **Real-time Updates**: Efficient WebSocket-based synchronization minimizes overhead

---

## Configuration Files

Key configuration files:
- `server/config/settings.json` - Main server configuration
- `server/config/users.json` - User authentication settings
- `server/config/topology.json` - Network infrastructure device definitions
- `server/config/mediadev_matroxcip/matroxcip.json` - Matrox device configuration

---

This documentation covers all available NMOS commands and API routes in the current system. For additional details on specific implementations, refer to the source code in `server/src/server.ts` and related modules.
