/**
 * Turns design/tokens.json into the two files the clients consume:
 *
 *   web/src/styles/tokens.generated.css          CSS custom properties, the names global.css already uses
 *   ios/AgentSpine/Design/Tokens.generated.swift  Swift constants, shared by the iPhone and Mac targets
 *
 * Run `node design/generate.mjs` after editing tokens.json. `npm test` regenerates in memory
 * and fails if either committed file differs (test/design-tokens.test.mjs), so a token can
 * never be changed in one place and forgotten in the other.
 *
 * ## Why this is a script and not a build step
 *
 * The generated files are committed. Nothing runs at install or build time, `src/` stays free
 * of a toolchain, and the Mac and iPhone targets compile ordinary source files. A script with
 * no dependencies is the smallest thing that keeps three clients on one palette.
 *
 * ## Why the tints are derived
 *
 * Every status colour needs a faint fill (`-soft`) and a hairline (`-line`). Writing those by
 * hand for two themes and five colours is twenty values that drift apart. They are the base
 * colour at one alpha per theme, so the alpha is the number and the rest follows.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = path.dirname(import.meta.dirname);
export const PATHS = {
  tokens: path.join(ROOT, "design/tokens.json"),
  css: path.join(ROOT, "web/src/styles/tokens.generated.css"),
  swift: path.join(ROOT, "ios/AgentSpine/Design/Tokens.generated.swift"),
};

export const loadTokens = () => JSON.parse(fs.readFileSync(PATHS.tokens, "utf8"));

// ---- colour helpers (also used by the contrast test) -----------------------------------

export const parseHex = (hex) => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a 6 digit hex colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};

/** `#ffffff` becomes `#fff`: stylelint's standard config wants the short form. */
const cssHex = (hex) => {
  const h = hex.toLowerCase();
  return /^#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3$/.test(h) ? `#${h[1]}${h[3]}${h[5]}` : h;
};

const percent = (alpha) => `${Math.round(alpha * 100)}%`;
const rgbAlpha = (hex, alpha) => {
  const { r, g, b } = parseHex(hex);
  return `rgb(${r} ${g} ${b} / ${percent(alpha)})`;
};

/** WCAG relative luminance and contrast ratio. */
const channel = (v) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
export const luminance = (hex) => {
  const { r, g, b } = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
export const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** `fg` at `alpha` laid over an opaque `bg`, as a hex colour, for contrast checks on a tint. */
export const over = (fg, alpha, bg) => {
  const f = parseHex(fg);
  const b = parseHex(bg);
  const mix = (x, y) => Math.round(x * alpha + y * (1 - alpha));
  const hex = (n) => n.toString(16).padStart(2, "0");
  return `#${hex(mix(f.r, b.r))}${hex(mix(f.g, b.g))}${hex(mix(f.b, b.b))}`;
};

// ---- the full colour set for one theme -------------------------------------------------

/** Base colours plus the derived `-line`, `-soft` and `focus`, as `{ name: { hex, alpha } }`. */
export const themeColours = (tokens, theme) => {
  const out = {};
  for (const [name, hex] of Object.entries(tokens.themes[theme])) out[name] = { hex, alpha: 1 };
  const a = tokens.alpha[theme];
  for (const base of tokens.derived.tints) {
    const hex = tokens.themes[theme][base];
    out[`${base}-line`] = { hex, alpha: a.line };
    out[`${base}-soft`] = { hex, alpha: a.soft };
  }
  out.focus = { hex: tokens.themes[theme].accent, alpha: 0.5 };
  return out;
};

const sortedEntries = (o) => Object.entries(o).sort(([a], [b]) => a.localeCompare(b));
const camel = (s) => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const px = (n) => `${n}px`;
const rem = (n) => `${+(n / 16).toFixed(4)}rem`;

// ---- CSS -------------------------------------------------------------------------------

export const renderCss = (tokens) => {
  const block = (theme) => {
    const lines = sortedEntries(themeColours(tokens, theme)).map(([name, c]) =>
      c.alpha === 1 ? `  --${name}: ${cssHex(c.hex)};` : `  --${name}: ${rgbAlpha(c.hex, c.alpha)};`,
    );
    lines.push(`  --scrim: ${tokens.web.scrim[theme]};`);
    lines.push(`  --shadow: ${tokens.web.shadow[theme]};`);
    return lines.sort().join("\n");
  };
  const shared = [
    ...Object.entries(tokens.fonts).map(([k, v]) => `  --font-${k}: ${v};`),
    ...Object.entries(tokens.radius).map(([k, v]) => `  --radius${k === "md" ? "" : `-${k}`}: ${px(v)};`),
    ...Object.entries(tokens.space).map(([k, v]) => `  --space-${k}: ${px(v)};`),
    ...Object.entries(tokens.type)
      .filter(([k]) => k !== "comment")
      .map(([k, v]) => `  --font-size-${k}: ${rem(v)};`),
    ...Object.entries(tokens.verdict)
      .filter(([k]) => k !== "comment")
      .map(([k, v]) => `  --verdict-${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: var(--${v});`),
  ].join("\n");
  return `/*
 * GENERATED by design/generate.mjs from design/tokens.json. Do not edit by hand:
 * \`npm test\` regenerates this in memory and fails if the committed file differs.
 *
 * Imported by global.css, which defines no palette of its own: retheming the web client is an
 * edit to tokens.json and a regeneration (phase 7 of docs/archive/PLAN-native-apps-and-ui-refresh.md).
 */

:root,
:root[data-theme="light"] {
${block("light")}
${shared}

  color-scheme: light;
}

:root[data-theme="dark"] {
${block("dark")}

  color-scheme: dark;
}
`;
};

// ---- Swift -----------------------------------------------------------------------------

const swiftRgba = (c) => `SpineRGBA(0x${c.hex.slice(1).toUpperCase()}${c.alpha === 1 ? "" : `, ${c.alpha}`})`;
const firstFamily = (stack) => /"([^"]+)"/.exec(stack)?.[1] ?? stack.split(",")[0].trim();

export const renderSwift = (tokens) => {
  const light = themeColours(tokens, "light");
  const dark = themeColours(tokens, "dark");
  const names = Object.keys(light).sort();
  for (const n of names) if (!dark[n]) throw new Error(`dark theme is missing ${n}`);
  const palette = names
    .map((n) => `        static let ${camel(n)} = Color(light: ${swiftRgba(light[n])}, dark: ${swiftRgba(dark[n])})`)
    .join("\n");
  const cg = (obj) =>
    Object.entries(obj)
      .filter(([k]) => k !== "comment")
      .map(([k, v]) => `        static let ${camel(k)}: CGFloat = ${v}`)
      .join("\n");
  const verdict = Object.entries(tokens.verdict)
    .filter(([k]) => k !== "comment")
    .map(([k, v]) => `        static let ${k} = Palette.${camel(v)}`)
    .join("\n");
  const fonts = Object.entries(tokens.fonts)
    .map(([k, v]) => `        static let ${k} = "${firstFamily(v)}"`)
    .join("\n");
  return `// GENERATED by design/generate.mjs from design/tokens.json. Do not edit by hand.
// \`npm test\` regenerates this in memory and fails if the committed file differs.
//
// Shared by the iPhone and Mac targets. The colour initialiser lives in DesignColor.swift.

import SwiftUI

enum Spine {
    /// Colours that follow the system appearance. Names match the web's custom properties.
    enum Palette {
${palette}
    }

    /// The broker's verdict on a tool call, mapped to a palette colour. Never the accent.
    enum Verdict {
${verdict}
    }

    enum Radius {
${cg(tokens.radius)}
    }

    enum Space {
${cg(tokens.space)}
    }

    /// Point sizes. Scale them with Dynamic Type at the call site (\`@ScaledMetric\`).
    enum TypeSize {
${cg(tokens.type)}
    }

    /// Family names. They fall back to the system font if the files are not bundled yet.
    enum Family {
${fonts}
    }
}
`;
};

// ---- CLI -------------------------------------------------------------------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const tokens = loadTokens();
  for (const [file, text] of [
    [PATHS.css, renderCss(tokens)],
    [PATHS.swift, renderSwift(tokens)],
  ]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    console.log(`wrote ${path.relative(ROOT, file)}`);
  }
}
