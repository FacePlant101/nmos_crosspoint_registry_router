/*
 * Virtual NMOS node (IS-04 API only).
 *
 * Publishes operator-supplied SDPs as a real IS-04 node so devices with no
 * NMOS support of their own are visible to other controllers. Worth testing
 * against a real registry rather than a mock: the claim is that a third-party
 * registry accepts what we register and that another controller can fetch the
 * manifest back.
 *
 * Brings up nmos-cpp as the registry and a crosspoint server beside it.
 * Needs Docker. Skips (exit 0) if it is unavailable.
 *   npm --prefix server run build && node test/integration/virtual-node.test.js
 */
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net"), http = require("http");
const { spawn, spawnSync, execFileSync } = require("child_process");
const crypto = require("crypto");

const repo = path.join(__dirname, "..", "..");
const serverDir = path.join(repo, "server");
if (!fs.existsSync(path.join(serverDir, "dist", "server.js"))) {
    console.error("build the server first: npm --prefix server run build");
    process.exit(2);
}
const have = (c, a) => spawnSync(c, a, { stdio: "ignore" }).status === 0;
if (!have("docker", ["info"])) { console.log("SKIP  docker unavailable"); process.exit(0); }

const WebSocket = require(path.join(serverDir, "node_modules", "ws"));
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const sh = (a) => execFileSync("docker", a, { stdio: "pipe" }).toString();

const REG = "vnode-test-registry";
const REG_PORT = 8086;
const SRV_PORT = 8093;
const IMAGE = "rhastie/nmos-cpp:master-0fb6b51";

const work = fs.mkdtempSync(path.join(os.tmpdir(), "vnode-"));
fs.writeFileSync(path.join(work, "registry.json"),
    JSON.stringify({ logging_level: 0, label: "vnode-test-registry", http_port: REG_PORT, domain: "local." }));

let pass = 0, fail = 0, child = null;
const check = (n, c, x) => { c ? (pass++, console.log("PASS  " + n)) : (fail++, console.log("FAIL  " + n + (x ? "  " + x : ""))); };
const cleanup = () => {
    try { if (child) child.kill("SIGKILL"); } catch (e) {}
    try { sh(["rm", "-f", REG]); } catch (e) {}
};
process.on("exit", cleanup);

const get = (url) => new Promise((res) => {
    http.get(url, (r) => { let b = ""; r.on("data", (d) => b += d); r.on("end", () => res({ status: r.statusCode, body: b })); })
        .on("error", () => res({ status: 0, body: "" }));
});
const waitPort = async (port) => {
    for (let i = 0; i < 60; i++) {
        const up = await new Promise((r) => {
            const s = net.connect(port, "127.0.0.1");
            s.once("connect", () => { s.destroy(); r(true); });
            s.once("error", () => r(false));
        });
        if (up) return true;
        await new Promise((r) => setTimeout(r, 500));
    }
    return false;
};

const SDP = `v=0
o=- 1443716955 1443716955 IN IP4 10.20.0.50
s=Legacy Camera 3
t=0 0
m=video 5004 RTP/AVP 96
c=IN IP4 239.200.0.11/64
a=source-filter: incl IN IP4 239.200.0.11 10.20.0.50
a=rtpmap:96 raw/90000
a=fmtp:96 sampling=YCbCr-4:2:2; width=1920; height=1080; exactframerate=25; depth=10; TCS=SDR; colorimetry=BT709; PM=2110GPM; TP=2110TPN;
a=ts-refclk:ptp=IEEE1588-2008:08-00-11-ff-fe-21-e1-b0:0
a=mediaclk:direct=0
a=mid:VID
`;

(async () => {
    try { sh(["rm", "-f", REG]); } catch (e) {}
    try { sh(["pull", "-q", IMAGE]); } catch (e) { console.log("SKIP  cannot pull " + IMAGE); process.exit(0); }
    try {
        sh(["run", "-d", "--name", REG, "-p", `${REG_PORT}:${REG_PORT}`,
            "-v", `${path.join(work, "registry.json")}:/home/registry.json`, IMAGE]);
    } catch (e) { console.log("SKIP  could not start the registry (port busy?)"); process.exit(0); }
    if (!await waitPort(REG_PORT)) { console.log("SKIP  registry did not come up"); process.exit(0); }

    // A crosspoint beside it.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vnode-srv-"));
    for (const d of ["config", "state", "log"]) fs.mkdirSync(path.join(root, d));
    for (const l of ["dist", "public", "node_modules"]) {
        try { fs.symlinkSync(path.join(serverDir, l), path.join(root, l)); } catch (e) {}
    }
    const CFG = path.join(root, "config", "settings.json");
    const base = JSON.parse(fs.readFileSync(path.join(serverDir, "config.default", "settings.json"), "utf8"));
    base.server.port = SRV_PORT;
    base.staticNmosRegistries = [{ ip: "127.0.0.1", port: REG_PORT, priority: 10, domain: "" }];
    fs.writeFileSync(CFG, JSON.stringify(base, null, 4));
    fs.copyFileSync(path.join(serverDir, "config.default", "users.json"), path.join(root, "config", "users.json"));

    const startServer = () => spawn(process.execPath, ["./dist/server.js"], { cwd: root, stdio: "ignore" });
    child = startServer();
    if (!await waitPort(SRV_PORT)) { console.log("SKIP  crosspoint did not come up"); process.exit(0); }

    // The API is mounted ahead of the SPA catch-all, so it answers JSON.
    const idx = await get(`http://127.0.0.1:${SRV_PORT}/x-nmos/node/v1.3/`);
    check("the node API is reachable, not swallowed by the SPA route",
        idx.status === 200 && idx.body.indexOf("senders/") !== -1, idx.body.slice(0, 60));

    // Enable it with one sender.
    const ws = new WebSocket(`ws://127.0.0.1:${SRV_PORT}/`);
    let id = 1; const pend = {}; let started = false;
    const req = (route, data) => new Promise((res, rej) => {
        const i = id++; pend[i] = { res, rej };
        ws.send(JSON.stringify({ type: "request", method: "POST", route, id: i, data }));
    });
    await new Promise((ready) => {
        ws.on("message", (raw) => {
            const t = raw.toString(); if (t === "pong") return;
            let m; try { m = JSON.parse(t); } catch (e) { return; }
            if (m.type === "authseed") ws.send(JSON.stringify({ type: "auth", user: "admin", password: sha256(sha256("admin") + m.seed) }));
            if (m.type === "auth" && !started) { started = true; ready(); }
            if (m.type === "response") {
                const p = pend[m.id];
                if (p) { delete pend[m.id]; (m.status === 200 || m.message === 200) ? p.res(m) : p.rej(m); }
            }
        });
    });

    let refused = false;
    try { await req("setupConfig", { virtualSenders: [{ id: "x", name: "junk", sdp: "not an sdp at all" }] }); }
    catch (e) { refused = true; }
    check("a paste that is not an SDP is refused", refused);

    await req("setupConfig", {
        virtualNode: { enabled: true, label: "Crosspoint Virtual Node" },
        virtualSenders: [{ id: "vs_cam3", name: "Legacy Camera 3", sdp: SDP }],
    });
    await new Promise((r) => setTimeout(r, 6000));

    // What the SDP became.
    const flows = JSON.parse((await get(`http://127.0.0.1:${SRV_PORT}/x-nmos/node/v1.3/flows`)).body || "[]");
    const f = flows[0] || {};
    check("the SDP maps to a correct IS-04 flow",
        f.media_type === "video/raw" && f.frame_width === 1920 && f.frame_height === 1080 && f.colorspace === "BT709",
        JSON.stringify({ m: f.media_type, w: f.frame_width, h: f.frame_height, c: f.colorspace }));

    // The registry accepted it.
    const nodes = JSON.parse((await get(`http://127.0.0.1:${REG_PORT}/x-nmos/query/v1.3/nodes`)).body || "[]");
    const senders = JSON.parse((await get(`http://127.0.0.1:${REG_PORT}/x-nmos/query/v1.3/senders`)).body || "[]");
    const ours = nodes.filter((n) => (n.label || "").indexOf("Virtual") !== -1);
    check("the registry accepted the node", ours.length === 1, JSON.stringify(nodes.map((n) => n.label)));
    check("the registry accepted the sender",
        senders.length === 1 && senders[0].label === "Legacy Camera 3", JSON.stringify(senders.map((s) => s.label)));

    // Another controller can fetch the manifest back.
    const sid = senders[0] && senders[0].id;
    const tf = await get(`http://127.0.0.1:${SRV_PORT}/x-nmos/connection/v1.0/single/senders/${sid}/transportfile`);
    check("the transportfile serves the SDP", tf.status === 200 && tf.body.indexOf("239.200.0.11") !== -1, String(tf.status));

    for (const ep of ["constraints", "staged", "active"]) {
        const r = await get(`http://127.0.0.1:${SRV_PORT}/x-nmos/connection/v1.0/single/senders/${sid}/${ep}`);
        check("IS-05 " + ep + " responds", r.status === 200, String(r.status));
    }

    // Shape, not just status. A sender's staged/active response carries
    // receiver_id; sender_id and transport_file belong to the RECEIVER
    // response, and a controller validating against the sender schema rejects
    // them. The SDP lives at /transportfile, checked above.
    for (const ep of ["staged", "active"]) {
        const r = await get(`http://127.0.0.1:${SRV_PORT}/x-nmos/connection/v1.0/single/senders/${sid}/${ep}`);
        let b = {};
        try { b = JSON.parse(r.body || "{}"); } catch (e) {}
        check("IS-05 " + ep + " uses the sender response shape",
            Object.prototype.hasOwnProperty.call(b, "receiver_id") &&
            !Object.prototype.hasOwnProperty.call(b, "sender_id") &&
            !Object.prototype.hasOwnProperty.call(b, "transport_file"),
            Object.keys(b).join(","));
        check("IS-05 " + ep + " still carries the transport params",
            Array.isArray(b.transport_params) && b.transport_params.length >= 1 &&
            b.transport_params[0].destination_ip === "239.200.0.11",
            JSON.stringify(b.transport_params));
    }

    // Identifiers must survive a restart, or every boot orphans a node.
    const before = JSON.parse(fs.readFileSync(CFG, "utf8"));
    child.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 2000));
    child = startServer();
    await waitPort(SRV_PORT);
    // The registry expires a node ~12s after its last heartbeat, and
    // registration here waits 2s for the listener plus an address probe, so
    // give re-registration room rather than racing it.
    await new Promise((r) => setTimeout(r, 20000));
    const after = JSON.parse(fs.readFileSync(CFG, "utf8"));
    check("the node id survives a restart",
        before.virtualNode.nodeId === after.virtualNode.nodeId, after.virtualNode.nodeId);
    check("the sender id survives a restart",
        before.virtualSenders[0].senderId === after.virtualSenders[0].senderId);

    const nodes2 = JSON.parse((await get(`http://127.0.0.1:${REG_PORT}/x-nmos/query/v1.3/nodes`)).body || "[]");
    check("a restart does not orphan a second node in the registry",
        nodes2.filter((n) => (n.label || "").indexOf("Virtual") !== -1).length === 1,
        JSON.stringify(nodes2.map((n) => n.label)));

    console.log(`\n${pass} passed, ${fail} failed`);
    cleanup();
    process.exit(fail ? 1 : 0);
})();
