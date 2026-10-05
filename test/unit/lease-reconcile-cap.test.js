/*
 * Lease reconcile back-off.
 *
 * A device can refuse to converge for reasons the controller cannot fix: it
 * rejects the IS-05 patch, or accepts it and keeps reporting a different
 * destination_ip. Without a limit the 30s sweep re-patches such a sender
 * forever, and every apparent success also re-executes all its receivers.
 *
 * Drives the REAL compiled reconcileSenderWithLease against a stub `this`,
 * so the attempt accounting under test is the shipped code.
 *
 *   npm --prefix server run build && node test/unit/lease-reconcile-cap.test.js
 */
const fs = require("fs"), os = require("os"), path = require("path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-cap-"));
process.chdir(dir);
fs.mkdirSync("state");

const base = path.join(__dirname, "..", "..", "server", "dist", "lib");
for (const f of ["nmosConnector.js", "multicastLeaseManager.js"]) {
    if (!fs.existsSync(path.join(base, f))) {
        console.error("build the server first: npm --prefix server run build");
        process.exit(2);
    }
}
const { NmosRegistryConnector } = require(path.join(base, "nmosConnector.js"));
const { MulticastLeaseManager } = require(path.join(base, "multicastLeaseManager.js"));

let pass = 0, fail = 0;
const check = (n, c, x) => { c ? (pass++, console.log("PASS  " + n)) : (fail++, console.log("FAIL  " + n + (x ? "  " + x : ""))); };

const SENDER = "11111111-2222-3333-4444-555555555555";
const settings = {
    autoMulticast: { enabled: true },
    multicastRanges: { video: { primary: "239.120.0.0/24" } },
};
const manager = new MulticastLeaseManager(settings);

// A sender that NEVER takes the address: destination_ip stays 10.0.0.1 no
// matter how many patches it is sent.
function makeCtx() {
    let patches = 0;
    const proto = NmosRegistryConnector.prototype;
    const ctx = {
        nmosState: {
            senders:  { [SENDER]: { transport: "urn:x-nmos:transport:rtp.mcast", flow_id: "f1", device_id: "d1", subscription: { active: true } } },
            flows:    { f1: { media_type: "video/raw", format: "urn:x-nmos:format:video", source_id: "s1", frame_width: 1920, frame_height: 1080 } },
            sources:  { s1: { channels: [] } },
            devices:  { d1: { label: "Stubborn Device", node_id: "n1" } },
            senderActiveData: { [SENDER]: { transport_params: [{ destination_ip: "10.0.0.1" }, { destination_ip: "10.0.0.2" }] } },
        },
        leaseApplyState: {},
        stripSdpAddress: proto.stripSdpAddress,
        leaseArgsFor: proto.leaseArgsFor,
        reconnectOnChanges: () => {},
        // Pretend the patch is accepted but the device never changes.
        setFlowMulticast: () => { patches++; return Promise.resolve(); },
    };
    return {
        ctx,
        reconcile: () => proto.reconcileSenderWithLease.call(ctx, SENDER),
        patches: () => patches,
    };
}

const t = makeCtx();
// 50 sweeps against a device that never converges.
for (let i = 0; i < 50; i++) t.reconcile();
const capped = t.patches();
check("a non-converging sender is not patched on every sweep", capped < 50, "patched " + capped + " of 50 sweeps");
check("it stops within a small, bounded number of attempts", capped > 0 && capped <= 5, "patched " + capped + " times");

// The back-off must be a pause, not a permanent stop: rewind the clock.
const st = t.ctx.leaseApplyState[SENDER];
check("back-off state records a future retry time", !!st && st.nextAttemptAt > Date.now());
st.nextAttemptAt = Date.now() - 1;
t.reconcile();
check("it retries once the cooldown expires", t.patches() === capped + 1,
    "patched " + t.patches() + ", expected " + (capped + 1));

// A new target (manual override, release, re-allocation) is a new intent and
// must not inherit the exhausted budget.
const t2 = makeCtx();
for (let i = 0; i < 50; i++) t2.reconcile();
const before = t2.patches();
manager.recordManualEdit(SENDER, 0, "239.120.0.77");
t2.reconcile();
check("a changed target resets the budget immediately", t2.patches() === before + 1,
    "patched " + t2.patches() + ", expected " + (before + 1));

// Converging must clear the state so a later change starts clean.
const t3 = makeCtx();
t3.reconcile();
const want = manager.getDesiredAddresses(SENDER);
t3.ctx.nmosState.senderActiveData[SENDER].transport_params =
    [{ destination_ip: want.primaryIp }, { destination_ip: want.secondaryIp }];
t3.reconcile();
check("converging clears the back-off state", !t3.ctx.leaseApplyState[SENDER]);

// Senders that disappear must not leak back-off entries.
const t4 = makeCtx();
t4.reconcile();
check("state exists while the sender does", !!t4.ctx.leaseApplyState[SENDER]);
delete t4.ctx.nmosState.senders[SENDER];
NmosRegistryConnector.prototype.sweepLeases.call(t4.ctx);
check("sweep prunes state for a sender that is gone", !t4.ctx.leaseApplyState[SENDER]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
