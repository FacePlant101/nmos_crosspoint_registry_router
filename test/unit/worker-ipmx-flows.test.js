/*
 * Crosspoint model for MatroxOnly / IPMX resources.
 *
 * Feeds the real worker the resource shapes alabou/NMOS-Reference registers
 * (see .claude/skills/run-nmos-crosspoint) and checks the published
 * crosspointState:
 *
 * - USB published as urn:x-nmos:transport:usb (the IPMX canonical URN) is
 *   reported as transport "usb", same as urn:x-matrox:transport:usb.
 * - The USB data flow's format is not the literal "flow.media.type".
 * - AM824 audio, which has no bit_depth, does not render "undefinedbit".
 * - urn:x-nmos:format:mux senders and receivers are in the model, not dropped,
 *   and a mux left under "unknown" by an older build is moved out of it.
 *
 *   npm --prefix server run build && node test/unit/worker-ipmx-flows.test.js
 */
const fs = require("fs"), os = require("os"), path = require("path");
const { Worker } = require("worker_threads");

const WORKER = path.join(__dirname, "..", "..", "server", "dist", "lib", "crosspointUpdateThread.js");
const FUNCTIONS = path.join(__dirname, "..", "..", "server", "dist", "lib", "functions.js");
if (!fs.existsSync(WORKER)) {
    console.error("build the server first: npm --prefix server run build");
    process.exit(2);
}

let pass = 0, fail = 0;
const check = (n, c, x) => { c ? (pass++, console.log("PASS  " + n)) : (fail++, console.log("FAIL  " + n + (x ? "  " + x : ""))); };

// --- functions.ts: both USB URNs are USB
const { transportShortCode, isUsbTransport, isMulticastTransport } = require(FUNCTIONS);
check("urn:x-matrox:transport:usb -> usb", transportShortCode("urn:x-matrox:transport:usb") === "usb");
check("urn:x-nmos:transport:usb -> usb", transportShortCode("urn:x-nmos:transport:usb") === "usb");
check("isUsbTransport accepts the IPMX URN", isUsbTransport("urn:x-nmos:transport:usb"));
check("IPMX USB is not multicast", !isMulticastTransport("urn:x-nmos:transport:usb"));

// --- worker fixture
const repo = path.join(__dirname, "..", "..");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "worker-ipmx-"));
fs.mkdirSync(path.join(dir, "state"));
fs.mkdirSync(path.join(dir, "config"));
fs.copyFileSync(path.join(repo, "server", "config.default", "settings.json"),
                path.join(dir, "config", "settings.json"));

const DEV = "00000000-1000-4000-8006-453036130002";
const GRP = "nmos_" + DEV;
const id = (n) => `00000000-${n}-4000-8006-453036130002`;
const sub = { active: false, receiver_id: null };

// A shadow written by a build that had no mux class: the mux sender sits under "unknown".
const empty = () => ({ audio: {}, audiochannel: {}, video: {}, data: {}, websocket: {}, mqtt: {}, unknown: {} });
const shadow = { devices: { [GRP]: { id: GRP, num: 1000, order: -1, name: "dev", senders: empty(), receivers: empty() } } };
shadow.devices[GRP].senders.unknown["nmos_" + id(2020)] = { id: "nmos_" + id(2020), name: "mux", num: 1, order: -1, type: "unknown", channelNumber: -1 };
fs.writeFileSync(path.join(dir, "state", "crosspoint.json"), JSON.stringify(shadow));
process.chdir(dir);

const sources = {
    "src-am824": { id: "src-am824", format: "urn:x-nmos:format:audio", channels: [{ label: "L" }, { label: "R" }] },
    "src-usb": { id: "src-usb", format: "urn:x-nmos:format:data" },
    "src-mux": { id: "src-mux", format: "urn:x-nmos:format:mux" },
};
const flows = {
    "flow-am824": { id: "flow-am824", source_id: "src-am824", format: "urn:x-nmos:format:audio", media_type: "audio/AM824", sample_rate: { numerator: 48000, denominator: 1 } },
    "flow-usb": { id: "flow-usb", source_id: "src-usb", format: "urn:x-nmos:format:data", media_type: "application/usb" },
    "flow-mux": { id: "flow-mux", source_id: "src-mux", format: "urn:x-nmos:format:mux", media_type: "application/AM824",
                  "urn:x-matrox:video_layers": 0, "urn:x-matrox:audio_layers": 2, "urn:x-matrox:data_layers": 0 },
};
const tx = (n, label, flow, transport) => ({ id: id(n), label, device_id: DEV, flow_id: flow, transport, interface_bindings: ["eth0"], subscription: sub });
const senders = {
    [id(2010)]: tx(2010, "AM824 audio", "flow-am824", "urn:x-nmos:transport:rtp.mcast"),
    [id(2030)]: tx(2030, "USB", "flow-usb", "urn:x-nmos:transport:usb"),
    [id(2020)]: tx(2020, "AM824 mux", "flow-mux", "urn:x-nmos:transport:rtp.mcast"),
};
const rx = (n, label, format, transport, caps) => ({ id: id(n), label, device_id: DEV, format, transport, caps, interface_bindings: ["eth0"], subscription: sub });
const receivers = {
    [id(3030)]: rx(3030, "USB", "urn:x-nmos:format:data", "urn:x-nmos:transport:usb", { media_types: ["application/usb"] }),
    [id(3000)]: rx(3000, "Mux", "urn:x-nmos:format:mux", "urn:x-nmos:transport:rtp.mcast", {
        media_types: ["application/AM824"],
        constraint_sets: [
            { "urn:x-matrox:cap:format:video_layers": { minimum: 0, maximum: 0 }, "urn:x-matrox:cap:format:audio_layers": { minimum: 1, maximum: 2 } },
            // disabled sets must not count
            { "urn:x-nmos:cap:meta:enabled": false, "urn:x-matrox:cap:format:video_layers": { enum: [1] } },
        ],
    }),
};
const nmosState = { devices: { [DEV]: { id: DEV, label: "dev" } }, sources, flows, senders, receivers, sendersManifestDetail: {}, senderActiveData: {} };

const worker = new Worker(WORKER);
const timer = setTimeout(() => { check("worker publishes crosspointState within 5s", false, "timed out"); finish(); }, 5000);

worker.on("message", (message) => {
    if (typeof message !== "string") return;
    let data;
    try { data = JSON.parse(message); } catch (e) { return; }
    if (!data.crosspointState) return;
    const dev = data.crosspointState.devices.find((d) => d.id === GRP);
    if (!dev) return;
    clearTimeout(timer);

    const all = (side) => Object.values(dev[side]).flat();
    const flow = (side, n) => all(side).find((f) => f.id === "nmos_" + id(n));

    const usbTx = flow("senders", 2030), usbRx = flow("receivers", 3030);
    check("USB sender transport is usb", usbTx && usbTx.capabilities.transport === "usb", JSON.stringify(usbTx && usbTx.capabilities));
    check("USB receiver transport is usb", usbRx && usbRx.capabilities.transport === "usb", JSON.stringify(usbRx && usbRx.capabilities));
    check("USB format is not the literal 'flow.media.type'", usbTx && usbTx.format === "USB", usbTx && usbTx.format);

    const am = flow("senders", 2010);
    check("AM824 audio format names the encoding", am && am.format === "2Ch AM824 48kHz", am && am.format);
    check("RTP sender transport is still rtp", am && am.capabilities.transport === "rtp");

    const muxTx = flow("senders", 2020), muxRx = flow("receivers", 3000);
    check("mux sender is in the model as audio", muxTx && muxTx.type === "audio" && dev.senders.audio.includes(muxTx), JSON.stringify(muxTx));
    check("mux sender format", muxTx && muxTx.format === "AM824 mux 2 audio", muxTx && muxTx.format);
    check("mux receiver is in the model as audio", muxRx && muxRx.type === "audio" && dev.receivers.audio.includes(muxRx), JSON.stringify(muxRx));

    const saved = JSON.parse(fs.readFileSync(path.join(dir, "state", "crosspoint.json"), "utf8"));
    const s = saved.devices[GRP].senders;
    check("stale 'unknown' mux entry removed from the shadow", !s.unknown.hasOwnProperty("nmos_" + id(2020)));
    check("mux kept under audio in the shadow", s.audio.hasOwnProperty("nmos_" + id(2020)));
    finish();
});

worker.postMessage(JSON.stringify({ nmosState }));

function finish() {
    worker.terminate().then(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        console.log(`\n${pass} passed, ${fail} failed`);
        process.exit(fail ? 1 : 0);
    });
}
