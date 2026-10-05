# Standalone operation

This guide covers running the server directly on a host without Balena or Docker. The UI is served from `server/public` after a UI build.

## Requirements

- Node.js 20+
- An NMOS registry reachable from this host (or run one separately)
- Network access to NMOS devices (mDNS discovery works best when the host is on the same network)

## Setup

1. Copy the example configuration:

```shell
cp -R server/config_example server/config
```

1. Install dependencies and build UI + server:

```shell
cd ui
npm install
npm run build

cd ../server
npm install
npm run build
```

1. Create state folders if the server logs warn about missing paths (for example, `server/state/mediadev_matroxcip`).

## Run

```shell
cd server
node ./dist/server.js
```

The UI will be served from the server (default `http://<host>:80`).

## Optional environment overrides

- `MATROX_CIP_USER`
- `MATROX_CIP_PASSWORD`

## Linux systemd service example

Adjust the paths to match your installation directory.

```
[Unit]
Description=nmos_crosspoint
Documentation=https://github.com/avassdal/nmos_crosspoint_registry_router
After=network.target

[Service]
Type=simple
User=nmos
WorkingDirectory=/opt/nmos_crosspoint/server
ExecStart=/usr/bin/node /opt/nmos_crosspoint/server/dist/server.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```