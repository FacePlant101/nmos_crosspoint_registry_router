/*
 * Adopted leases must never reuse the primary as the secondary.
 *
 * adoptLease used to fall back to `secondary = primaryIp` when it could not
 * derive one — which happened for any EVEN adopted address, a very common
 * case. getDesiredAddresses then reported the same address for both legs, and
 * the reconcile put leg 2 of a 2022-7 sender onto leg 1's group, collapsing
 * the path redundancy the pairing exists to provide. This is reached by the
 * "Keep current addresses" option, the one recommended for live networks.
 *
 *   npm --prefix server run build && node test/unit/lease-adopt-secondary.test.js
 */
const fs = require("fs"), os = require("os"), path = require("path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adopt-sec-"));
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
    multicastRanges: { video: { primary: "239.120.0.0/24" } },
};

let pass = 0, fail = 0;
const check = (n, c, x) => { c ? (pass++, console.log("PASS  " + n)) : (fail++, console.log("FAIL  " + n + (x ? "  " + x : ""))); };
const V = "urn:x-nmos:format:video";
const args = (id, primary, secondary) => ({
    senderId: id, mediaType: "video/raw", format: V, channels: 0,
    width: 1920, height: 1080, primaryIp: primary, secondaryIp: secondary,
});

// Each manager must start from nothing: they share a cwd, and the state file
// would otherwise carry one case's claims into the next.
function fresh() {
    try { fs.unlinkSync(path.join("state", "multicastLeases.json")); } catch (e) {}
    return new MulticastLeaseManager(settings);
}

// --- the reported case: an EVEN adopted address with no secondary
let m = fresh();
let l = m.adoptLease(args("even", "239.100.0.10"));
check("an even adopted address still yields a lease", !!l, JSON.stringify(l));
check("the secondary is never a copy of the primary",
    l && l.secondaryIp !== l.primaryIp, JSON.stringify(l));
check("both legs do not resolve to one group",
    m.getEffectiveIp("even", 0) !== m.getEffectiveIp("even", 1),
    m.getEffectiveIp("even", 0) + " vs " + m.getEffectiveIp("even", 1));

// --- odd adopted address keeps the ST 2022-7 partner
m = fresh();
l = m.adoptLease(args("odd", "239.100.0.11"));
check("an odd adopted address pairs with primary + 1",
    l && l.secondaryIp === "239.100.0.12", JSON.stringify(l));

// --- an explicit secondary is always honoured
m = fresh();
l = m.adoptLease(args("both", "239.100.0.20", "239.100.0.21"));
check("an explicitly supplied secondary is kept",
    l && l.primaryIp === "239.100.0.20" && l.secondaryIp === "239.100.0.21", JSON.stringify(l));

// --- if the partner address is already claimed, leave leg 2 unmanaged rather
// than stealing it or duplicating the primary
m = fresh();
m.adoptLease(args("holder", "239.100.0.31", "239.100.0.32"));
l = m.adoptLease(args("wants31", "239.100.0.31"));
check("adopting an address another lease holds is refused", l === null, JSON.stringify(l));
l = m.adoptLease(args("partnerTaken", "239.100.0.30"));
check("a taken partner leaves leg 2 unmanaged, not duplicated",
    l && l.secondaryIp === "" && l.primaryIp === "239.100.0.30", JSON.stringify(l));

// --- an address live on the wire must not be taken as the partner
m = fresh();
m.setExternalIpsProvider(() => new Set(["239.100.0.41"]));
l = m.adoptLease(args("wireBusy", "239.100.0.40"));
check("a partner already on the wire is not claimed",
    l && l.secondaryIp === "", JSON.stringify(l));

// --- an unmanaged leg 2 must read as "no desire", so the reconcile skips it
m = fresh();
m.adoptLease(args("unmanaged", "239.100.0.50"));
// 239.100.0.51 is free here, so force the unmanaged case via a claimed partner
m = fresh();
m.adoptLease(args("holder2", "239.100.0.61", "239.100.0.62"));
m.adoptLease(args("solo", "239.100.0.60"));
const desired = m.getDesiredAddresses("solo");
check("an unmanaged leg 2 reports no desired address",
    desired && desired.primaryIp === "239.100.0.60" && !desired.secondaryIp, JSON.stringify(desired));

// --- the lease must survive a reload, empty secondary and all
m = fresh();
m.adoptLease(args("holder3", "239.100.0.71", "239.100.0.72"));
m.adoptLease(args("persist", "239.100.0.70"));
// Reload WITHOUT wiping, so this reads back what was just persisted.
const reloaded = new MulticastLeaseManager(settings);
const back = reloaded.getLease("persist");
check("a lease with an unmanaged leg 2 survives a reload",
    !!back && back.primaryIp === "239.100.0.70" && back.secondaryIp === "", JSON.stringify(back));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
