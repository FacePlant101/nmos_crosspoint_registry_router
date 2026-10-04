/*
 * Crosspoint flow addressing ("Dev.v2", "Dev.2", "nmos_<id>") — regression tests.
 *
 * Flow numbers are 1-based per device, direction and type. makeConnection used to
 * subtract 1 for every device that did not have exactly four video receivers, key
 * its flow map on "device:num" alone (so senders, receivers and types overwrote each
 * other), and fall back to *every* flow of the type when a lookup missed. Together
 * that routed the wrong encoder output, dropped ".v2" on ordinary decoders, and put
 * one source on all four quadrants of a multiviewer.
 *
 * Exercises the REAL compiled parser and lookup.
 *
 *   npm --prefix server run build && node test/unit/flow-addressing.test.js
 */
const fs = require("fs"), path = require("path");

const DIST = path.join(__dirname, "..", "..", "server", "dist", "lib");
if (!fs.existsSync(path.join(DIST, "flowAddress.js"))) {
    console.error("build the server first: npm --prefix server run build");
    process.exit(2);
}
const { parseFlowAddress } = require(path.join(DIST, "flowAddress.js"));
const { CrosspointOptimizedLookup } = require(path.join(DIST, "crosspointOptimizedLookup.js"));

let pass = 0, fail = 0;
const check = (n, c, x) => { c ? (pass++, console.log("PASS  " + n)) : (fail++, console.log("FAIL  " + n + (x ? "  " + x : ""))); };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// --- parser -------------------------------------------------------------------
const parses = [
    ["Dec",          { device: "Dec", type: null, num: null }],
    ["Dec.v2",       { device: "Dec", type: "video", num: 2 }],
    ["Dec.a1",       { device: "Dec", type: "audio", num: 1 }],
    ["Dec.d3",       { device: "Dec", type: "data", num: 3 }],
    ["Dec.v",        { device: "Dec", type: "video", num: null }],
    ["Dec.u3",       { device: "Dec", type: "other", num: 3 }],
    ["CIP-DEC-740.3",{ device: "CIP-DEC-740", type: "video", num: 3 }],
    ["12.v4",        { device: "12", type: "video", num: 4 }],
    ["Studio.Left",  { device: "Studio.Left", type: null, num: null }],
    ["Dec.vx",       { device: "Dec.vx", type: null, num: null }],
];
for (const [address, expected] of parses) {
    const got = parseFlowAddress(address);
    check(`parse "${address}"`, eq(got, expected), JSON.stringify(got));
}

// --- lookup -------------------------------------------------------------------
const flow = (id, type, num) => ({ id, name: id, num, type, order: -1, channelNumber: -1 });
const groups = () => ({ audio: [], audiochannel: [], video: [], data: [], websocket: [], mqtt: [], unknown: [] });
const device = (id, name, num, alias = "") => ({ id, name, alias, num, senders: groups(), receivers: groups() });

// Multiviewer decoder: four video receivers plus an audio and a data receiver numbered 1.
const mv = device("nmos_mv", "MV", 1, "Quad");
mv.receivers.video = [1, 2, 3, 4].map(n => flow("nmos_mv_v" + n, "video", n));
mv.receivers.audio = [flow("nmos_mv_a1", "audio", 1)];
mv.receivers.data = [flow("nmos_mv_d1", "data", 1)];

// Flow types the UI renders as "u", one pair sharing a number.
mv.receivers.websocket = [flow("nmos_mv_ws1", "websocket", 1)];
mv.receivers.mqtt = [flow("nmos_mv_mq2", "mqtt", 2)];
mv.receivers.unknown = [flow("nmos_mv_un2", "unknown", 2)];

// Dual-output encoder.
const enc = device("nmos_enc", "ENC", 2);
enc.senders.video = [flow("nmos_enc_v1", "video", 1), flow("nmos_enc_v2", "video", 2)];
enc.senders.audio = [flow("nmos_enc_a1", "audio", 1)];

// Gateway with senders and receivers on the same numbers.
const gw = device("nmos_gw", "GW", 3);
gw.senders.video = [flow("nmos_gw_tx1", "video", 1), flow("nmos_gw_tx2", "video", 2)];
gw.receivers.video = [flow("nmos_gw_rx1", "video", 1), flow("nmos_gw_rx2", "video", 2)];

// Two-input decoder: not four receivers, so it used to reject ".v2".
const dec2 = device("nmos_dec2", "DEC2", 4);
dec2.receivers.video = [flow("nmos_dec2_v1", "video", 1), flow("nmos_dec2_v2", "video", 2)];

// A device whose name ends in something flow-like.
const dotted = device("nmos_dot", "Studio.2", 5);
dotted.receivers.video = [flow("nmos_dot_v1", "video", 1)];

const lookup = new CrosspointOptimizedLookup();
lookup.updateFromCrosspointState({ devices: [mv, enc, gw, dec2, dotted] });

const ids = (r) => r.flows.map(f => f.id);
const resolves = (address, direction, expected) => {
    const r = lookup.resolveEndpoint(address, direction);
    check(`${direction === "senders" ? "src" : "dst"} "${address}" -> [${expected.join(", ")}]`,
        eq(ids(r), expected) && r.error === null, JSON.stringify({ flows: ids(r), error: r.error }));
};
const rejects = (address, direction) => {
    const r = lookup.resolveEndpoint(address, direction);
    check(`${direction === "senders" ? "src" : "dst"} "${address}" is rejected, not fanned out`,
        r.flows.length === 0 && typeof r.error === "string", JSON.stringify({ flows: ids(r), error: r.error }));
};

// Multiviewer quadrants are 1-based, like every other device.
for (const n of [1, 2, 3, 4]) resolves(`MV.v${n}`, "receivers", [`nmos_mv_v${n}`]);
resolves("Quad.v1", "receivers", ["nmos_mv_v1"]);          // by alias
resolves("1.v3", "receivers", ["nmos_mv_v3"]);             // by number, as the UI sends it
resolves("MV.2", "receivers", ["nmos_mv_v2"]);             // channel shorthand
resolves("MV.a1", "receivers", ["nmos_mv_a1"]);
resolves("MV.d1", "receivers", ["nmos_mv_d1"]);
resolves("MV.u1", "receivers", ["nmos_mv_ws1"]);
rejects("MV.u2", "receivers");                             // mqtt 2 and unknown 2: ambiguous
rejects("MV.v0", "receivers");
rejects("MV.v5", "receivers");
rejects("MV.0", "receivers");

// Encoder outputs are not shifted by one.
resolves("ENC.v1", "senders", ["nmos_enc_v1"]);
resolves("ENC.v2", "senders", ["nmos_enc_v2"]);
resolves("ENC.a1", "senders", ["nmos_enc_a1"]);
rejects("ENC.v3", "senders");

// Senders and receivers on the same numbers stay apart.
resolves("GW.v2", "senders", ["nmos_gw_tx2"]);
resolves("GW.v1", "receivers", ["nmos_gw_rx1"]);

// Ordinary decoders accept every receiver, and ".v1" means only receiver 1.
resolves("DEC2.v1", "receivers", ["nmos_dec2_v1"]);
resolves("DEC2.v2", "receivers", ["nmos_dec2_v2"]);

// Device level and type level still cover every flow.
resolves("MV", "receivers", ["nmos_mv_v1", "nmos_mv_v2", "nmos_mv_v3", "nmos_mv_v4"]);
resolves("ENC.v", "senders", ["nmos_enc_v1", "nmos_enc_v2"]);
const avail = lookup.resolveEndpoint("MV", "receivers", f => f.id !== "nmos_mv_v3");
check("device-level receivers honour the availability filter",
    eq(ids(avail), ["nmos_mv_v1", "nmos_mv_v2", "nmos_mv_v4"]), JSON.stringify(ids(avail)));

// NMOS ids resolve only in their own direction.
resolves("nmos_enc_v2", "senders", ["nmos_enc_v2"]);
check("a receiver id is not accepted as a source",
    lookup.resolveEndpoint("nmos_gw_rx1", "senders").flows.length === 0);

// Dotted device names still resolve.
resolves("Studio.2", "receivers", ["nmos_dot_v1"]);
rejects("Nope.v1", "receivers");

// Renumbering a flow must rebuild the maps even though no counts changed.
enc.senders.video = [flow("nmos_enc_v1", "video", 2), flow("nmos_enc_v2", "video", 1)];
lookup.updateFromCrosspointState({ devices: [mv, enc, gw, dec2, dotted] });
resolves("ENC.v1", "senders", ["nmos_enc_v2"]);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
