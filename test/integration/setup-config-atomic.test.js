/*
 * setupConfig applies all-or-nothing.
 *
 * The route used to validate and apply field by field, so a request that
 * failed on a later field had already mutated the shared settings object for
 * the earlier ones. Nothing reached disk, so the UI reported a failed save
 * while the running server had quietly moved on — and the next unrelated save
 * then persisted the change the operator was told had been rejected.
 *
 * That divergence is invisible on the setupConfig channel, which only
 * republishes after a success, so this asserts against settings.json.
 *
 * Starts a real server on a free port; needs a built server and UI.
 *   npm --prefix server run build && node test/integration/setup-config-atomic.test.js
 */
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net");
const { spawn } = require("child_process");
const crypto = require("crypto");

const repo = path.join(__dirname, "..", "..");
const serverDir = path.join(repo, "server");
if (!fs.existsSync(path.join(serverDir, "dist", "server.js"))) {
    console.error("build the server first: npm --prefix server run build");
    process.exit(2);
}
const WebSocket = require(path.join(serverDir, "node_modules", "ws"));
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

function freePort() {
    return new Promise((res, rej) => {
        const srv = net.createServer();
        srv.once("error", rej);
        srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => res(p)); });
    });
}

(async () => {
    const port = await freePort();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "setupcfg-"));
    fs.mkdirSync(path.join(root, "config"));
    fs.mkdirSync(path.join(root, "state"));
    fs.mkdirSync(path.join(root, "log"));
    for (const link of ["dist", "public", "node_modules"]) {
        try { fs.symlinkSync(path.join(serverDir, link), path.join(root, link)); } catch (e) {}
    }
    const CFG = path.join(root, "config", "settings.json");
    const base = JSON.parse(fs.readFileSync(path.join(serverDir, "config.default", "settings.json"), "utf8"));
    base.server.port = port;
    base.staticNmosRegistries = [{ ip: "10.1.1.1", port: 80, priority: 10, domain: "" }];
    base.debugLogs = false;
    fs.writeFileSync(CFG, JSON.stringify(base, null, 4));
    fs.copyFileSync(path.join(serverDir, "config.default", "users.json"), path.join(root, "config", "users.json"));

    const child = spawn(process.execPath, ["./dist/server.js"], { cwd: root, stdio: "ignore" });
    const stop = () => { try { child.kill("SIGKILL"); } catch (e) {} };
    process.on("exit", stop);

    // Wait for the port to accept connections.
    for (let i = 0; i < 60; i++) {
        const up = await new Promise((r) => {
            const s = net.connect(port, "127.0.0.1");
            s.once("connect", () => { s.destroy(); r(true); });
            s.once("error", () => r(false));
        });
        if (up) break;
        await new Promise((r) => setTimeout(r, 500));
    }

    const ws = new WebSocket("ws://127.0.0.1:" + port + "/");
    let id = 1; const pend = {};
    const req = (route, data) => new Promise((res, rej) => {
        const i = id++; pend[i] = { res, rej };
        ws.send(JSON.stringify({ type: "request", method: "POST", route, id: i, data }));
    });
    const onDisk = () => JSON.parse(fs.readFileSync(CFG, "utf8"));

    let pass = 0, fail = 0, started = false;
    const check = (n, c, x) => { c ? (pass++, console.log("PASS  " + n)) : (fail++, console.log("FAIL  " + n + (x ? "  " + x : ""))); };

    ws.on("message", (raw) => {
        const t = raw.toString(); if (t === "pong") return;
        let m; try { m = JSON.parse(t); } catch (e) { return; }
        if (m.type === "authseed") {
            ws.send(JSON.stringify({ type: "auth", user: "admin", password: sha256(sha256("admin") + m.seed) }));
        }
        if (m.type === "auth" && !started) { started = true; run(); }
        if (m.type === "response") {
            const p = pend[m.id];
            if (p) { delete pend[m.id]; (m.status === 200 || m.message === 200) ? p.res(m) : p.rej(m); }
        }
    });

    async function run() {
        try {
            // Valid early field, invalid late field. Nothing may be applied.
            let rejected = false;
            try { await req("setupConfig", { registry: { ip: "10.9.9.9", port: 8080 }, firstDynamicNumber: 0 }); }
            catch (e) { rejected = true; }
            check("a request with a late invalid field is rejected", rejected);

            // An unrelated valid save. This is what used to persist the
            // supposedly-rejected change.
            await req("setupConfig", { debugLogs: true });
            const after = onDisk();
            check("the unrelated save succeeded", after.debugLogs === true);
            check("the rejected registry change did not reach disk",
                after.staticNmosRegistries[0].ip === "10.1.1.1" && after.staticNmosRegistries[0].port === 80,
                JSON.stringify(after.staticNmosRegistries[0]));

            // A valid change must still work.
            await req("setupConfig", { registry: { ip: "10.2.2.2", port: 81 } });
            const good = onDisk();
            check("a valid registry change still applies",
                good.staticNmosRegistries[0].ip === "10.2.2.2" && good.staticNmosRegistries[0].port === 81,
                JSON.stringify(good.staticNmosRegistries[0]));

            // A later-field rejection must not apply an earlier TOGGLE either.
            let rejected2 = false;
            try { await req("setupConfig", { bcp008: { enabled: false }, predictiveStaging: { cooldownMs: -5 } }); }
            catch (e) { rejected2 = true; }
            check("a rejected request leaves earlier toggles alone", rejected2);
            await req("setupConfig", { debugLogs: false });
            check("the rejected bcp008 toggle did not reach disk",
                onDisk().bcp008.enabled === true, JSON.stringify(onDisk().bcp008));
        } catch (e) {
            console.log("UNEXPECTED: " + (e && e.message ? e.message : JSON.stringify(e)));
            fail++;
        }
        console.log("\n" + pass + " passed, " + fail + " failed");
        stop();
        process.exit(fail ? 1 : 0);
    }

    setTimeout(() => { console.log("timeout"); stop(); process.exit(1); }, 45000);
})();
