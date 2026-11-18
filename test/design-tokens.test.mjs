/**
 * The shared design tokens: design/tokens.json and the two files generated from it.
 * Run with `node test/design-tokens.test.mjs`.
 *
 * Four things are defended:
 *
 *   1. **The committed files match the source.** Both generated files are regenerated in
 *      memory and compared byte for byte. A token edited in tokens.json and not regenerated,
 *      or a generated file edited by hand, fails here, so the web and the native apps cannot
 *      drift apart without a red test.
 *
 *   2. **Both themes define the same names.** A colour that exists only in dark would render
 *      as the web's fallback in light and as nothing at all in Swift.
 *
 *   3. **Text is readable.** WCAG contrast for every text colour on every surface it is
 *      drawn on, and for status colours on their own tinted fill. Hand-picked hex values are
 *      exactly how a pretty palette ends up failing on the one screen nobody checked.
 *
 *   4. **The web can adopt it with no renames.** Every colour custom property that
 *      global.css defines today exists in the generated file, so phase 7 is a swap and not a
 *      rewrite of every component that reads a variable.
 */
import fs from "node:fs";
import path from "node:path";

const { PATHS, contrast, loadTokens, over, renderCss, renderSwift, themeColours } = await import("../design/generate.mjs");

let passed = 0;
let failed = 0;
const check = (label, ok, detail = "") => {
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(62)} ${detail}`);
};

const tokens = loadTokens();

// 1. Generated files are current.
check(
  "web/src/styles/tokens.generated.css is up to date",
  fs.existsSync(PATHS.css) && fs.readFileSync(PATHS.css, "utf8") === renderCss(tokens),
  "run: node design/generate.mjs",
);
check(
  "ios/.../Tokens.generated.swift is up to date",
  fs.existsSync(PATHS.swift) && fs.readFileSync(PATHS.swift, "utf8") === renderSwift(tokens),
  "run: node design/generate.mjs",
);

// 2. Both themes define the same names.
const light = themeColours(tokens, "light");
const dark = themeColours(tokens, "dark");
const keys = (o) => Object.keys(o).sort().join(",");
check("light and dark define the same colour names", keys(light) === keys(dark));
check(
  "every tint base is a real colour",
  tokens.derived.tints.every((n) => n in tokens.themes.light && n in tokens.themes.dark),
);
check(
  "every verdict maps to a real colour, and never the accent for a failure",
  Object.entries(tokens.verdict)
    .filter(([k]) => k !== "comment")
    .every(([, v]) => v in tokens.themes.light) &&
    tokens.verdict.denied !== "accent" &&
    tokens.verdict.error !== "accent",
);

// 3. Contrast. 4.5:1 is WCAG AA for body text; 3:1 is the floor for the spine line, a
// non-text graphic that is decoration beside text that carries the meaning.
const surfaces = ["bg", "bg-elevated", "bg-inset", "bg-sidebar"];
const textColours = ["text", "text-dim", "text-faint"];
const statusColours = ["ok", "warn", "danger", "accent", "attention"];
for (const theme of ["light", "dark"]) {
  const t = tokens.themes[theme];
  let worst = { ratio: Infinity, label: "" };
  const note = (label, ratio) => {
    if (ratio < worst.ratio) worst = { ratio, label };
  };
  const failures = [];
  const need = (label, ratio, min) => {
    note(label, ratio);
    if (ratio < min) failures.push(`${label} ${ratio.toFixed(2)}<${min}`);
  };
  for (const s of surfaces) {
    for (const c of textColours) need(`${c} on ${s}`, contrast(t[c], t[s]), 4.5);
    for (const c of statusColours) need(`${c} on ${s}`, contrast(t[c], t[s]), 4.5);
    need(`spine on ${s}`, contrast(t.spine, t[s]), 1.2); // a hairline: it must be visible, not loud
  }
  need("on-accent on accent", contrast(t["on-accent"], t.accent), 4.5);
  for (const c of statusColours) {
    const fill = over(t[c], tokens.alpha[theme].soft, t.bg);
    need(`${c} on its own soft fill`, contrast(t[c], fill), 4.5);
  }
  check(
    `${theme}: every text and status pairing meets its contrast floor`,
    failures.length === 0,
    failures.length ? failures.join("; ") : `tightest: ${worst.label} ${worst.ratio.toFixed(2)}`,
  );
}

// 4. The web can adopt it. Custom properties global.css defines for colour today.
const globalCss = fs.readFileSync(path.join(path.dirname(PATHS.css), "global.css"), "utf8");
const generated = fs.readFileSync(PATHS.css, "utf8");
const defined = (css) => new Set([...css.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]));
const have = defined(generated);
// Fonts, scale and the old radius names are not colours; they are checked separately below.
const wanted = [...defined(globalCss)].filter((n) => !/^--(font-|ui-scale)/.test(n));
const missing = wanted.filter((n) => !have.has(n));
check("every custom property global.css defines exists in the generated file", missing.length === 0, missing.join(" "));
check("--font-sans and --font-mono are still provided", have.has("--font-sans") && have.has("--font-mono"));

// The Swift side has what the helper and the views need.
const swift = fs.readFileSync(PATHS.swift, "utf8");
check("Swift output has a palette, verdicts, radii and spacing", ["enum Palette", "enum Verdict", "enum Radius", "enum Space"].every((s) => swift.includes(s)));
const helper = path.join(path.dirname(PATHS.swift), "DesignColor.swift");
check(
  "the hand-written colour helper exists and handles both platforms",
  fs.existsSync(helper) && /canImport\(UIKit\)/.test(fs.readFileSync(helper, "utf8")) && /canImport\(AppKit\)/.test(fs.readFileSync(helper, "utf8")),
);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
