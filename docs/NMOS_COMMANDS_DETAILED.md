# NMOS Commands — Detailed Description

All NMOS HTTP calls are made from `server/src/lib/nmosConnector.ts`.

---

## 1. IS-04 — Discovery & Registry Subscription

### Subscribe to resource updates

```http
POST http://<registry_ip>:<port>/x-nmos/query/<version>/subscriptions
Content-Type: application/json

{
    "resource_path": "/nodes",
    "params": {},
    "persist": false,
    "max_update_rate_ms": 50
}
```

- Called for each resource type: `/nodes`, `/devices`, `/sources`, `/flows`, `/senders`, `/receivers`
- Called for each configured registry version (e.g. `v1.0`, `v1.1`, `v1.3`)
- Response contains `ws_href` — a WebSocket URL the server connects to for real-time grain updates
- Auto-reconnects on close with a 1-second delay, or 20-second delay on POST failure

---

## 2. IS-04 — Manifest & Active State Queries

### Fetch SDP manifest from a sender

```http
GET <sender.manifest_href>
```

- `manifest_href` comes directly from the sender object in the NMOS registry
- Example: `http://10.0.1.50/x-nmos/connection/v1.1/single/senders/abc123/transportfile`
- Returns raw SDP text, used to populate `transport_file` in the receiver patch
- Called every time a connection is made (manifest is always freshly fetched, not cached)

### Fetch active sender configuration

```http
GET <device_control_href>/single/senders/<senderId>/active/
```

- Retrieves the currently active transport parameters of a sender
- Used for state introspection and channel mapping

### Fetch channel mapping I/O

```http
GET <cm-ctrl_href>/io
GET <cm-ctrl_href>/map/active
```

- Control type: `urn:x-nmos:control:cm-ctrl/v1.0`
- Used to read audio channel routing configuration from devices that support it

---

## 3. IS-05 — Receiver Connection (Core Switch)

This is the central command for all crosspoint switching. The endpoint is always:

```http
PATCH <device_control_href>/single/receivers/<receiverId>/staged
```

The control URL is resolved from the device's `controls` array in the NMOS registry.

### Control URL version priority

The server picks the highest available IS-05 version, in this order:

| Priority | Control type |
| --- | --- |
| 1 (highest) | `urn:x-nmos:control:sr-ctrl/v1.3` |
| 2 | `urn:x-nmos:control:sr-ctrl/v1.2` |
| 3 | `urn:x-nmos:control:sr-ctrl/v1.1` |
| 4 (fallback) | `urn:x-nmos:control:sr-ctrl/v1.0` |

If a `PATCH` times out (`ETIMEDOUT`), it falls through to the next URL. Any other error throws immediately.

---

### Immediate connect (activate now)

```http
PATCH <device_control_href>/single/receivers/<receiverId>/staged
Content-Type: application/json

{
    "sender_id": "f4b39c20-1234-5678-abcd-ef0123456789",
    "transport_params": [
        { "interface_ip": "auto" },
        { "interface_ip": "auto" }
    ],
    "transport_file": {
        "type": "application/sdp",
        "data": "v=0\r\no=- 123456 1 IN IP4 10.0.1.50\r\ns=ST2110 Video\r\n..."
    },
    "master_enable": true,
    "activation": {
        "mode": "activate_immediate",
        "requested_time": null
    }
}
```

**Key notes:**

- `transport_params` has one entry per `interface_binding` on the receiver (covers dual-leg 2022-7 redundancy)
- `interface_ip: "auto"` lets the device choose its receive interface; the server always uses `auto` for receiver-side params
- `transport_file` contains the full SDP fetched live from the sender's `manifest_href`
- The `fixSdpBugs` setting in `settings.json` can rewrite `colorimetry=UNSPECIFIED` → `BT709` and `TCS=UNSPECIFIED` → `SDR` before sending
- `activation.mode: "activate_immediate"` causes the device to switch streams immediately upon receipt of the PATCH

---

### Prepare/stage only (no activation)

```http
PATCH <device_control_href>/single/receivers/<receiverId>/staged
Content-Type: application/json

{
    "sender_id": "f4b39c20-1234-5678-abcd-ef0123456789",
    "transport_params": [
        { "interface_ip": "auto" }
    ],
    "transport_file": {
        "type": "application/sdp",
        "data": "v=0\r\n..."
    }
}
```

**Key notes:**

- **No `activation` field** → device loads parameters but does not switch
- **No `master_enable` field** → does not affect the current active stream
- This is what `executeConnectionPrepare()` sends — used by the predictive staging system
- When the actual switch is requested later, only a short activate patch is needed because the transport parameters are already resident in the device, dramatically reducing switching latency

---

### Disconnect a receiver

```http
PATCH <device_control_href>/single/receivers/<receiverId>/staged
Content-Type: application/json

{
    "transport_params": [],
    "master_enable": false,
    "activation": {
        "mode": "activate_immediate",
        "requested_time": null
    }
}
```

**Key notes:**

- No `sender_id` field when the source is `"disconnect"`
- `master_enable: false` stops the active stream on the receiver

---

## 4. IS-05 — Sender Control

### Enable a sender flow

```http
PATCH <device_control_href>/single/senders/<senderId>/staged
Content-Type: application/json

{
    "receiver_id": null,
    "master_enable": true,
    "activation": {
        "mode": "activate_immediate",
        "requested_time": null
    },
    "transport_params": [
        { "rtp_enabled": true },
        { "rtp_enabled": true }
    ]
}
```

### Disable a sender flow

```http
PATCH <device_control_href>/single/senders/<senderId>/staged
Content-Type: application/json

{
    "receiver_id": null,
    "master_enable": false,
    "activation": {
        "mode": "activate_immediate",
        "requested_time": null
    },
    "transport_params": [
        { "rtp_enabled": false },
        { "rtp_enabled": false }
    ]
}
```

**Key notes:**

- Always sends two `transport_params` entries to cover dual-leg RTP/2022-7 redundancy
- Uses control versions `sr-ctrl/v1.1` and `v1.0` only (lower priority list than receiver patching)
- 30-second timeout (vs 10-second for receiver patches)

### Set multicast address on a sender

```http
PATCH <device_control_href>/single/senders/<senderId>/staged
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

**Key notes:**

- Second entry in `transport_params` covers the redundant leg (2022-7)
- To return to unicast/auto: set `"destination_ip": "auto"` and `"source_ip": "auto"`

---

## 5. IS-13 — Annotation API (alias persistence)

```http
PUT <annotation_service_baseUrl>/x-nmos/annotation/<version>/<resourceType>/<resourceId>
Content-Type: application/json

{
    "label": "My Device Alias",
    "description": "My Device Alias"
}
```

**Fallback chain when IS-13 is not available:**

1. **IS-13 Annotation API** (preferred, proper NMOS way)
2. **Matrox device API** — `PUT http://<host>:5050/api/device/description`
3. **Registry PATCH** — `PATCH http://<registry>/x-nmos/registration/<v>/resource/devices/<id>`
4. **Local storage only** (alias not persisted to device)

---

## 6. HTTP Request Configuration

All NMOS HTTP calls use the following settings:

| Setting | Value | Notes |
| --- | --- | --- |
| Timeout (receiver patch) | 10 000 ms | |
| Timeout (sender patch) | 30 000 ms | |
| `Connection` header | `keep-alive` | Reuses TCP connections |
| `Keep-Alive` header | `timeout=10, max=1000` | |
| `Cache-Control` header | `no-cache` | Prevents caching delays |
| `User-Agent` header | `NMOS-Crosspoint/2.0` | |
| `maxRedirects` | `0` | Disabled for speed |

**Supported transports:** `urn:x-nmos:transport:rtp.mcast`, `urn:x-nmos:transport:rtp`

**Unsupported transports:** `websocket`, `mqtt` — these are explicitly rejected with an error before any PATCH is attempted.

---

## 7. Summary — Complete Command Map

| Command | Method | Path | Purpose |
| --- | --- | --- | --- |
| Subscribe to registry | `POST` | `/x-nmos/query/<v>/subscriptions` | Real-time grain updates via WebSocket |
| Fetch SDP manifest | `GET` | `<sender.manifest_href>` | Get SDP for connection establishment |
| Get sender active state | `GET` | `.../single/senders/<id>/active/` | Read current sender config |
| Get channel mapping I/O | `GET` | `<cm-ctrl>/io` | Audio channel map configuration |
| Get active channel map | `GET` | `<cm-ctrl>/map/active` | Active audio routing state |
| Connect receiver (immediate) | `PATCH` | `.../single/receivers/<id>/staged` | Switch stream now |
| Stage receiver (prepare only) | `PATCH` | `.../single/receivers/<id>/staged` | Pre-load transport params, no activation |
| Disconnect receiver | `PATCH` | `.../single/receivers/<id>/staged` | Stop active stream |
| Enable sender | `PATCH` | `.../single/senders/<id>/staged` | Start sender output |
| Disable sender | `PATCH` | `.../single/senders/<id>/staged` | Stop sender output |
| Set multicast address | `PATCH` | `.../single/senders/<id>/staged` | Configure multicast destination |
| Persist alias (IS-13) | `PUT` | `/x-nmos/annotation/<v>/.../<id>` | Store alias in device |
| Persist alias (registry) | `PATCH` | `/x-nmos/registration/<v>/resource/devices/<id>` | Store alias in registry |
| Persist alias (Matrox) | `PUT` | `http://<host>:5050/api/device/description` | Matrox-specific alias storage |
