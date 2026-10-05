/*
 * Worker alias-state round trip.
 *
 * Regression test for the alias migration, which was written against the
 * BROWSER Worker API — addEventListener('message', e => JSON.parse(e.data)).
 * `this.worker` is a Node worker_threads Worker, which uses on/off and hands
 * the posted value straight to the handler, so that call threw and the
 * migration never ran once.
 *
 * This pins both halves of the contract: the listener API, and the fact that
 * the worker replies with a JSON *string*.
 *
 *   npm --prefix server run build && node test/unit/worker-alias-state.test.js
 */
const fs = require("fs"), os = require("os"), path = require("path");
const { Worker } = require("worker_threads");

const WORKER = path.join(__dirname, "..", "..", "server", "dist", "lib", "crosspointUpdateThread.js");
if (!fs.existsSync(WORKER)) {
    console.error("build the server first: npm --prefix server run build");
    process.exit(2);
}

// The worker reads ./config and ./state relative to cwd.
const repo = path.join(__dirname, "..", "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-alias-"));
fs.mkdirSync(path.join(dir, "state"));
fs.mkdirSync(path.join(dir, "config"));
fs.copyFileSync(path.join(repo, "server", "config.default", "settings.json"),
                path.join(dir, "config", "settings.json"));
process.chdir(dir);

let pass = 0, fail = 0;
const check = (n, c, x) => { c ? (pass++, console.log("PASS  " + n)) : (fail++, console.log("FAIL  " + n + (x ? "  " + x : ""))); };

const worker = new Worker(WORKER);
const requestId = "test" + Math.random().toString(36).substring(7);
let answered = false;

const timer = setTimeout(() => {
    check("worker answers requestAliasState within 5s", false, "timed out");
    finish();
}, 5000);

// Node's API: .on(), and the handler receives the posted value itself.
const handler = (message) => {
    // The main thread relies on this being a string it can JSON.parse.
    if (typeof message !== "string") return;
    let data;
    try { data = JSON.parse(message); } catch (e) { return; }
    if (!data.aliasStateResponse || data.requestId !== requestId) return;

    answered = true;
    check("worker replies with a JSON string, not an event object", true);
    check("reply echoes the requestId", data.requestId === requestId);
    check("reply carries an aliasState object",
        data.aliasState !== null && typeof data.aliasState === "object",
        "got " + typeof data.aliasState);

    // off() must exist too — the real code removes the listener on both the
    // success and the timeout path.
    check("worker supports off() for listener removal", typeof worker.off === "function");
    worker.off("message", handler);
    clearTimeout(timer);
    finish();
};

check("worker supports on() rather than addEventListener",
    typeof worker.on === "function" && typeof worker.addEventListener !== "function");

worker.on("message", handler);
worker.postMessage(JSON.stringify({ requestAliasState: { requestId } }));

function finish() {
    worker.terminate().then(() => {
        console.log(`\n${pass} passed, ${fail} failed`);
        process.exit(fail ? 1 : 0);
    });
}
