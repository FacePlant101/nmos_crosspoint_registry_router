/*
 * Matrox toggleMultiviewer — regression tests.
 *
 * The toggle used to (a) fetch the device context under the caller's search term,
 * so a call by device name logged in under that name instead of the serial, (b)
 * report success whatever the device answered, and (c) swallow a failure to enable
 * master mode, which multiviewer needs. It now resolves the serial once, reads the
 * setting back from the device, and rejects when either step fails.
 *
 * Exercises the REAL compiled method with stubbed device I/O.
 *
 *   npm --prefix server run build && node test/unit/matrox-toggle-multiviewer.test.js
 */
const fs = require("fs"), path = require("path");

const MODULE = path.join(__dirname, "..", "..", "server", "dist", "mediaDevices", "matroxConvertIp.js");
if (!fs.existsSync(MODULE)) {
    console.error("build the server first: npm --prefix server run build");
    process.exit(2);
}
const MediaDevMatroxConvertIp = require(MODULE).default;

let pass = 0, fail = 0;
const check = (n, c, x) => { c ? (pass++, console.log("PASS  " + n)) : (fail++, console.log("FAIL  " + n + (x ? "  " + x : ""))); };

// Run the reload the toggle schedules straight away, so the test does not wait 2s.
global.setTimeout = (fn) => { fn(); return 0; };

/**
 * A module instance whose device keeps multiviewer at `stored` unless `accepts` is true.
 * `report: false` models firmware without the setting; `masterFails` a master-mode failure.
 */
function rig({ accepts = true, report = true, masterFails = false } = {}) {
    const m = Object.create(MediaDevMatroxConvertIp.prototype);
    const cip = { sn: "ya00634", name: "Studio Quad", ipList: ["10.0.0.20"], isMultiviewEnabled: false };
    m.state = { devices: { ya00634: cip } };
    m.calls = [];
    m.master = [];
    m.reloads = [];
    let stored = false;
    m.apiRequest = async (ipList, sn, method, href, data) => {
        m.calls.push({ sn, method, href });
        if (method === "POST" && accepts) stored = data.MultiviewSettings.isMultiviewEnabled;
        if (method === "GET") return report ? { MultiviewSettings: { isMultiviewEnabled: stored } } : {};
        return {};
    };
    m.ensureMasterEnabled = async (sn) => {
        m.master.push(sn);
        if (masterFails) throw new Error("Master mode not enabled after 3 attempts");
    };
    m.reloadData = (ipList, sn) => { m.reloads.push(sn); };
    m.cip = cip;
    return m;
}
const outcome = (p) => p.then(() => null, (e) => e.message);

(async () => {
    {
        const m = rig();
        const err = await outcome(m.toggleMultiviewer("Studio Quad", true));
        check("enable by device name succeeds", err === null, err);
        check("every device call uses the serial, not the name",
            m.calls.length > 0 && m.calls.every(c => c.sn === "ya00634"), JSON.stringify(m.calls));
        check("setting is read back after the POST",
            m.calls.map(c => c.method).join(",") === "POST,GET", JSON.stringify(m.calls));
        check("master mode is ensured on the serial", m.master.join() === "ya00634");
        check("state updates without waiting for the reload", m.cip.isMultiviewEnabled === true);
        check("device is reloaded", m.reloads.join() === "ya00634");
    }
    {
        const m = rig();
        const err = await outcome(m.toggleMultiviewer("ya00634", false));
        check("disable by serial succeeds", err === null, err);
        check("disable does not touch master mode", m.master.length === 0);
    }
    {
        const m = rig({ accepts: false });
        const err = await outcome(m.toggleMultiviewer("ya00634", true));
        check("rejects when the device keeps the old setting", typeof err === "string" && /kept multiviewer disabled/.test(err), err);
        check("does not enable master mode after a rejected change", m.master.length === 0);
        check("still reloads after a failure", m.reloads.join() === "ya00634");
    }
    {
        const m = rig({ report: false });
        const err = await outcome(m.toggleMultiviewer("ya00634", true));
        check("rejects when the device has no multiviewer setting", typeof err === "string", err);
    }
    {
        const m = rig({ masterFails: true });
        const err = await outcome(m.toggleMultiviewer("ya00634", true));
        check("a master-mode failure is reported", typeof err === "string" && /Master mode/.test(err), err);
    }
    {
        const m = rig();
        const err = await outcome(m.toggleMultiviewer("ya00634", "false"));
        check("a non-boolean 'enabled' is rejected", typeof err === "string" && /enabled/.test(err), err);
        check("...before any device call", m.calls.length === 0);
    }
    {
        const m = rig();
        const err = await outcome(m.toggleMultiviewer("Nope", true));
        check("an unknown device is rejected", err === "Device not found.", err);
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
