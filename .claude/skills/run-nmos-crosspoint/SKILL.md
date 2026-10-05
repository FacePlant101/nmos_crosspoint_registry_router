---
name: run-nmos-crosspoint
description: Build, run, start, drive, test and screenshot the NMOS crosspoint (server + Svelte UI) against a local Matrox/IPMX-flavoured NMOS rig (alabou/NMOS-Reference registry + 2 nodes, per the NMOS-MatroxOnly specs). Use to make connections over the WebSocket API, verify IS-05 PATCHes on the node, check USB/H.264/AM824/PEP handling, or take UI screenshots without real hardware.
---

# Run the NMOS crosspoint against a MatroxOnly NMOS rig

The crosspoint is a Node/TS server (`server/`) serving a Svelte UI (`ui/` builds
into `server/public`) and a WebSocket API. On its own it has nothing to route,
so the driver brings up [alabou/NMOS-Reference](https://github.com/alabou/NMOS-Reference):
the Python reference Registry and Node written against the
[NMOS-MatroxOnly](https://github.com/alabou/NMOS-MatroxOnly) extensions. Each
node registers H.264 video, L24 and AM824 audio, an AM824 mux, and a USB
sender/receiver pair, all with IPMX privacy (PEP) params. That is the
Matrox-shaped traffic the crosspoint sees from real Convert IP gear.

All paths are relative to the repo root. The driver is
`.claude/skills/run-nmos-crosspoint/driver.mjs`. Everything it creates goes under
`.rig/`, which is gitignored. It never touches `server/config`.

## Prerequisites

Node 20+, git, and Python ≥ 3.12 (`uv` is used if present, otherwise `python3 -m venv`).
Verified on macOS (arm64) with Node 26 and Python 3.13 via uv.

## Build

```bash
cd ui && npm install && npm run build && cd ..
cd server && npm install && npm run build && cd ..
```

One-time rig setup. This clones NMOS-Reference at a pinned SHA into `.rig/`,
creates its venv, and installs Node Playwright + Chromium into `.rig/` for
screenshots (about 250 MB the first time):

```bash
node .claude/skills/run-nmos-crosspoint/driver.mjs setup
```

## Run (agent path)

```bash
node .claude/skills/run-nmos-crosspoint/driver.mjs up        # registry :8443, node1 :7051, node2 :7052, crosspoint :18099
node .claude/skills/run-nmos-crosspoint/driver.mjs status
node .claude/skills/run-nmos-crosspoint/driver.mjs ls        # devices, TX/RX ids, transport/media/format as the crosspoint sees them
```

`up` returns only after the crosspoint model holds both nodes (about 5 s). The UI is at
`http://127.0.0.1:18099/`. Log in as admin/admin.

Make a connection, then check it on the node's own IS-05 API. This route is
node2's H.264 video to node1's video receiver:

```bash
node .claude/skills/run-nmos-crosspoint/driver.mjs connect 00000000-2000-4000-8006-453036130002 00000000-3010-4000-8006-453036130001
```

The command prints two lines. The first, `crosspoint: {...}`, is the
`makeconnection` response. On failure, look in
`data.connections[0].status/detail`. The second, `node /active: {...}`, is read
straight from the receiver's node with `sender_id`, `master_enable` and the
multicast/port. Treat that second line as the ground truth. IDs can be a bare
UUID, `nmos_<uuid>`, or crosspoint addressing such as `1000.v1`. Pass
`__disconnect` as the sender to disconnect. An optional third arg
`prepare|preview` stages without activating.

Other commands:

```bash
node .claude/skills/run-nmos-crosspoint/driver.mjs active 00000000-3010-4000-8006-453036130001   # full IS-05 /active incl. ext_privacy_* and SDP
node .claude/skills/run-nmos-crosspoint/driver.mjs sync crosspoint      # raw SyncObject: crosspoint|nmos|log|mediadevices|uiconfig|...
node .claude/skills/run-nmos-crosspoint/driver.mjs get flowInfo/nmos_00000000-2000-4000-8006-453036130002
node .claude/skills/run-nmos-crosspoint/driver.mjs post togglehidden '{"id":"nmos_00000000-2040-4000-8006-453036130002"}'   # a toggle: run twice to undo
node .claude/skills/run-nmos-crosspoint/driver.mjs screenshot /crosspoint .rig/crosspoint.png   # logs in first; any UI route
node .claude/skills/run-nmos-crosspoint/driver.mjs logs crosspoint 40   # or registry|node1|node2
node .claude/skills/run-nmos-crosspoint/driver.mjs down
```

`get`/`post` take any route registered with `server.addRoute(...)` in
`server/src`. GET args are extra `/` path segments.

## Direct invocation (internal code)

Most server PRs touch a single module. The pattern in `test/unit/*.test.js` is
to `require()` the compiled module from `server/dist/lib/...` with `cwd` set to
a temp dir that has a `state/` subdir, then call it:

```bash
cd server && npm run build && cd ..
sh test/unit/run-all.sh
cd server && ./node_modules/.bin/tsc --noEmit && cd ..
```

`server` has no `npm test` (it fails by design). `cd ui && npm run check` runs svelte-check.

## Run (human path)

Run `cd server && npm run dev` (tsc-watch + `--inspect`) with a hand-written
`server/config/settings.json`. With the default port 80 it needs root. For
local work, prefer the driver.

## Gotchas

- **USB routing fails against IPMX nodes.** NMOS-Reference publishes USB as
  `urn:x-nmos:transport:usb` (its canonical namespace). The MatroxOnly spec says
  `urn:x-matrox:transport:usb`, and `transportShortCode()` in
  `server/src/lib/functions.ts` only knows the Matrox URN. In `ls` the USB
  resources show `transport=""`, and `connect` on the USB pair
  (`…2030…0002` → `…3030…0001`) fails with `Transport Type missing.`. That is
  current behaviour, not a rig fault.
- **Mux senders are dropped.** Each node registers 5 senders, but the
  crosspoint shows 4. The `urn:x-nmos:format:mux` AM824 sender has no category
  in the crosspoint model. `up` therefore waits for 8 senders, not 10.
- **Format strings from MatroxOnly flows are partly broken.** The USB data
  flow renders as the literal `flow.media.type`. AM824 audio renders as
  `2Ch undefinedbit 48kHz`. Use `ls` to see this.
- **Both devices are labelled "This is the device"**, in the UI and in `ls`.
  Tell them apart by `num` (1000/1001) or by the id suffix `…0001`/`…0002`
  (node1/node2).
- **Senders are idle.** Their `master_enable` is false and `destination_ip` is
  `0.0.0.0`, so a successful route gives `multicast_ip: null` and
  `destination_port: 22000` on the receiver. PEP keys (`ext_privacy_*`) do
  flow through to the receiver. No media is sent, so the audio monitor has
  nothing to decode. The crosspoint fetches a sender's SDP only while that
  sender's `subscription.active` is true. Rig senders are never active, so
  `get senderSdp/<id>` returns 404 `no SDP known for this sender` and every
  flow shows `manifestOk: false`. That is expected here.
- **The registry is v1.3 only.** The rig config sets `registryVersions: ["v1.3"]`.
  With the default `["v1.3","v1.2"]` you get a 404 error per resource type at
  startup, which is harmless but noisy.
- **IS-05 version.** The crosspoint PATCHes `/x-nmos/connection/v1.2/`
  (advertised in the device controls) even though settings list
  `connectVersions: ["v1.1","v1.0"]`.
- **The rig config is regenerated on every `up`.** It goes to
  `.rig/crosspoint/config` (port 18099 on 127.0.0.1, `CP_PORT` overrides it, admin/admin, registry
  127.0.0.1:8443). `dist`, `public` and `node_modules` are symlinks into
  `server/`, so rebuild `server` and run `down`/`up` to pick up changes.
  State (aliases, leases) persists in `.rig/crosspoint/state`. Delete it for a
  clean slate.
- **Auth.** `users.json` stores `sha256(password)`. The WebSocket auth proof is
  `sha256(storedHash + authseed)`. The driver does this; the `global` channels
  reject `__noAuth`.

## Troubleshooting

- **`crosspoint never saw both nodes`.** Run `driver.mjs logs node1`. If nodes
  are still registering, rerun `up`, which is idempotent and skips running
  processes.
- **`connect` says `Sender not available in NMOS`, or `active` 404s on the
  registry.** The nodes logged `heartbeat returned 404 — restarting
  registration`: the registry expired them, which happens after the host
  sleeps or its clock jumps. They re-register within seconds. Rerun the
  command.
- **`playwright missing`.** Run `driver.mjs setup`. It installs Playwright
  under `.rig/`, not in the repo.
- **npm 11 skips install scripts.** `npm install` in `server/` warns that
  `@discordjs/opus` install scripts were not run. The server still starts,
  routes and serves the UI without it. The audio monitor was not exercised
  because the rig sends no media.
- **`up` dies with `port … is already in use`.** Something else is listening
  there. Other crosspoint checkouts often sit on 80xx; this rig uses 18099
  for that reason. Run `CP_PORT=18100 node .claude/skills/run-nmos-crosspoint/driver.mjs up`.
  `CP_PORT` must also be set for every later driver command. Do not kill a
  listener the driver did not start.
