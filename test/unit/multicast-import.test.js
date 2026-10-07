/*
 * Lease import validation.
 *
 * importLeases REPLACES the inventory, and whatever it accepts is what the
 * reconcile will then try to put on real devices. It must therefore hold to
 * the same bar as load(): a lease is only usable if both addresses parse.
 * A type check alone let "" and "239.120.0" through, and the reconcile would
 * keep patching a value the device can never report back.
 *
 *   npm --prefix server run build && node test/unit/multicast-import.test.js
 */
const fs = require("fs"), os = require("os"), path = require("path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-import-"));
process.chdir(dir);
fs.mkdirSync("state");

const MANAGER = path.join(__dirname, "..", "..", "server", "dist", "lib", "multicastLeaseManager.js");
if (!fs.existsSync(MANAGER)) {
    console.error("build the server first: npm --prefix server run build");
    process.exit(2);
}
const { MulticastLeaseManager } = require(MANAGER);
const settings = {
    autoMulticast: { enabled: true },
    multicastRanges: { video: { primary: "239.120.0.0/24" }, audio: { primary: "239.130.0.0/24" } },
};

let pass = 0, fail = 0;
const check = (n, c, x) => { c ? (pass++, console.log("PASS  " + n)) : (fail++, console.log("FAIL  " + n + (x ? "  " + x : ""))); };

const lease = (primary, secondary, category) => ({
    createdAt: "2026-01-01T00:00:00.000Z", deviceLabel: "D", nodeId: "n",
    category: category || "video", channels: 0, port: 5004,
    primaryIp: primary, secondaryIp: secondary,
});

const m = new MulticastLeaseManager(settings);

// --- a good file imports
let r = m.importLeases({ leases: { a: lease("239.120.0.1", "239.120.0.2") } });
check("a valid lease imports", r.imported === 1 && r.dropped === 0, JSON.stringify(r));

// --- each malformed address shape is rejected, mixed with one good lease so
// the import itself still commits
for (const [name, bad] of [
    ["empty string",      ""],
    ["truncated address", "239.120.0"],
    ["octet over 255",    "999.120.0.5"],
    ["not an address",    "garbage"],
]) {
    const res = m.importLeases({
        leases: { good: lease("239.120.0.1", "239.120.0.2"), bad: lease(bad, "239.120.0.4") },
    });
    check("rejects a primaryIp that is " + name,
        res.imported === 1 && res.dropped === 1 && !m.getLease("bad"), JSON.stringify(res));
}
// A MALFORMED secondary is still rejected...
const res2 = m.importLeases({
    leases: { good: lease("239.120.0.1", "239.120.0.2"), bad: lease("239.120.0.3", "239.120.0") },
});
check("rejects a malformed secondaryIp",
    res2.imported === 1 && res2.dropped === 1 && !m.getLease("bad"), JSON.stringify(res2));

// ...but an ABSENT one is legitimate: it means leg 2 carries no reservation,
// which the reconcile reads as "leave that leg alone". The alternative the
// code used to take — copying the primary — put both 2022-7 legs on one group.
const res3 = m.importLeases({
    leases: { solo: lease("239.120.0.5", "") },
});
check("accepts an absent secondaryIp as an unmanaged leg 2",
    res3.imported === 1 && res3.dropped === 0, JSON.stringify(res3));
check("an absent secondary is never backfilled with the primary",
    m.getLease("solo") && m.getLease("solo").secondaryIp !== m.getLease("solo").primaryIp,
    JSON.stringify(m.getLease("solo")));

// --- nothing invalid can reach the reconcile
m.importLeases({ leases: { good: lease("239.120.0.1", "239.120.0.2"), bad: lease("", "") } });
const everyAddress = Object.values(m.getAllLeases()).flatMap((l) => [l.primaryIp, l.secondaryIp]);
check("no imported lease carries an unusable address",
    everyAddress.length > 0 && everyAddress.every((ip) => /^\d+\.\d+\.\d+\.\d+$/.test(ip)),
    JSON.stringify(everyAddress));

// --- a file whose leases are ALL invalid must not wipe the inventory, since
// an import replaces it and every sender would be re-addressed on next sweep
m.importLeases({ leases: { keep: lease("239.120.0.9", "239.120.0.10") } });
const before = Object.keys(m.getAllLeases()).length;
let threw = false;
try { m.importLeases({ leases: { x: lease("", ""), y: lease("nope", "nope") } }); }
catch (e) { threw = true; }
check("an all-invalid file is refused rather than committed", threw);
check("the existing inventory survives a refused import",
    Object.keys(m.getAllLeases()).length === before, "had " + before + ", now " + Object.keys(m.getAllLeases()).length);

// --- but a deliberately empty file still clears
const cleared = m.importLeases({ leases: {} });
check("an empty file still clears the inventory",
    cleared.imported === 0 && Object.keys(m.getAllLeases()).length === 0);

// --- a malformed payload is still rejected outright
let threw2 = false;
try { m.importLeases({ nope: true }); } catch (e) { threw2 = true; }
check("a payload with no leases object is rejected", threw2);

// --- an export must survive a round trip
const m2 = new MulticastLeaseManager(settings);
m2.importLeases({ leases: { a: lease("239.120.0.1", "239.120.0.2"), b: lease("239.130.0.1", "239.130.0.2", "audio") } });
const round = m2.importLeases(m2.exportLeases());
check("export output re-imports cleanly", round.imported === 2 && round.dropped === 0, JSON.stringify(round));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
