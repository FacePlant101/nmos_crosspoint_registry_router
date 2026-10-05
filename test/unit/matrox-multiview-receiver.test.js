/*
 * Matrox multiviewer receiver detection — regression tests.
 *
 * Predictive staging must not stage onto a Matrox decoder that has multiviewer
 * enabled. Both stagers looked the decoder up by the ROUTER's alias / name / number,
 * which the Matrox module does not know (it has no alias or num at all), so giving a
 * decoder an alias silently disabled the protection. Detection now goes through the
 * receiver's NMOS device and node: API addresses first, then the serial Matrox
 * encodes in its node id.
 *
 * Exercises the REAL compiled modules with a stubbed registry and Matrox state.
 *
 *   npm --prefix server run build && node test/unit/matrox-multiview-receiver.test.js
 */
const fs = require("fs"), path = require("path");

const DIST = path.join(__dirname, "..", "..", "server", "dist");
if (!fs.existsSync(path.join(DIST, "lib", "matroxDeviceMatch.js"))) {
    console.error("build the server first: npm --prefix server run build");
    process.exit(2);
}
const { matroxSerialFromNodeId, findMatroxDeviceKey } = require(path.join(DIST, "lib", "matroxDeviceMatch.js"));
const { NmosRegistryConnector } = require(path.join(DIST, "lib", "nmosConnector.js"));
const MediaDevMatroxConvertIp = require(path.join(DIST, "mediaDevices", "matroxConvertIp.js")).default;

let pass = 0, fail = 0;
const check = (n, c, x) => { c ? (pass++, console.log("PASS  " + n)) : (fail++, console.log("FAIL  " + n + (x ? "  " + x : ""))); };

// --- serial from node id ------------------------------------------------------
check("serial from Matrox node id",
    matroxSerialFromNodeId("abc1230-0000-0000-0000-000000000000") === "abc123");
check("serial keeps a final digit other than 0",
    matroxSerialFromNodeId("abc1235-0000-0000-0000-000000000000") === "abc1235");
check("non-Matrox node id gives null",
    matroxSerialFromNodeId("6f1c2e9a-3b4d-4e5f-8a9b-0c1d2e3f4a5b") === null);

// --- device matching ----------------------------------------------------------
const matrox = {
    // Keyed under an alphanumeric serial after de-duplication, so the node id serial differs.
    "ya00634": { sn: "ya00634", name: "Studio Quad", ipList: ["10.0.0.20", "10.1.0.20"], isMultiviewEnabled: true },
    "abc123":  { sn: "abc123",  name: "Desk Mon",   ipList: ["10.0.0.21"], isMultiviewEnabled: false },
    "def456":  { sn: "def456",  name: "Wall",       ipList: ["10.0.0.22"], isMultiviewEnabled: true },
};
const node = (id, hosts) => ({ id, api: { endpoints: hosts.map(host => ({ host, port: 80, protocol: "http" })) } });

check("matches by API address",
    findMatroxDeviceKey(matrox, node("1234560-0000-0000-0000-000000000000", ["10.1.0.20"])) === "ya00634");
check("falls back to the serial in the node id",
    findMatroxDeviceKey(matrox, node("def4560-0000-0000-0000-000000000000", [])) === "def456");
check("serial match ignores case",
    findMatroxDeviceKey(matrox, node("DEF4560-0000-0000-0000-000000000000", [])) === "def456");
check("unknown node gives null",
    findMatroxDeviceKey(matrox, node("6f1c2e9a-3b4d-4e5f-8a9b-0c1d2e3f4a5b", ["10.9.9.9"])) === null);

// --- isMultiviewReceiver end to end -------------------------------------------
const matroxTags = {
    "urn:x-nmos:tag:asset:manufacturer/v1.0": ["Matrox"],
    "urn:x-nmos:tag:asset:product/v1.0": ["ConvertIP"],
};
const nmosState = {
    nodes: {
        "n-quad": node("n-quad", ["10.0.0.20"]),
        "n-desk": node("n-desk", ["10.0.0.21"]),
        "n-other": node("n-other", ["10.0.0.99"]),
    },
    devices: {
        // The router may alias this device anything; the label does not match the Matrox name either.
        "d-quad":  { id: "d-quad",  node_id: "n-quad",  label: "Renamed in NMOS", tags: matroxTags },
        "d-desk":  { id: "d-desk",  node_id: "n-desk",  label: "Desk Mon",        tags: matroxTags },
        "d-other": { id: "d-other", node_id: "n-other", label: "Studio Quad",     tags: {} },
    },
    receivers: {
        "r-quad-1": { id: "r-quad-1", device_id: "d-quad" },
        "r-quad-4": { id: "r-quad-4", device_id: "d-quad" },
        "r-desk":   { id: "r-desk",   device_id: "d-desk" },
        "r-other":  { id: "r-other",  device_id: "d-other" },
    },
    senders: {},
};
NmosRegistryConnector.instance = { getNmosState: () => nmosState };
MediaDevMatroxConvertIp.instance = { state: { devices: matrox } };

check("receiver on a multiviewer decoder is detected, whatever it is called",
    MediaDevMatroxConvertIp.isMultiviewReceiver("nmos_r-quad-1") === true);
check("every quadrant receiver is detected",
    MediaDevMatroxConvertIp.isMultiviewReceiver("nmos_r-quad-4") === true);
check("receiver on a decoder without multiviewer is not",
    MediaDevMatroxConvertIp.isMultiviewReceiver("nmos_r-desk") === false);
check("non-Matrox device sharing a Matrox name is not",
    MediaDevMatroxConvertIp.isMultiviewReceiver("nmos_r-other") === false);
check("unknown receiver is not",
    MediaDevMatroxConvertIp.isMultiviewReceiver("nmos_r-missing") === false);

matrox["ya00634"].isMultiviewEnabled = false;
check("follows the device when multiviewer is switched off",
    MediaDevMatroxConvertIp.isMultiviewReceiver("nmos_r-quad-1") === false);

MediaDevMatroxConvertIp.instance = null;
check("no Matrox module loaded means no multiviewers",
    MediaDevMatroxConvertIp.isMultiviewReceiver("nmos_r-quad-1") === false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
