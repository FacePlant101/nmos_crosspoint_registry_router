/*
 * Virtual node: SDP → IS-04 mapping, device references, and identifier
 * stability. Drives the real compiled modules.
 *
 *   npm --prefix server run build && node test/unit/virtual-node-mapping.test.js
 */
const fs = require("fs"), os = require("os"), path = require("path");
const repo = path.join(__dirname, "..", "..");
const dist = path.join(repo, "server", "dist");
if (!fs.existsSync(path.join(dist, "lib", "NmosNode", "sdpToNmos.js"))) {
    console.error("build the server first: npm --prefix server run build");
    process.exit(2);
}
// parseSettings writes nothing, but NmosNodeApi's siblings read ./state.
process.chdir(fs.mkdtempSync(path.join(os.tmpdir(), "vnode-")));
fs.mkdirSync("state");

const { parseVirtualSdp } = require(path.join(dist, "lib", "NmosNode", "sdpToNmos"));
const { NmosNodeApi }     = require(path.join(dist, "lib", "NmosNode", "NmosNodeApi"));
const { parseSettings }   = require(path.join(dist, "lib", "parseSettings"));

let pass = 0, fail = 0;
const check = (n, c, x) => { c ? (pass++, console.log("PASS  " + n)) : (fail++, console.log("FAIL  " + n + (x ? "  " + x : ""))); };
const sdp = (...lines) => ["v=0", "o=- 1 1 IN IP4 10.0.0.1", "s=Test", "t=0 0", ...lines].join("\n");

const VIDEO = ["m=video 5004 RTP/AVP 96", "c=IN IP4 239.1.1.1/64", "a=rtpmap:96 raw/90000",
    "a=fmtp:96 sampling=YCbCr-4:2:2; width=1920; height=1080; exactframerate=25; depth=10; colorimetry=BT709"];
const VIDEO_B = ["m=video 5004 RTP/AVP 96", "c=IN IP4 239.2.2.2/64", "a=rtpmap:96 raw/90000"];
const AUDIO = ["m=audio 5006 RTP/AVP 97", "c=IN IP4 239.1.1.2/64", "a=rtpmap:97 L24/48000/8"];
const ANC   = ["m=video 5008 RTP/AVP 100", "c=IN IP4 239.1.1.3/64", "a=rtpmap:100 smpte291/90000"];

// ---- legs are redundant copies of ONE essence, not "every m= block" ----
{
    const p = parseVirtualSdp(sdp(...VIDEO, ...AUDIO));
    check("a multi-essence SDP publishes only the primary essence",
        p.transportParams.length === 1 && p.transportParams[0].destination_ip === "239.1.1.1",
        JSON.stringify(p.transportParams.map((t) => t.destination_ip)));
    check("...and it stays a video flow", p.format === "urn:x-nmos:format:video" && p.mediaType === "video/raw");
    check("...and the audio block is reported as not published",
        p.droppedMedia.length === 1 && /audio/.test(p.droppedMedia[0]), JSON.stringify(p.droppedMedia));
}
{
    const p = parseVirtualSdp(sdp(...VIDEO, ...AUDIO, ...ANC));
    check("a three-essence SDP drops both of the others", p.droppedMedia.length === 2, JSON.stringify(p.droppedMedia));
    check("...and never puts another essence on a leg",
        p.transportParams.every((t) => t.destination_ip === "239.1.1.1"));
}
{
    // The case the leg logic exists for must keep working.
    const p = parseVirtualSdp(sdp(...VIDEO, ...VIDEO_B));
    check("a genuine ST 2022-7 SDP still yields two legs",
        p.transportParams.length === 2 &&
        p.transportParams[0].destination_ip === "239.1.1.1" &&
        p.transportParams[1].destination_ip === "239.2.2.2",
        JSON.stringify(p.transportParams.map((t) => t.destination_ip)));
    check("...with nothing dropped", p.droppedMedia.length === 0);
}
{
    const p = parseVirtualSdp(sdp(...AUDIO));
    check("a single-essence audio SDP is unaffected",
        p.format === "urn:x-nmos:format:audio" && p.transportParams.length === 1 && p.droppedMedia.length === 0);
}

// ---- media_type must match what the device itself publishes ----
{
    // Modelled on a real Matrox ConvertIP sender (addresses changed). Those
    // devices publish media_type "video/colibri"; upper-casing the subtype
    // produced "video/COLIBRI", which no receiver's caps match by string, so
    // the virtual sender was unroutable by the controllers it exists to serve.
    const colibri = sdp(
        "m=video 5004 RTP/AVP 112", "c=IN IP4 239.0.0.1/128", "b=AS:220045",
        "a=rtpmap:112 colibri/90000",
        "a=fmtp:112 sampling=RGB; width=1920; height=1080; exactframerate=60; depth=8; " +
        "PM=2110GPM; IPMX; colorimetry=BT709; TCS=SDR; RANGE=FULL; SSN=ST2110-22:2019");
    check("a vendor codec keeps the spelling the SDP used",
        parseVirtualSdp(colibri).mediaType === "video/colibri", parseVirtualSdp(colibri).mediaType);
    check("...and is still a video flow",
        parseVirtualSdp(colibri).format === "urn:x-nmos:format:video");

    const upper = colibri.replace("colibri/90000", "COLIBRI/90000");
    check("an upper-case vendor codec is also left alone",
        parseVirtualSdp(upper).mediaType === "video/COLIBRI", parseVirtualSdp(upper).mediaType);

    // The known subtypes have canonical case of their own, in both directions.
    const withCodec = (c, type) => sdp(`m=${type} 5004 RTP/AVP 96`, "c=IN IP4 239.0.0.1/64",
        `a=rtpmap:96 ${c}/90000`);
    const cases = [
        ["raw",      "video", "video/raw"],
        ["RAW",      "video", "video/raw"],
        ["jxsv",     "video", "video/jxsv"],
        ["smpte291", "video", "video/smpte291"],
    ];
    for (const [c, type, want] of cases) {
        check(`"${c}" maps to ${want}`, parseVirtualSdp(withCodec(c, type)).mediaType === want,
            parseVirtualSdp(withCodec(c, type)).mediaType);
    }
    // Audio needs the channel count on the rtpmap line, so build those by hand.
    const audio = (c) => sdp(`m=audio 5006 RTP/AVP 97`, "c=IN IP4 239.0.0.2/64", `a=rtpmap:97 ${c}/48000/8`);
    for (const [c, want] of [["L24", "audio/L24"], ["L16", "audio/L16"], ["L32", "audio/L24"],
                             ["l24", "audio/L24"]]) {
        check(`audio "${c}" maps to ${want}`, parseVirtualSdp(audio(c)).mediaType === want,
            parseVirtualSdp(audio(c)).mediaType);
    }
}

// ---- the Device must not reference senders that do not exist ----
{
    const st = parseSettings({ virtualNode: { enabled: true }, virtualSenders: [
        { id: "ok",  name: "Good",  sdp: sdp(...VIDEO) },
        { id: "bad", name: "No c=", sdp: sdp("m=video 5004 RTP/AVP 96", "a=rtpmap:96 raw/90000") },
    ]});
    const api = new NmosNodeApi(st);
    const built = api.getSenders().map((s) => s.id);
    check("a sender whose SDP cannot be parsed is not built", built.length === 1);
    check("...and the Device does not advertise it",
        api.getDevice().senders.length === 1 && api.getDevice().senders.every((id) => built.includes(id)),
        JSON.stringify(api.getDevice().senders));
    check("...and the reason is recorded", Object.keys(api.lastError).length === 1);
    check("a dropped essence is recorded as a warning, not an error",
        Object.keys(new NmosNodeApi(parseSettings({ virtualNode: { enabled: true },
            virtualSenders: [{ id: "m", name: "Multi", sdp: sdp(...VIDEO, ...AUDIO) }] })).lastWarning).length === 1);
}

// ---- identifiers must survive a Setup save, not just a restart ----
{
    // Mirrors the server's save path: the client posts back the projection
    // getSetupConfigState produced, and the route re-normalises.
    const applySave = (stored, posted) => {
        const existing = {};
        for (const old of stored.virtualSenders) existing[old.id] = old;
        stored.virtualSenders = posted.map((v) => {
            const prev = existing[v.id];
            return prev ? { ...v, senderId: prev.senderId, sourceId: prev.sourceId, flowId: prev.flowId } : v;
        });
        return parseSettings(stored);
    };
    let st = parseSettings({ virtualSenders: [{ id: "vs_a", name: "Cam", sdp: sdp(...VIDEO) }] });
    const before = { ...st.virtualSenders[0] };
    // What the UI holds and sends back, including the read-only ids.
    const posted = st.virtualSenders.map((v) => ({ id: v.id, name: v.name, sdp: v.sdp,
        senderId: v.senderId, sourceId: v.sourceId, flowId: v.flowId }));
    st = applySave(st, posted);
    let after = st.virtualSenders[0];
    check("a save keeps senderId", after.senderId === before.senderId);
    check("a save keeps sourceId", after.sourceId === before.sourceId);
    check("a save keeps flowId",   after.flowId   === before.flowId);

    // An older client that does not know about sourceId/flowId must not be
    // able to make the server mint new ones either.
    const legacy = st.virtualSenders.map((v) => ({ id: v.id, name: v.name, sdp: v.sdp, senderId: v.senderId }));
    st = applySave(st, legacy);
    after = st.virtualSenders[0];
    check("a client that omits the ids cannot force a re-mint",
        after.senderId === before.senderId && after.sourceId === before.sourceId && after.flowId === before.flowId);

    // A genuinely new sender still gets its own.
    st.virtualSenders = [...st.virtualSenders, { id: "vs_new", name: "New", sdp: sdp(...VIDEO) }];
    st = parseSettings(st);
    const fresh = st.virtualSenders.find((v) => v.id === "vs_new");
    check("a new sender is still minted a full set of ids",
        !!fresh.senderId && !!fresh.sourceId && !!fresh.flowId &&
        fresh.senderId !== before.senderId && fresh.flowId !== before.flowId);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
