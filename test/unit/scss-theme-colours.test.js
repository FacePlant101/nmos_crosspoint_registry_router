/*
 * daisyUI theme colours must be read with oklch(), not hsl().
 *
 * daisyUI 4 stores --p, --su, --wa, --er, --bc and the rest as oklch
 * components ("84.71% .199 83.87"). hsl(var(--wa)) is not a valid colour, so
 * CSS drops the declaration silently and the element keeps what it inherited —
 * which looks like ordinary body text, not like a bug. Every warning and error
 * colour in this UI was grey that way until it was caught by eye.
 *
 * A grep is the whole test: the failure mode is invisible at runtime, so the
 * only reliable guard is not writing it in the first place.
 *
 *   node test/unit/scss-theme-colours.test.js
 */
const fs = require("fs"), path = require("path");

const root = path.join(__dirname, "..", "..", "ui", "src");
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : [p];
});

let pass = 0, fail = 0;
const check = (n, c, x) => { c ? (pass++, console.log("PASS  " + n)) : (fail++, console.log("FAIL  " + n + (x ? "  " + x : ""))); };

const files = walk(root).filter((f) => /\.(scss|css|svelte|ts|js|html)$/.test(f));
check("there are style files to check", files.length > 0);

const offenders = [];
for (const f of files) {
    const lines = fs.readFileSync(f, "utf8").split("\n");
    lines.forEach((line, i) => {
        // Comments explain the rule and necessarily quote the wrong form.
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
        // hsl(var(--x)) in any form, with or without an alpha suffix.
        if (/hsl\(\s*var\(\s*--/.test(line)) {
            offenders.push(path.relative(root, f) + ":" + (i + 1) + "  " + line.trim());
        }
    });
}
check("no style reads a theme variable with hsl(var(--…))",
    offenders.length === 0, "\n      " + offenders.join("\n      "));

// The positive case: the colours the UI depends on are actually read somewhere.
const scss = files.filter((f) => f.endsWith(".scss")).map((f) => fs.readFileSync(f, "utf8")).join("\n");
for (const v of ["su", "wa", "er"]) {
    check("--" + v + " is read with oklch()", new RegExp("oklch\\(\\s*var\\(\\s*--" + v + "\\b").test(scss));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
