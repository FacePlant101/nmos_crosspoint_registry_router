# WebSocket API Documentation

This document outlines the WebSocket API for the NMOS Crosspoint Router. The API is divided into two main parts: **Synchronized Objects** for real-time state management and **API Routes** for performing actions.

## 1. Overview

The API uses a custom WebSocket protocol built on top of the `ws` library. Clients can subscribe to `SyncObject`s to receive real-time updates and can send messages to invoke `API Routes` to trigger server-side actions.

- **Connection**: Clients connect to the WebSocket server at the address and port specified in `config/settings.json`.
- **Authentication**: If `config/users.json` is configured, clients may need to authenticate.
- **Route format**: Requests use a `route` string like `flowInfo/<id>`, where `GET` arguments are passed as additional path segments and `POST` data is provided in the message body.

### Request/response envelope

**Request**:

```json
{
  "type": "request",
  "id": "req-123",
  "method": "GET",
  "route": "flowInfo/nmos_123"
}
```

**Response**:

```json
{
  "type": "response",
  "id": "req-123",
  "method": "GET",
  "status": 200,
  "message": "ok",
  "data": { "...": "..." }
}
```

**Error response**:

```json
{
  "type": "response",
  "id": "req-123",
  "method": "GET",
  "status": 403,
  "message": "permission denied",
  "error": {}
}
```

### Authentication handshake

When authentication is enabled, the server sends an auth seed on connect. Clients respond with a SHA256 hash of `password + seed`.

**Server → client**:

```json
{
  "type": "authseed",
  "seed": "<random-seed>"
}
```

**Client → server**:

```json
{
  "type": "auth",
  "user": "admin",
  "password": "<sha256(password + seed)>"
}
```

**Server response (success)**:

```json
{
  "type": "auth",
  "user": "admin"
}
```

**Server response (failure)**:

```json
{
  "type": "authfailed"
}
```

### Sync/unsync messages

Clients subscribe to a synchronized object by sending a `sync` message, and unsubscribe via `unsync`.

**Subscribe**:

```json
{
  "type": "sync",
  "channel": "crosspoint",
  "objectId": 0
}
```

**Unsubscribe**:

```json
{
  "type": "unsync",
  "channel": "crosspoint",
  "objectId": 0
}
```

**Server push (init)**:

```json
{
  "type": "sync",
  "channel": "crosspoint",
  "objectId": 0,
  "action": "init",
  "data": { "...": "..." }
}
```

**Server push (patch)**:

```json
{
  "type": "sync",
  "channel": "crosspoint",
  "objectId": 0,
  "action": "patch",
  "data": [
    { "op": "replace", "path": "/devices/0/label", "value": "Camera 1" }
  ]
}
```

## 2. Synchronized Objects

Synchronized Objects provide a real-time view of the server's state. Clients can subscribe to these objects by name and will receive the full object state upon subscription, followed by patches for any subsequent changes.

| Object Name | Permissions | Description |
| --- | --- | --- |
| `log` | `global` | A real-time stream of server-side logs. |
| `nmos` | `global` | A complete, real-time representation of all discovered NMOS resources, including nodes, devices, senders, receivers, and flows. |
| `nmosConnectionState` | `global` | The connection status of the server to the various NMOS registries it has discovered. |
| `crosspoint` | `global` | The core crosspoint model, representing a simplified, user-friendly view of all devices and their available senders and receivers. |
| `topology` | `global` | Network topology state (NMOS devices and infrastructure) when the topology module is enabled. |
| `mediadevices` | `global` | A list of all dynamically loaded media devices (e.g., Matrox, Riedel) and their current states. |
| `mediadevmatroxcip` | `global` | Real-time state and control data for Matrox Convert IP devices, including multiviewer status, master mode, and device capabilities. |
| `mediadevriedelembrionix` | `global` | Real-time state for Riedel Embrionix devices. |
| `mediadevimaginesnp` | `global` | Real-time state for Imagine SNP devices. |
| `uiconfig` | `public` | General UI configuration, primarily used to inform the client about which server-side modules have been disabled. |

## 3. API Routes

API Routes are used to perform specific actions on the server. They are invoked by sending a JSON message over the WebSocket connection.

### `GET /flowInfo`

Retrieves detailed information about a specific NMOS flow, including its manifest.

- **Method**: `GET`
- **Permissions**: `global`
- **Query Parameters**:
  - `query[0]` (string): The ID of the flow to query (e.g., `"nmos_..."`).

### `POST /makeconnection`

Creates, prepares, or previews a connection between one or more senders and receivers.

- **Method**: `POST`
- **Permissions**: `global`
- **Payload**:

```json
{
  "source": "<sender_id>",
  "destination": "<receiver_id>",
  "preview": false, // Optional: if true, returns a preview without executing
  "prepare": false  // Optional: if true, prepares the connection
}
```

*or for multiple connections:*

```json
{
  "multiple": [
    { "source": "<sender_id_1>", "destination": "<receiver_id_1>" },
    { "source": "<sender_id_2>", "destination": "<receiver_id_2>" }
  ]
}
```

**Example (request envelope)**:

```json
{
  "type": "request",
  "id": "req-456",
  "method": "POST",
  "route": "makeconnection",
  "data": {
    "source": "nmos_sender_id",
    "destination": "nmos_receiver_id",
    "preview": false,
    "prepare": false
  }
}
```

**Example (response)**:

```json
{
  "type": "response",
  "id": "req-456",
  "method": "POST",
  "status": 200,
  "message": "ok",
  "data": { "...": "..." }
}
```

### `POST /changealias`

Changes the user-defined alias for a device or flow.

- **Method**: `POST`
- **Permissions**: `global`
- **Payload**:

```json
{
  "id": "<device_or_flow_id>",
  "alias": "New Alias Name"
}
```

### `POST /enableFlow`

Activates a specific NMOS flow.

- **Method**: `POST`
- **Permissions**: `global`
- **Payload**:

```json
{
  "id": "<nmos_flow_id>"
}
```

### `POST /disableFlow`

Deactivates a specific NMOS flow.

- **Method**: `POST`
- **Permissions**: `global`
- **Payload**:

```json
{
  "id": "<nmos_flow_id>"
}
```

### `POST /setMulticast`

Sets the multicast address for an NMOS flow.

- **Method**: `POST`
- **Permissions**: `global`
- **Payload**:

```json
{
  "id": "<nmos_flow_id>",
  "data": { ... } // The multicast configuration data
}
```

### `POST /togglehidden`

Toggles the visibility of a device or flow in the UI.

- **Method**: `POST`
- **Permissions**: `global`
- **Payload**:

```json
{
  "id": "<device_or_flow_id>"
}
```

### `POST /crosspoint`

A general-purpose endpoint for the crosspoint editor UI to send more complex API commands.

- **Method**: `POST`
- **Permissions**: `global`
- **Payload**: A flexible object structure defined by the needs of the crosspoint editor.

## 4. Matrox Convert IP Specific Routes

These routes are specific to Matrox Convert IP device control and are available when the Matrox Convert IP media device module is loaded.

**Device Lookup**: The `sn` parameter supports flexible device identification:

- Exact serial number match (e.g., `"YXA00634"`, `"8700634"`)
- Device name match (e.g., `"CIP-DEC-634"`)
- Device alias match

### Device refresh

- `GET /matroxcip_forcereload` — Force reload a single device (`query[0]` = `sn`).
- `GET /matroxcip_forcereloadall` — Force reload all known devices.

### Multiviewer

#### `POST /matroxcip_togglemultiviewer`

Enables or disables multiviewer mode on a Matrox Convert IP device. When enabling multiviewer, master mode is automatically enabled as well.

- **Method**: `POST`
- **Permissions**: `global`
- **Payload**:

```json
{
  "sn": "<device_serial_number>",
  "enabled": true
}
```

### PTP

#### `POST /matroxcip_toggleptp`

Enables or disables PTP (Precision Time Protocol) on a Matrox Convert IP device.

- **Method**: `POST`
- **Permissions**: `global`
- **Payload**:

```json
{
  "sn": "<device_serial_number>",
  "enabled": true
}
```

#### `POST /matroxcip_fixptpdomain`

- **Payload**:

```json
{
  "sn": "<device_serial_number>"
}
```

- `GET /matroxcip_ptpenableall` — Enable PTP on all devices.
- `GET /matroxcip_ptpdisableall` — Disable PTP on all devices.

### Audio and IGMP

#### `POST /matroxcip_toggleaudio`

- **Payload**:

```json
{
  "sn": "<device_serial_number>",
  "streamType": "audio",
  "streamIndex": 0,
  "enabled": true
}
```

#### `POST /matroxcip_setigmp`

- **Payload**:

```json
{
  "sn": "<device_serial_number>",
  "version": 2
}
```

#### `POST /matroxcip_setigmpall`

- **Payload**:

```json
{
  "version": 2
}
```

### Device configuration

#### `POST /matroxcip_enablemaster`

- **Payload**:

```json
{
  "sn": "<device_serial_number>"
}
```

#### `POST /matroxcip_changeresolution`

- **Payload**:

```json
{
  "sn": "<device_serial_number>",
  "name": "2160p50"
}
```

#### `POST /matroxcip_changeedid`

- **Payload**:

```json
{
  "sn": "<device_serial_number>",
  "name": "1080p50"
}
```

### Device lifecycle

#### `POST /matroxcip_restart`

- **Payload**:

```json
{
  "sn": "<device_serial_number>"
}
```

- `GET /matroxcip_restartall` — Restart all devices.

#### `POST /matroxcip_batchjob`

- **Payload**:

```json
{
  "sn": "<device_serial_number>",
  "context": { "...": "..." },
  "reboot": false
}
```

#### `POST /matroxcip_deletedevice`

- **Payload**:

```json
{
  "sn": "<device_serial_number>"
}
```

### NMOS registry configuration

#### `POST /matroxcip_setnmosregistry`

- **Payload**:

```json
{
  "sn": "<device_serial_number>",
  "ip": "10.1.0.211",
  "port": 80,
  "apiVersion": "v1.3"
}
```

#### `POST /matroxcip_autonmosregistry`

- **Payload**:

```json
{
  "enabled": true
}
```

#### `POST /matroxcip_toggleautoreauth`

- **Payload**:

```json
{
  "enabled": true
}
```

- `GET /matroxcip_bulknmosregistry` — Configure NMOS registry settings on all devices.
