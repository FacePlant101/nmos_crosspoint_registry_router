/*
 * Migration from the pre-lease allocator's ./state/multicast.json.
 *
 * Those addresses are live on the network at upgrade time, so they must be
 * adopted rather than reallocated — a fresh allocation would repoint every
 * sender on first boot and black every receiver until it caught up.
 *
 *   npm --prefix server run build && node test/unit/multicast-migration.test.js
 */
const fs = require("fs"), os = require("os"), path = require("path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-migrate-"));
process.chdir(dir);
fs.mkdirSync("state");

// The old shape, including a non-adjacent pair (legs were drawn
// independently), a single-leg sender, a duplicate and malformed entries.
fs.writeFileSync("state/multicast.json", JSON.stringify({
    "nmos_aaaaaaaa-0000-0000-0000-000000000001": [{ index: 0, multicast: "239.120.7.33" }, { index: 1, multicast: "239.120.9.90" }],
    "nmos_aaaaaaaa-0000-0000-0000-000000000002": [{ index: 0, multicast: "239.130.1.4" }],
    "nmos_aaaaaaaa-0000-0000-0000-000000000003": [{ index: 0, multicast: "239.120.7.33" }],
    "nmos_aaaaaaaa-0000-0000-0000-000000000004": [{ index: 0, multicast: "not-an-ip" }],
    "nmos_aaaaaaaa-0000-0000-0000-000000000005": [],
}, null, 2));

const MANAGER = path.join(__dirname, "..", "..", "server", "dist", "lib", "multicastLeaseManager.js");
if (!fs.existsSync(MANAGER)) {
    console.error("build the server first: npm --prefix server run build");
    process.exit(2);
}
const { MulticastLeaseManager } = require(MANAGER);
const settings = {
    autoMulticast: { enabled: true },
    multicastRanges: { video: { primary: "239.120.0.0/16" }, audio: { primary: "239.130.0.0/16" } },
};

let pass = 0, fail = 0;
const check = (n, c, x) => { c ? (pass++, console.log("PASS  " + n)) : (fail++, console.log("FAIL  " + n + (x ? "  " + x : ""))); };

const m = new MulticastLeaseManager(settings);
const all = m.getAllLeases();

check("adopts the two-leg sender at its live addresses",
    all["aaaaaaaa-0000-0000-0000-000000000001"]?.primaryIp === "239.120.7.33" &&
    all["aaaaaaaa-0000-0000-0000-000000000001"]?.secondaryIp === "239.120.9.90");
check("adopts the single-leg sender", all["aaaaaaaa-0000-0000-0000-000000000002"]?.primaryIp === "239.130.1.4");
check("skips the duplicate",            !all["aaaaaaaa-0000-0000-0000-000000000003"]);
check("skips the malformed address",    !all["aaaaaaaa-0000-0000-0000-000000000004"]);
check("skips the empty entry",          !all["aaaaaaaa-0000-0000-0000-000000000005"]);
check("rekeys to bare IS-04 ids",       Object.keys(all).every((k) => !k.startsWith("nmos_")));
check("writes the new lease file",      fs.existsSync("state/multicastLeases.json"));
check("leaves the legacy file alone",   fs.existsSync("state/multicast.json"));

const m2 = new MulticastLeaseManager(settings);
check("a second start loads leases without re-migrating",
    Object.keys(m2.getAllLeases()).length === 2, "got " + Object.keys(m2.getAllLeases()).length);

const fresh = m2.ensureLease({
    senderId: "new", mediaType: "video/raw", format: "urn:x-nmos:format:video",
    channels: 0, width: 1920, height: 1080, isActive: true,
});
check("a new lease avoids the adopted addresses",
    fresh && !["239.120.7.33", "239.120.9.90"].includes(fresh.primaryIp)
          && !["239.120.7.33", "239.120.9.90"].includes(fresh.secondaryIp),
    fresh ? `${fresh.primaryIp}/${fresh.secondaryIp}` : "null");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
