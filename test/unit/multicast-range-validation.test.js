/*
 * Multicast range validation.
 *
 * The validator matched on shape only, so "2399.120.0.0/16" and
 * "239.1.1.1/99" were accepted, and the lease manager's address parser
 * answered 0 for anything it could not read. A typo therefore became a pool
 * at 0.0.0.0 whose addresses were PATCHed onto real devices as multicast
 * destinations.
 *
 *   npm --prefix server run build && node test/unit/multicast-range-validation.test.js
 */
const fs = require("fs"), os = require("os"), path = require("path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "range-valid-"));
process.chdir(dir);
fs.mkdirSync("state");

const base = path.join(__dirname, "..", "..", "server", "dist", "lib");
if (!fs.existsSync(path.join(base, "parseSettings.js"))) {
    console.error("build the server first: npm --prefix server run build");
    process.exit(2);
}
const { parseSettings } = require(path.join(base, "parseSettings.js"));
const { MulticastLeaseManager } = require(path.join(base, "multicastLeaseManager.js"));

let pass = 0, fail = 0;
const check = (n, c, x) => { c ? (pass++, console.log("PASS  " + n)) : (fail++, console.log("FAIL  " + n + (x ? "  " + x : ""))); };

// Silence the intentional warnings while exercising the bad values.
const realWarn = console.warn;
const warnings = [];
console.warn = (...a) => warnings.push(a.join(" "));

const normalise = (primary) => {
    const s = parseSettings({ multicastRanges: { video: { primary } } });
    return s.multicastRanges.video.primary;
};

// --- good values survive untouched
for (const good of ["239.120.0.0/16", "224.0.0.0/4", "239.255.255.0/24", "232.0.0.0/8"]) {
    check("accepts " + good, normalise(good) === good, "became " + normalise(good));
}

// --- bad values are replaced by the default rather than used
const DEFAULT_VIDEO = "239.120.0.0/16";
for (const [bad, why] of [
    // Three digits matched the old shape-only regex, so this one really was
    // accepted; a four-digit octet never matched \d{1,3} and was already
    // rejected, which is why it is not the interesting case.
    ["999.120.0.0/16",  "octet over 255"],
    ["2399.120.0.0/16", "four-digit octet"],
    ["239.1.1.1/99",    "prefix over 32"],
    ["239.1.1.1/2",     "prefix too short to be meaningful"],
    ["10.0.0.0/16",     "not multicast"],
    ["192.168.1.0/24",  "not multicast"],
    ["239.120.0.0",     "no prefix"],
    ["garbage",         "not an address"],
    ["",                "empty"],
]) {
    check("rejects " + JSON.stringify(bad) + " (" + why + ")",
        normalise(bad) === DEFAULT_VIDEO, "became " + normalise(bad));
}
check("each rejection is reported to the operator", warnings.length >= 6, warnings.length + " warnings");
console.warn = realWarn;

// --- and the allocator must fail CLOSED on a range it cannot parse, rather
// than treating it as 0.0.0.0 and handing those addresses to devices
const m = new MulticastLeaseManager({
    autoMulticast: { enabled: true },
    // Bypass parseSettings deliberately: this is the belt-and-braces layer.
    multicastRanges: { video: { primary: "999.120.0.0/16" } },
});
const lease = m.ensureLease({
    senderId: "s1", mediaType: "video/raw", format: "urn:x-nmos:format:video",
    channels: 0, width: 1920, height: 1080, isActive: true,
});
check("an unparseable range yields no lease at all", lease === null, JSON.stringify(lease));
check("it never allocates from 0.0.0.0",
    !lease || !String(lease.primaryIp).startsWith("0."), JSON.stringify(lease));
check("capacity for that category reads zero",
    m.getStats().video.total === 0, JSON.stringify(m.getStats().video));

// --- a good range still allocates
const m2 = new MulticastLeaseManager({
    autoMulticast: { enabled: true },
    multicastRanges: { video: { primary: "239.120.0.0/24" } },
});
const ok = m2.ensureLease({
    senderId: "s2", mediaType: "video/raw", format: "urn:x-nmos:format:video",
    channels: 0, width: 1920, height: 1080, isActive: true,
});
check("a valid range still allocates normally",
    !!ok && ok.primaryIp.startsWith("239.120."), JSON.stringify(ok));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
