/*
 * Multicast lease allocator — regression tests.
 *
 * Exercises the REAL compiled MulticastLeaseManager against a temp state
 * directory, so these test the shipped code rather than a copy of it.
 *
 *   npm --prefix server run build && node test/unit/multicast-lease.test.js
 */
const fs = require("fs"), os = require("os"), path = require("path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lease-test-"));
process.chdir(dir);
fs.mkdirSync("state");

const MANAGER = path.join(__dirname, "..", "..", "server", "dist", "lib", "multicastLeaseManager.js");
if (!fs.existsSync(MANAGER)) {
    console.error("build the server first: npm --prefix server run build");
    process.exit(2);
}
const { MulticastLeaseManager } = require(MANAGER);

// /24 ranges keep the arithmetic checkable by hand.
const settings = {
    autoMulticast: { enabled: true },
    multicastRanges: {
        video:    { primary: "239.120.0.0/24" },
        videoUhd: { primary: "239.121.0.0/24" },
        jxsv:     { primary: "239.122.0.0/24" },
        audio:    { primary: "239.130.0.0/24" },
        other:    { primary: "239.140.0.0/24" },
    },
};

let pass = 0, fail = 0;
const check = (name, cond, extra) => {
    if (cond) { pass++; console.log("PASS  " + name); }
    else { fail++; console.log("FAIL  " + name + (extra ? "  " + extra : "")); }
};
const V = "urn:x-nmos:format:video", A = "urn:x-nmos:format:audio", D = "urn:x-nmos:format:data";
const toInt = (ip) => ip.split(".").reduce((a, b) => (a << 8) + (+b), 0) >>> 0;

const m = new MulticastLeaseManager(settings);

// --- the category decides which configured range is used
for (const [id, args, cat, prefix] of [
    ["hd",   { mediaType: "video/raw",      format: V, width: 1920, height: 1080 }, "video",    "239.120."],
    ["uhd",  { mediaType: "video/raw",      format: V, width: 3840, height: 2160 }, "videoUhd", "239.121."],
    ["jxs",  { mediaType: "video/jxsv",     format: V, width: 1920, height: 1080 }, "jxsv",     "239.122."],
    ["aud",  { mediaType: "audio/L24",      format: A, channels: 8 },               "audio",    "239.130."],
    // ANC is media_type video/smpte291 but format :data — it must not consume
    // video capacity. This is the case a real nmos-cpp node surfaced.
    ["anc",  { mediaType: "video/smpte291", format: D },                            "other",    "239.140."],
    ["anc2", { mediaType: "video/smpte291" },                                       "other",    "239.140."],
]) {
    const l = m.ensureLease({ senderId: id, channels: 0, isActive: true, ...args });
    check(`${id} -> ${cat} in ${prefix}x`,
        !!l && l.category === cat && l.primaryIp.startsWith(prefix),
        l ? `got ${l.category} ${l.primaryIp}` : "got null");
}

// --- ST 2022-7 needs the two legs adjacent, odd then even
const hd = m.getLease("hd");
check("legs are adjacent (odd, odd+1)",
    !!hd && toInt(hd.secondaryIp) === toInt(hd.primaryIp) + 1 && (toInt(hd.primaryIp) & 1) === 1,
    hd ? `${hd.primaryIp} / ${hd.secondaryIp}` : "");

// --- the global index must hold across different ranges
const seen = new Set(); let dup = false;
for (const id in m.getAllLeases()) {
    for (const ip of [m.getAllLeases()[id].primaryIp, m.getAllLeases()[id].secondaryIp]) {
        if (seen.has(ip)) dup = true;
        seen.add(ip);
    }
}
check("no address handed out twice", !dup);

check("ensureLease is idempotent",
    m.ensureLease({ senderId: "hd", mediaType: "video/raw", format: V, channels: 0, width: 1920, height: 1080, isActive: true })?.primaryIp === hd.primaryIp);

check("an inactive sender gets no lease",
    m.ensureLease({ senderId: "idle", mediaType: "video/raw", format: V, channels: 0, isActive: false }) === null);

// --- never hand out something already on the wire
m.setExternalIpsProvider(() => new Set(["239.130.0.3", "239.130.0.4"]));
const a2 = m.ensureLease({ senderId: "aud2", mediaType: "audio/L24", format: A, channels: 2, isActive: true });
check("avoids an address already in use on the network",
    !!a2 && !["239.130.0.3", "239.130.0.4"].includes(a2.primaryIp) && !["239.130.0.3", "239.130.0.4"].includes(a2.secondaryIp),
    a2 ? `${a2.primaryIp}/${a2.secondaryIp}` : "");

// --- manual override wins, and clearing restores the reservation
m.recordManualEdit("hd", 0, "239.120.0.200");
check("override wins over the reservation", m.getEffectiveIp("hd", 0) === "239.120.0.200");
check("the reserved address is still held", m.getReservedIp("hd", 0) === hd.primaryIp);
m.recordManualEdit("hd", 0, "");
check("clearing the override restores the reservation", m.getEffectiveIp("hd", 0) === hd.primaryIp);

// --- capacity is per range, not one shared pool
const st = m.getStats();
check("each category reports its own capacity",
    st.video.total === 128 && st.audio.total === 128 && st.pool.total === 640,
    JSON.stringify({ video: st.video, audio: st.audio, pool: st.pool }));

const before = m.getStats().pool.used;
m.releaseLeases(["hd"]);
check("release frees the lease", m.getStats().pool.used === before - 1);
check("a released address can be reused",
    !!m.ensureLease({ senderId: "reuse", mediaType: "video/raw", format: V, channels: 0, width: 1920, height: 1080, isActive: true }));

// --- exhaustion must terminate rather than spin. A /30 spans .0-.3, so it
// holds exactly ONE odd-aligned pair: (.1, .2). (.3 would need .4, out of range.)
const tiny = new MulticastLeaseManager({
    autoMulticast: { enabled: true },
    multicastRanges: { audio: { primary: "239.200.0.0/30" } },
});
let got = 0;
for (let i = 0; i < 10; i++) {
    if (tiny.ensureLease({ senderId: "s" + i, mediaType: "audio/L16", format: A, channels: 2, isActive: true })) got++;
}
check("pool exhaustion terminates and then refuses", got === 1,
    `a /30 holds one odd-aligned pair; allocated ${got} of 10 attempts`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
