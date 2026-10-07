/*
 * DDNS push against a real DNS server.
 *
 * The service hand-rolls RFC 2136 UPDATE messages and RFC 8945 TSIG signing
 * over raw TCP — no DNS library — so the only meaningful test is whether a
 * real server accepts the bytes and ends up with the right records.
 *
 * Brings up BIND9 in Docker with a TSIG-protected zone, pushes through the
 * real compiled DdnsService, and checks the zone with dig.
 *
 * Needs Docker. Skips (exit 0) if it is unavailable.
 *   npm --prefix server run build && node test/integration/ddns-push.test.js
 */
const fs = require("fs"), os = require("os"), path = require("path"), net = require("net");
const { execFileSync, spawnSync } = require("child_process");

const repo = path.join(__dirname, "..", "..");
const MANAGER = path.join(repo, "server", "dist", "lib", "ddnsService.js");
if (!fs.existsSync(MANAGER)) {
    console.error("build the server first: npm --prefix server run build");
    process.exit(2);
}
const have = (cmd, args) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
if (!have("docker", ["info"])) { console.log("SKIP  docker unavailable"); process.exit(0); }

const NAME = "ddns-test-bind";
const IMAGE = "ubuntu/bind9:latest";
const work = fs.mkdtempSync(path.join(os.tmpdir(), "ddns-bind-"));
const SECRET = require("crypto").randomBytes(32).toString("base64");
const ZONE = "media.example.net";
// A second zone on the same server, so moving the feature between zones can be
// tested end to end rather than asserted about in the abstract.
const ZONE2 = "av.example.net";

fs.writeFileSync(path.join(work, "named.conf"), `
options { directory "/var/cache/bind"; listen-on { any; }; allow-query { any; };
          recursion no; dnssec-validation no; };
key "crosspoint-key" { algorithm hmac-sha256; secret "${SECRET}"; };
zone "${ZONE}" { type master; file "/var/lib/bind/db.zone";
                 allow-update { key "crosspoint-key"; }; };
zone "${ZONE2}" { type master; file "/var/lib/bind/db.zone2";
                 allow-update { key "crosspoint-key"; }; };
`);
fs.writeFileSync(path.join(work, "db.zone"),
`$TTL 300
@   IN SOA ns.${ZONE}. admin.${ZONE}. ( 1 3600 600 86400 300 )
@   IN NS  ns.${ZONE}.
ns  IN A   127.0.0.1
`);
fs.writeFileSync(path.join(work, "db.zone2"),
`$TTL 300
@   IN SOA ns.${ZONE2}. admin.${ZONE2}. ( 1 3600 600 86400 300 )
@   IN NS  ns.${ZONE2}.
ns  IN A   127.0.0.1
`);
fs.chmodSync(work, 0o777);
fs.chmodSync(path.join(work, "db.zone"), 0o666);
fs.chmodSync(path.join(work, "db.zone2"), 0o666);

function findPort() {
    // A fixed high port keeps the dig invocations simple; bail if it is taken.
    return 5354;
}
const PORT = findPort();
const sh = (args, opts) => execFileSync("docker", args, { stdio: "pipe", ...opts }).toString();

let pass = 0, fail = 0;
const check = (n, c, x) => { c ? (pass++, console.log("PASS  " + n)) : (fail++, console.log("FAIL  " + n + (x ? "  " + x : ""))); };
const cleanup = () => { try { sh(["rm", "-f", NAME]); } catch (e) {} };
process.on("exit", cleanup);

(async () => {
    try { sh(["rm", "-f", NAME]); } catch (e) {}
    try { sh(["pull", "-q", IMAGE]); } catch (e) { console.log("SKIP  cannot pull " + IMAGE); process.exit(0); }
    try {
        sh(["run", "-d", "--name", NAME, "-p", `${PORT}:53/tcp`, "-p", `${PORT}:53/udp`,
            "-v", `${path.join(work, "named.conf")}:/etc/bind/named.conf:ro`,
            "-v", `${work}:/var/lib/bind`, IMAGE]);
    } catch (e) { console.log("SKIP  could not start BIND (port " + PORT + " busy?)"); process.exit(0); }

    // Wait for it to answer.
    let up = false;
    for (let i = 0; i < 40; i++) {
        up = await new Promise((r) => {
            const s = net.connect(PORT, "127.0.0.1");
            s.once("connect", () => { s.destroy(); r(true); });
            s.once("error", () => r(false));
        });
        if (up) break;
        await new Promise((r) => setTimeout(r, 500));
    }
    if (!up) { console.log("SKIP  BIND did not come up"); process.exit(0); }
    await new Promise((r) => setTimeout(r, 2000));

    const dig = (name, zone) => {
        try {
            return execFileSync("dig", ["@127.0.0.1", "-p", String(PORT), name + "." + (zone || ZONE), "A", "+short"],
                { stdio: "pipe" }).toString().trim();
        } catch (e) { return "<dig failed>"; }
    };

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ddns-run-"));
    process.chdir(dir); fs.mkdirSync("state");
    const { DdnsService } = require(MANAGER);
    const svc = new DdnsService();
    svc.setSettings({ enabled: true, server: "127.0.0.1", port: PORT, zone: ZONE, ttl: 300,
                      keyName: "crosspoint-key", keySecret: SECRET, keyAlgorithm: "hmac-sha256" });
    check("the service reports itself enabled", svc.isEnabled());

    await svc.syncAll([
        { nodeId: "n1", displayName: "Camera 1", ip: "10.20.0.11" },
        { nodeId: "n2", displayName: "Vision Mixer", ip: "10.20.0.12" },
    ]);
    await new Promise((r) => setTimeout(r, 1500));

    check("a TSIG-signed update is accepted and resolvable",
        dig("camera-1") === "10.20.0.11", dig("camera-1"));
    check("a name with a space becomes a valid label",
        dig("vision-mixer") === "10.20.0.12", dig("vision-mixer"));
    check("the inventory records both", svc.getPushedEntries().length === 2);

    // Re-pushing the same thing must be idempotent, not additive.
    await svc.syncAll([
        { nodeId: "n1", displayName: "Camera 1", ip: "10.20.0.11" },
        { nodeId: "n2", displayName: "Vision Mixer", ip: "10.20.0.12" },
    ]);
    await new Promise((r) => setTimeout(r, 1500));
    check("re-pushing is idempotent", svc.getPushedEntries().length === 2 && dig("camera-1") === "10.20.0.11");

    // An address change must replace, not append.
    await svc.syncAll([{ nodeId: "n1", displayName: "Camera 1", ip: "10.20.0.99" }]);
    await new Promise((r) => setTimeout(r, 1500));
    check("an address change replaces the record",
        dig("camera-1") === "10.20.0.99", dig("camera-1"));

    // A rename must move the record and clean up the old name.
    await svc.syncAll([{ nodeId: "n1", displayName: "Camera One", ip: "10.20.0.99" }]);
    await new Promise((r) => setTimeout(r, 1500));
    check("a rename publishes under the new name", dig("camera-one") === "10.20.0.99", dig("camera-one"));
    check("a rename removes the old name", dig("camera-1") === "", dig("camera-1"));

    // Removal must delete it.
    await svc.removeNode("n2");
    await new Promise((r) => setTimeout(r, 1500));
    check("removing a node deletes its record", dig("vision-mixer") === "", dig("vision-mixer"));
    check("the inventory shrinks with it", svc.getPushedEntries().length === 1);

    // A wrong secret must be refused by the server, not silently "succeed".
    const bad = new DdnsService();
    bad.setSettings({ enabled: true, server: "127.0.0.1", port: PORT, zone: ZONE, ttl: 300,
                      keyName: "crosspoint-key", keySecret: require("crypto").randomBytes(32).toString("base64"),
                      keyAlgorithm: "hmac-sha256" });
    await bad.syncAll([{ nodeId: "n9", displayName: "Impostor", ip: "10.20.0.66" }]);
    await new Promise((r) => setTimeout(r, 1500));
    check("a bad TSIG secret does not get a record in", dig("impostor") === "", dig("impostor"));

    // Two devices whose labels sanitise to the same label must not take turns
    // owning one record: the first claim wins and the second is refused.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), "ddns-collide-"));
    process.chdir(dir2); fs.mkdirSync("state");
    const collide = new DdnsService();
    collide.setSettings({ enabled: true, server: "127.0.0.1", port: PORT, zone: ZONE, ttl: 300,
                          keyName: "crosspoint-key", keySecret: SECRET, keyAlgorithm: "hmac-sha256" });
    await collide.syncAll([{ nodeId: "c1", displayName: "Shared Name", ip: "10.20.0.31" }]);
    await new Promise((r) => setTimeout(r, 1200));
    await collide.syncAll([{ nodeId: "c2", displayName: "Shared-Name", ip: "10.20.0.32" }]);
    await new Promise((r) => setTimeout(r, 1200));
    check("a colliding name does not hijack the first node's record",
        dig("shared-name") === "10.20.0.31", dig("shared-name"));
    check("the loser of a name collision is not in the inventory",
        collide.getPushedEntries().filter((e) => e.nodeId === "c2").length === 0);
    // ...and removing the loser must not delete the winner's record.
    await collide.removeNode("c2");
    await new Promise((r) => setTimeout(r, 1200));
    check("removing the loser leaves the winner's record alone",
        dig("shared-name") === "10.20.0.31", dig("shared-name"));
    process.chdir(dir);

    // A peer that accepts the connection and closes without answering must
    // fail the push, not hang it forever.
    const deaf = net.createServer((sock) => sock.end());
    await new Promise((r) => deaf.listen(0, "127.0.0.1", r));
    const deafPort = deaf.address().port;
    const hang = new DdnsService();
    hang.setSettings({ enabled: true, server: "127.0.0.1", port: deafPort, zone: ZONE, ttl: 300,
                       keyName: "crosspoint-key", keySecret: SECRET, keyAlgorithm: "hmac-sha256" });
    const t0 = Date.now();
    const settled = await Promise.race([
        hang.syncAll([{ nodeId: "h1", displayName: "Deaf Server", ip: "10.20.0.41" }]).then(() => true),
        new Promise((r) => setTimeout(() => r(false), 8000)),
    ]);
    deaf.close();
    check("a connection closed without a reply settles instead of hanging",
        settled === true, settled ? "" : "still pending after 8s");
    check("...and it does so without waiting out the inactivity timeout",
        settled === true && (Date.now() - t0) < 4000, String(Date.now() - t0) + "ms");
    check("nothing is recorded as published for it",
        hang.getPushedEntries().filter((e) => e.nodeId === "h1").length === 0);

    // Moving to another zone must publish there and clean up the old zone,
    // even though the host and address have not changed.
    svc.setSettings({ enabled: true, server: "127.0.0.1", port: PORT, zone: ZONE2, ttl: 300,
                      keyName: "crosspoint-key", keySecret: SECRET, keyAlgorithm: "hmac-sha256" });
    await svc.syncAll([{ nodeId: "n1", displayName: "Camera One", ip: "10.20.0.99" }]);
    await new Promise((r) => setTimeout(r, 1500));
    check("a zone change publishes into the new zone",
        dig("camera-one", ZONE2) === "10.20.0.99", dig("camera-one", ZONE2));
    check("a zone change withdraws the record from the old zone",
        dig("camera-one", ZONE) === "", dig("camera-one", ZONE));
    check("the inventory follows the node to the new zone",
        (svc.getPushedEntries().find((e) => e.nodeId === "n1") || {}).domain === ZONE2);

    console.log(`\n${pass} passed, ${fail} failed`);
    cleanup();
    process.exit(fail ? 1 : 0);
})();
