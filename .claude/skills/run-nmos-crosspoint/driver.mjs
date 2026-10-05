#!/usr/bin/env node
// Rig + driver for the NMOS crosspoint, using alabou/NMOS-Reference as the
// device side. NMOS-Reference is the Python reference Node/Registry written
// against the Matrox "MatroxOnly" NMOS extensions
// (https://github.com/alabou/NMOS-MatroxOnly): IS-11 stream-compat controls,
// H.264/H.265/JPEG-XS/AM824 flows and the USB transport. Two of its Nodes give
// the crosspoint something Matrox-shaped to route without real hardware.
//
// Run from the repo root:  node .claude/skills/run-nmos-crosspoint/driver.mjs <cmd>
// See SKILL.md next to this file for the command list.

import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import crypto from "node:crypto";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../../..");
const RIG = path.join(ROOT, ".rig");
const REF = path.join(RIG, "NMOS-Reference");
const CP = path.join(RIG, "crosspoint");          // crosspoint cwd: own config/state, symlinked dist/public
const LOGS = path.join(RIG, "logs");
const PIDS = path.join(RIG, "pids");

// Pinned: NMOS-Reference moves fast and its resource set changes with it.
const REF_URL = "https://github.com/alabou/NMOS-Reference.git";
const REF_SHA = "02b5a56482266fa99d79474ef58fad89c4d54dfc";

// 18099, not 8099: other checkouts/sessions on this machine run crosspoints on 80xx.
const CP_PORT = +(process.env.CP_PORT || 18099);
const QUERY = "http://127.0.0.1:8443/x-nmos/query/v1.3";   // NMOS-Reference registry: reg 8444, query 8443, ws 8448
const USER = process.env.CP_USER || "admin", PASS = process.env.CP_PASS || "admin";

const require = createRequire(path.join(ROOT, "server", "package.json"));
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const die = (m) => { console.error(m); process.exit(1); };
const nmosId = (id) => (id.startsWith("nmos_") || id.includes(".") ? id : "nmos_" + id);

// ---------------------------------------------------------------- processes

const PROCS = {
    registry: { cwd: REF, cmd: "bash", args: ["start-registry-bare.sh"], port: 8443 },
    node1:    { cwd: REF, cmd: "bash", args: ["start-node1-bare.sh"],    port: 7051 },
    node2:    { cwd: REF, cmd: "bash", args: ["start-node2-bare.sh"],    port: 7052 },
    crosspoint: { cwd: CP, cmd: process.execPath, args: ["./dist/server.js"], port: CP_PORT },
};

function pidOf(name) {
    try { const p = +fs.readFileSync(path.join(PIDS, name + ".pid"), "utf8"); process.kill(p, 0); return p; }
    catch { return 0; }
}

function startProc(name) {
    if (pidOf(name)) { console.log(`${name}: already running (pid ${pidOf(name)})`); return; }
    const p = PROCS[name];
    const out = fs.openSync(path.join(LOGS, name + ".log"), "a");
    const env = { ...process.env, PATH: path.join(REF, ".venv", "bin") + ":" + process.env.PATH, PYTHONUNBUFFERED: "1" };
    const child = spawn(p.cmd, p.args, { cwd: p.cwd, env, detached: true, stdio: ["ignore", out, out] });
    child.unref();
    fs.writeFileSync(path.join(PIDS, name + ".pid"), String(child.pid));
    console.log(`${name}: started pid ${child.pid}, log .rig/logs/${name}.log`);
}

function stopProc(name) {
    const p = pidOf(name);
    if (!p) return;
    try { process.kill(-p, "SIGTERM"); } catch { try { process.kill(p, "SIGTERM"); } catch {} }
    fs.rmSync(path.join(PIDS, name + ".pid"), { force: true });
    console.log(`${name}: stopped pid ${p}`);
}

// True if something already accepts connections on 127.0.0.1:port (wildcard or loopback bind).
function portBusy(port) {
    return new Promise((res) => {
        const s = net.connect({ host: "127.0.0.1", port });
        s.once("connect", () => { s.destroy(); res(true); });
        s.once("error", () => res(false));
    });
}

async function waitHttp(url, ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        try { const r = await fetch(url); if (r.ok) return true; } catch {}
        await sleep(500);
    }
    return false;
}

// Crosspoint run dir: symlinks to the built server, rig-only config + state.
// Never touches server/config, so a developer's real config is safe.
function prepareCrosspointDir() {
    for (const d of [CP, path.join(CP, "config"), path.join(CP, "state"), path.join(CP, "log")]) fs.mkdirSync(d, { recursive: true });
    for (const l of ["dist", "public", "node_modules"]) {
        const target = path.join(ROOT, "server", l), link = path.join(CP, l);
        if (!fs.existsSync(target)) die(`missing server/${l} — build first (see SKILL.md "Build")`);
        if (!fs.existsSync(link)) fs.symlinkSync(target, link);
    }
    const s = JSON.parse(fs.readFileSync(path.join(ROOT, "server/config.default/settings.json"), "utf8"));
    s.staticNmosRegistries = [{ ip: "127.0.0.1", port: 8443, priority: 10, domain: "" }];
    s.nmos.registryVersions = ["v1.3"];          // NMOS-Reference's registry 404s v1.2 subscriptions
    s.server = { port: CP_PORT, address: "127.0.0.1" };
    fs.writeFileSync(path.join(CP, "config/settings.json"), JSON.stringify(s, null, 4));
    fs.copyFileSync(path.join(ROOT, "server/config.default/users.json"), path.join(CP, "config/users.json")); // admin/admin
}

// ---------------------------------------------------------------- websocket

function connectWs() {
    let WebSocket;
    try { WebSocket = require("ws"); } catch { die("server/node_modules missing: npm --prefix server install"); }
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${CP_PORT}/`);
        const pending = new Map(), syncs = new Map();
        let reqId = 1;
        const api = {
            ws,
            request(method, route, data = null) {
                const id = reqId++;
                ws.send(JSON.stringify({ type: "request", method, id, route, data }));
                return new Promise((res) => pending.set(id, res));
            },
            sync(channel, objectId = 0) {
                ws.send(JSON.stringify({ type: "sync", channel, objectId }));
                return new Promise((res) => syncs.set(channel, res));
            },
            close() { ws.close(); },
        };
        ws.on("error", (e) => reject(new Error(`crosspoint ws on :${CP_PORT} — ${e.message}. Is it up? (driver.mjs status)`)));
        ws.on("message", (raw) => {
            const m = JSON.parse(raw);
            // Server password is sha256(plain); the proof is sha256(that + seed) — same as the UI.
            if (m.type === "authseed") ws.send(JSON.stringify({ type: "auth", user: USER, password: sha256(sha256(PASS) + m.seed) }));
            else if (m.type === "auth") resolve(api);
            else if (m.type === "authfailed") reject(new Error("auth failed for " + USER));
            else if (m.type === "response" || m.id !== undefined && pending.has(m.id)) { pending.get(m.id)?.(m); pending.delete(m.id); }
            else if (m.type === "sync" && m.action === "init" && syncs.has(m.channel)) { syncs.get(m.channel)(m.data); syncs.delete(m.channel); }
        });
    });
}

async function withWs(fn) {
    const api = await connectWs();
    try { return await fn(api); } finally { api.close(); }
}

const flatSenders = (dev, kind = "senders") =>
    Object.entries(dev[kind] || {}).flatMap(([type, arr]) => arr.map((f) => ({ ...f, type })));

// ---------------------------------------------------------------- IS-05 check

async function getJson(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
}

// Read the receiver's IS-05 /active straight from the node, bypassing the crosspoint.
async function receiverActive(rxId) {
    const uuid = rxId.replace(/^nmos_/, "");
    const rx = await getJson(`${QUERY}/receivers/${uuid}`);
    const dev = await getJson(`${QUERY}/devices/${rx.device_id}`);
    const ctl = dev.controls.find((c) => c.type.startsWith("urn:x-nmos:control:sr-ctrl/"));
    const href = ctl.href.endsWith("/") ? ctl.href : ctl.href + "/";
    return getJson(`${href}single/receivers/${uuid}/active`);
}

// ---------------------------------------------------------------- commands

const cmds = {
    async setup() {
        fs.mkdirSync(RIG, { recursive: true });
        if (!fs.existsSync(path.join(REF, ".git"))) {
            execFileSync("git", ["clone", REF_URL, REF], { stdio: "inherit" });
        }
        execFileSync("git", ["-C", REF, "fetch", "--depth", "50", "origin", REF_SHA], { stdio: "inherit" });
        execFileSync("git", ["-C", REF, "checkout", "-q", REF_SHA], { stdio: "inherit" });
        if (!fs.existsSync(path.join(REF, ".venv"))) {
            // NMOS-Reference needs Python >= 3.12.
            const uv = spawnSync("uv", ["--version"]).status === 0;
            if (uv) execFileSync("uv", ["venv", "-p", "3.13", path.join(REF, ".venv")], { stdio: "inherit" });
            else execFileSync("python3", ["-m", "venv", path.join(REF, ".venv")], { stdio: "inherit" });
        }
        const pip = spawnSync("uv", ["--version"]).status === 0
            ? ["uv", ["pip", "install", "-p", path.join(REF, ".venv"), "-r", path.join(REF, "requirements.txt")]]
            : [path.join(REF, ".venv/bin/pip"), ["install", "-r", path.join(REF, "requirements.txt")]];
        execFileSync(pip[0], pip[1], { stdio: "inherit" });
        // Node Playwright for `screenshot`, kept inside .rig so the repo's package.json is untouched.
        if (!fs.existsSync(path.join(RIG, "node_modules/playwright"))) {
            fs.writeFileSync(path.join(RIG, "package.json"), '{"private":true}');
            execFileSync("npm", ["install", "--prefix", RIG, "--no-audit", "--no-fund", "playwright@1"], { stdio: "inherit" });
            execFileSync(path.join(RIG, "node_modules/.bin/playwright"), ["install", "chromium"], { stdio: "inherit" });
        }
        console.log("setup done");
    },

    async up() {
        if (!fs.existsSync(path.join(REF, ".venv"))) die("run `driver.mjs setup` first");
        for (const d of [LOGS, PIDS]) fs.mkdirSync(d, { recursive: true });
        // A foreign listener on a rig port means the driver would talk to the wrong process.
        for (const [n, p] of Object.entries(PROCS)) {
            if (!pidOf(n) && await portBusy(p.port)) die(`port ${p.port} (${n}) is already in use by another process — stop it${n === "crosspoint" ? " or set CP_PORT" : ""}`);
        }
        if (+process.versions.node.split(".")[0] >= 24) {
            console.log(`note: Node ${process.versions.node} — media device drivers (Matrox Convert IP, Riedel) will fail to load (Dirent.path removed in Node 24); NMOS routing is unaffected`);
        }
        startProc("registry");
        if (!(await waitHttp(`${QUERY}/nodes`, 20000))) die("registry did not come up — see .rig/logs/registry.log");
        startProc("node1"); startProc("node2");
        // Each node registers 5 senders; give them time before the crosspoint's first query.
        const end = Date.now() + 60000;
        while (Date.now() < end) {
            try { if ((await getJson(`${QUERY}/senders`)).length >= 10) break; } catch {}
            await sleep(1000);
        }
        prepareCrosspointDir();
        startProc("crosspoint");
        if (!(await waitHttp(`http://127.0.0.1:${CP_PORT}/`, 20000))) die("crosspoint did not come up — see .rig/logs/crosspoint.log");
        // Ready means the crosspoint model has both nodes' senders, not just that the port is open.
        // 8, not 10: the crosspoint has no "mux" category, so each node's AM824 mux sender is dropped.
        const end2 = Date.now() + 90000;
        while (Date.now() < end2) {
            try {
                const cp = await withWs((a) => a.sync("crosspoint"));
                const n = cp.devices.flatMap((d) => flatSenders(d)).length;
                if (cp.devices.length >= 2 && n >= 8) { console.log(`ready: ${cp.devices.length} devices, ${n} senders — UI http://127.0.0.1:${CP_PORT}/ (admin/admin)`); return; }
            } catch {}
            await sleep(1000);
        }
        die("crosspoint never saw both nodes — see .rig/logs/crosspoint.log");
    },

    async down() { for (const n of ["crosspoint", "node2", "node1", "registry"]) stopProc(n); },

    async status() {
        for (const [n, p] of Object.entries(PROCS)) console.log(`${n.padEnd(11)} ${pidOf(n) ? "pid " + pidOf(n) : "down"}  :${p.port}`);
    },

    // Table of everything the crosspoint model holds.
    async ls() {
        const cp = await withWs((a) => a.sync("crosspoint"));
        for (const d of cp.devices) {
            console.log(`\n# device ${d.num} ${d.alias || d.name}  ${d.id}`);
            for (const kind of ["senders", "receivers"]) {
                for (const f of flatSenders(d, kind)) {
                    const caps = f.capabilities || {};
                    console.log(`  ${kind === "senders" ? "TX" : "RX"} ${f.type.padEnd(6)} ${f.id}  ${(f.name || "").padEnd(36)} transport=${JSON.stringify(caps.transport ?? "")} media=${(caps.mediaTypes || []).join(",")} format=${JSON.stringify(f.format ?? "")}${f.connectedFlow ? "  <- " + f.connectedFlow : ""}`);
                }
            }
        }
    },

    async sync(channel = "crosspoint") {
        const data = await withWs((a) => a.sync(channel));
        console.log(JSON.stringify(data, null, 2));
    },

    async get(route) { console.log(JSON.stringify(await withWs((a) => a.request("GET", route)), null, 2)); },
    async post(route, json = "{}") { console.log(JSON.stringify(await withWs((a) => a.request("POST", route, JSON.parse(json))), null, 2)); },

    // Route sender -> receiver through the crosspoint, then read IS-05 /active on the node itself.
    async connect(src, dst, mode = "") {
        if (!src || !dst) die("usage: connect <senderId|__disconnect> <receiverId> [prepare|preview]");
        const body = { source: src === "__disconnect" ? "__disconnect" : nmosId(src), destination: nmosId(dst) };
        if (mode) body[mode] = true;
        const res = await withWs((a) => a.request("POST", "makeconnection", body));
        console.log("crosspoint:", JSON.stringify({ status: res.status, message: res.message, data: res.data, error: res.error }));
        await sleep(500);
        const act = await receiverActive(dst);
        const tp = act.transport_params?.[0] || {};
        console.log("node /active:", JSON.stringify({ sender_id: act.sender_id, master_enable: act.master_enable, multicast_ip: tp.multicast_ip, destination_port: tp.destination_port, source_ip: tp.source_ip }));
    },

    async active(rx) { console.log(JSON.stringify(await receiverActive(rx), null, 2)); },

    // Screenshot a UI route, logged in as admin. Default route: /crosspoint.
    async screenshot(route = "/crosspoint", out = path.join(RIG, "shot.png")) {
        const req = createRequire(path.join(RIG, "package.json"));
        let chromium;
        try { ({ chromium } = req("playwright")); } catch { die("playwright missing — run `driver.mjs setup`"); }
        const browser = await chromium.launch();
        try {
            const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
            await page.goto(`http://127.0.0.1:${CP_PORT}${route}`);
            const user = page.locator('input[autocomplete="username"], input[type="text"]').first();
            if (await user.isVisible({ timeout: 5000 }).catch(() => false)) {
                await user.fill(USER);
                await page.locator('input[type="password"]').first().fill(PASS);
                await page.locator('input[type="password"]').first().press("Enter");
            }
            await page.waitForTimeout(2500);
            await page.screenshot({ path: out, fullPage: true });
            console.log("screenshot:", path.relative(process.cwd(), out));
        } finally { await browser.close(); }
    },

    async logs(name = "crosspoint", n = "40") {
        const lines = fs.readFileSync(path.join(LOGS, name + ".log"), "utf8").trimEnd().split("\n");
        console.log(lines.slice(-+n).join("\n"));
    },
};

const [cmd, ...args] = process.argv.slice(2);
if (!cmds[cmd]) {
    console.log("usage: driver.mjs setup|up|down|status|ls|sync [ch]|get <route>|post <route> <json>|connect <tx> <rx> [prepare|preview]|active <rx>|screenshot [route] [out.png]|logs [name] [n]");
    process.exit(cmd ? 1 : 0);
}
await cmds[cmd](...args);
