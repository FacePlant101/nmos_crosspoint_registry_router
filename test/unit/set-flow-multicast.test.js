/*
 * setFlowMulticast patch shape.
 *
 * Two IS-05 rules this used to break:
 *   - transport_params must match the sender's leg count. It always sent two
 *     entries, so a single-leg (non-2022-7) sender got a two-element patch
 *     that a conforming device rejects.
 *   - "auto" means "device picks its own address", not "leave alone". Legs we
 *     were not changing were sent as "auto", so changing leg 0 of a 2022-7
 *     sender told the device to reassign leg 1 too.
 *
 * Captures the patch by stubbing the HTTP layer, so what is asserted is the
 * body the real compiled method would put on the wire.
 *
 *   npm --prefix server run build && node test/unit/set-flow-multicast.test.js
 */
const fs = require("fs"), os = require("os"), path = require("path");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "setflow-"));
process.chdir(dir);
fs.mkdirSync("state");

const base = path.join(__dirname, "..", "..", "server", "dist", "lib");
if (!fs.existsSync(path.join(base, "nmosConnector.js"))) {
    console.error("build the server first: npm --prefix server run build");
    process.exit(2);
}
// Intercept axios before the connector binds it. Resolve the module exactly
// as the connector would, so the stub lands on the same instance rather than
// a second copy that the connector never sees.
const axiosPath = require.resolve("axios", { paths: [base] });
const axiosMod = require(axiosPath);
const axios = axiosMod.default || axiosMod;
let captured = [];
axios.patch = (href, body) => { captured.push({ href, body }); return Promise.resolve({ data: {} }); };
if (axiosMod.default && axiosMod.default !== axiosMod) { axiosMod.patch = axios.patch; }

const { NmosRegistryConnector } = require(path.join(base, "nmosConnector.js"));
const proto = NmosRegistryConnector.prototype;

let pass = 0, fail = 0;
const check = (n, c, x) => { c ? (pass++, console.log("PASS  " + n)) : (fail++, console.log("FAIL  " + n + (x ? "  " + x : ""))); };

const SENDER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
function ctxWith(activeParams) {
    return {
        nmosState: {
            senders: { [SENDER]: { transport: "urn:x-nmos:transport:rtp.mcast", device_id: "d1" } },
            devices: { d1: { controls: [{ type: "urn:x-nmos:control:sr-ctrl/v1.1", href: "http://dev/x-nmos/connection/v1.1" }] } },
            senderActiveData: activeParams ? { [SENDER]: { transport_params: activeParams } } : {},
        },
        stripSdpAddress: proto.stripSdpAddress,
        getSenderActive: () => {},
        getSenderManifestData: () => {},
    };
}
async function run(activeParams, legs) {
    captured = [];
    await proto.setFlowMulticast.call(ctxWith(activeParams), SENDER, { legs });
    return captured[0] ? captured[0].body.transport_params : null;
}

(async () => {
    // --- single-leg sender must get a one-element patch
    let tp = await run([{ destination_ip: "239.1.0.1" }], [{ index: 0, multicast: "239.9.0.1" }]);
    check("single-leg sender gets exactly one transport_param",
        tp && tp.length === 1, JSON.stringify(tp));
    check("the single leg carries the requested address",
        tp && tp[0].destination_ip === "239.9.0.1", JSON.stringify(tp));

    // --- 2022-7 sender, both legs changed
    tp = await run([{ destination_ip: "239.1.0.1" }, { destination_ip: "239.1.0.2" }],
                   [{ index: 0, multicast: "239.9.0.1" }, { index: 1, multicast: "239.9.0.2" }]);
    check("dual-leg sender gets two transport_params", tp && tp.length === 2, JSON.stringify(tp));
    check("both legs carry their requested addresses",
        tp && tp[0].destination_ip === "239.9.0.1" && tp[1].destination_ip === "239.9.0.2", JSON.stringify(tp));

    // --- the important one: changing ONE leg must not disturb the other
    tp = await run([{ destination_ip: "239.1.0.1" }, { destination_ip: "239.1.0.2" }],
                   [{ index: 0, multicast: "239.9.0.1" }]);
    check("changing leg 0 still sends two params", tp && tp.length === 2, JSON.stringify(tp));
    check("the untouched leg keeps its current address, not \"auto\"",
        tp && tp[1].destination_ip === "239.1.0.2", JSON.stringify(tp));

    // --- changing only leg 1
    tp = await run([{ destination_ip: "239.1.0.1" }, { destination_ip: "239.1.0.2" }],
                   [{ index: 1, multicast: "239.9.0.9" }]);
    check("changing leg 1 preserves leg 0",
        tp && tp.length === 2 && tp[0].destination_ip === "239.1.0.1" && tp[1].destination_ip === "239.9.0.9",
        JSON.stringify(tp));

    // --- unknown active data: fall back to what we were asked for
    tp = await run(null, [{ index: 0, multicast: "239.9.0.1" }]);
    check("with no active data, sizes from the requested legs",
        tp && tp.length === 1 && tp[0].destination_ip === "239.9.0.1", JSON.stringify(tp));

    // --- a device still reporting "auto" must not be echoed as a real address
    tp = await run([{ destination_ip: "auto" }, { destination_ip: "auto" }],
                   [{ index: 0, multicast: "239.9.0.1" }]);
    check("an untouched leg that is genuinely auto stays auto",
        tp && tp[1].destination_ip === "auto", JSON.stringify(tp));

    // --- no legs at all must send nothing, not an all-auto reassignment
    captured = [];
    await proto.setFlowMulticast.call(ctxWith([{ destination_ip: "239.1.0.1" }]), SENDER, { legs: [] });
    check("an empty leg list sends no patch at all", captured.length === 0, JSON.stringify(captured));

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
