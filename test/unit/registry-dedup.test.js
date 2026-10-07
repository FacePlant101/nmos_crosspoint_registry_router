/*
 * Registry deduplication.
 *
 * dnssdQuery falls back to the SRV target hostname when the A lookup fails,
 * because a name still works in a URL. addRegistry deduped on ip:port, so the
 * same registry appeared under its name on one pass and under its numeric
 * address on the next — two entries, two full sets of subscriptions, every
 * grain processed twice, and no path that removed either.
 *
 * Drives the real compiled addRegistry with a stub `this`.
 *
 *   npm --prefix server run build && node test/unit/registry-dedup.test.js
 */
const fs = require("fs"), os = require("os"), path = require("path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reg-dedup-"));
process.chdir(dir);
fs.mkdirSync("state");

const base = path.join(__dirname, "..", "..", "server", "dist", "lib");
if (!fs.existsSync(path.join(base, "nmosConnector.js"))) {
    console.error("build the server first: npm --prefix server run build");
    process.exit(2);
}
const { NmosRegistryConnector } = require(path.join(base, "nmosConnector.js"));
const proto = NmosRegistryConnector.prototype;

let pass = 0, fail = 0;
const check = (n, c, x) => { c ? (pass++, console.log("PASS  " + n)) : (fail++, console.log("FAIL  " + n + (x ? "  " + x : ""))); };

function ctx() {
    const c = {
        nmosRegistryList: [],
        connected: [],
        settings: {},
        connectRegistry(r) { this.connected.push(r.ip + ":" + r.port); },
        updateSyncConnectionState() {},
    };
    c.add = (r) => proto.addRegistry.call(c, r);
    return c;
}
const dnssd = (ip, port, target) => ({
    ip, port, priority: 100, source: "dnssd", domain: "media.example.net",
    discoveryKey: target + ":" + port,
});

// --- the reported sequence: name first (A lookup failed), address second
let c = ctx();
c.add(dnssd("registry.media.example.net", 8080, "registry.media.example.net"));
c.add(dnssd("10.0.0.5", 8080, "registry.media.example.net"));
check("one service instance yields one registry",
    c.nmosRegistryList.length === 1, JSON.stringify(c.nmosRegistryList.map(r => r.ip)));
check("it is connected to only once",
    c.connected.length === 1, JSON.stringify(c.connected));
check("the address we connected to is the one kept",
    c.nmosRegistryList[0].ip === "registry.media.example.net", c.nmosRegistryList[0].ip);

// --- and the reverse order, in case DNS is flaky the other way round
c = ctx();
c.add(dnssd("10.0.0.5", 8080, "registry.media.example.net"));
c.add(dnssd("registry.media.example.net", 8080, "registry.media.example.net"));
check("the reverse order also yields one registry",
    c.nmosRegistryList.length === 1 && c.connected.length === 1,
    JSON.stringify({ list: c.nmosRegistryList.length, connected: c.connected }));

// --- repeated identical passes must stay idempotent
c = ctx();
for (let i = 0; i < 5; i++) c.add(dnssd("10.0.0.5", 8080, "registry.media.example.net"));
check("repeated identical discoveries are idempotent",
    c.nmosRegistryList.length === 1 && c.connected.length === 1,
    JSON.stringify(c.connected));

// --- genuinely different registries must still both be added
c = ctx();
c.add(dnssd("10.0.0.5", 8080, "a.media.example.net"));
c.add(dnssd("10.0.0.6", 8080, "b.media.example.net"));
check("two different instances are both added",
    c.nmosRegistryList.length === 2 && c.connected.length === 2, JSON.stringify(c.connected));

// --- same host, different port is a different registry
c = ctx();
c.add(dnssd("10.0.0.5", 8080, "registry.media.example.net"));
c.add(dnssd("10.0.0.5", 8081, "registry.media.example.net"));
check("the same host on another port is a separate registry",
    c.nmosRegistryList.length === 2, JSON.stringify(c.connected));

// --- a static entry for the same endpoint must not be duplicated by discovery,
// and must keep its higher-ranked source
c = ctx();
c.add({ ip: "10.0.0.5", port: 8080, priority: 10, source: "static", domain: "" });
c.add(dnssd("10.0.0.5", 8080, "registry.media.example.net"));
check("discovery does not duplicate a static entry",
    c.nmosRegistryList.length === 1 && c.connected.length === 1, JSON.stringify(c.connected));
check("the static source outranks the discovery",
    c.nmosRegistryList[0].source === "static", c.nmosRegistryList[0].source);
check("the static entry adopts the instance identity",
    c.nmosRegistryList[0].discoveryKey === "registry.media.example.net:8080",
    String(c.nmosRegistryList[0].discoveryKey));
// ...so a later pass that falls back to the hostname still recognises it
c.add(dnssd("registry.media.example.net", 8080, "registry.media.example.net"));
check("a later hostname-only pass does not duplicate it",
    c.nmosRegistryList.length === 1, JSON.stringify(c.nmosRegistryList.map(r => r.ip)));

// --- a higher-ranked source must never silently change the live address
c = ctx();
c.add({ ip: "10.0.0.5", port: 8080, priority: 100, source: "mdns", domain: "" });
c.add(dnssd("10.0.0.5", 8080, "registry.media.example.net"));
check("relabelling keeps the address actually connected to",
    c.nmosRegistryList[0].ip === "10.0.0.5" && c.nmosRegistryList[0].source === "dnssd",
    JSON.stringify(c.nmosRegistryList[0]));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
