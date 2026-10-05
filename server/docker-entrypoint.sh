#!/bin/sh
# NMOS Crosspoint container entrypoint.
#
# The config + state directories are bind-mounted from the host. On a fresh
# host those mounts are EMPTY, which crashes the server (it requires
# ./config/settings.json to exist). This script seeds the default config files
# from the image's ./config.default into the mounted ./config the first time
# round, without ever clobbering an operator's existing files.
#
# WORKDIR is /nmos-crosspoint/server, so all paths here are relative to it.

set -e

# Probe mode: the same image doubles as the multicast probe — a helper on a
# media-network host that forwards multicast RTP to the crosspoint as unicast.
# No config/state mounts needed; driven entirely by env vars:
#   MODE=probe CROSSPOINT_URL=ws://<crosspoint> PROBE_TOKEN=<token>
#   [PROBE_NAME="Studio A"] [PROBE_IFACE=<local ip>]
if [ "$MODE" = "probe" ]; then
    if [ ! -f ./dist/probe.js ]; then
        echo "[entrypoint] MODE=probe but ./dist/probe.js is missing in this image." >&2
        exit 1
    fi
    exec node ./dist/probe.js
fi

CONFIG_DIR="./config"
DEFAULT_DIR="./config.default"

# Make sure the persistent directories exist (empty mounts may not have them).
mkdir -p "$CONFIG_DIR" ./state ./log

# Which default files are missing from the config mount?
MISSING=""
if [ -d "$DEFAULT_DIR" ]; then
    for f in settings.json users.json; do
        if [ ! -f "$CONFIG_DIR/$f" ] && [ -f "$DEFAULT_DIR/$f" ]; then
            MISSING="$MISSING $f"
        fi
    done
fi

# Refuse to seed defaults over an existing deployment.
#
# Seeding is for a genuine first boot. If the config is missing but ./state
# holds data, this is almost certainly an EXISTING install whose config mount
# is empty or pointing at the wrong path — a fresh clone of the repo, say,
# since server/config is gitignored. Seeding there would silently replace the
# operator's registry address and reset the login to admin/admin while their
# aliases, crosspoint numbers and leases sat right next to it in ./state.
#
# Set ALLOW_CONFIG_RESEED=true to proceed anyway, which is the deliberate
# "reset my configuration but keep my state" case.
if [ -n "$MISSING" ] && [ -n "$(ls -A ./state 2>/dev/null)" ] && [ "$ALLOW_CONFIG_RESEED" != "true" ]; then
    echo "[entrypoint] REFUSING TO START." >&2
    echo "[entrypoint]" >&2
    echo "[entrypoint] Missing from $CONFIG_DIR:$MISSING" >&2
    echo "[entrypoint] ...but ./state already holds data, so this is not a first boot." >&2
    echo "[entrypoint]" >&2
    echo "[entrypoint] Seeding the shipped defaults here would replace your NMOS registry" >&2
    echo "[entrypoint] address and reset the login to admin/admin. The usual cause is a" >&2
    echo "[entrypoint] config volume that is empty or mounted from the wrong path —" >&2
    echo "[entrypoint] server/config is gitignored, so it is absent in a fresh clone." >&2
    echo "[entrypoint]" >&2
    echo "[entrypoint] Either restore your config into the mounted $CONFIG_DIR," >&2
    echo "[entrypoint] or set ALLOW_CONFIG_RESEED=true to start from the defaults." >&2
    exit 1
fi

# Seed each default file only when it's missing — an existing operator config
# is left completely untouched. The shipped users.json is admin/admin; change
# it on first login.
for f in $MISSING; do
    echo "[entrypoint] seeding default $f into $CONFIG_DIR"
    cp "$DEFAULT_DIR/$f" "$CONFIG_DIR/$f"
done

# Hand off to the Node server as PID 1 (exec -> proper signal handling).
exec node ./dist/server.js
