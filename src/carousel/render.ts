/**
 * A gig carousel, rendered (PLAN-open-work section 14, U10).
 *
 * One fixed HTML template per slide, screenshotted by headless Chrome through playwright-core,
 * which is already a dependency. The fonts are the app's own, read from the repo and embedded,
 * so a slide looks the same on a machine that has never installed them and nothing is fetched.
 *
 * Its own headless Chrome, never the one `BROWSER_MODE=cdp` attaches to: this draws local text
 * and has no reason to be near a signed-in profile.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import type { Browser } from "playwright-core";
import { CHROME_PATH } from "../config.ts";
import { SLIDE_HEIGHT, SLIDE_WIDTH } from "./plan.ts";
import type { CarouselPlan, Slide } from "./plan.ts";

const FONT_DIR = path.join(import.meta.dirname, "..", "..", "web", "public", "fonts");

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const fontFace = (family: string, file: string): string => {
  const full = path.join(FONT_DIR, file);
  if (!fs.existsSync(full)) return "";
  return `@font-face { font-family: "${family}"; src: url(data:font/ttf;base64,${fs.readFileSync(full).toString("base64")}) format("truetype"); font-weight: 100 900; }`;
};

/** The stylesheet every slide shares. Colours are the app's dark palette, written out so the kit needs no build. */
export const slideCss = (embedFonts = true): string => `
${embedFonts ? fontFace("Bricolage Grotesque", "BricolageGrotesque.ttf") : ""}
${embedFonts ? fontFace("Instrument Sans", "InstrumentSans.ttf") : ""}
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: ${SLIDE_WIDTH}px; height: ${SLIDE_HEIGHT}px; }
body { background: #0f1115; color: #f2f3f5; font-family: "Instrument Sans", system-ui, sans-serif; overflow: hidden; }
.slide { display: flex; flex-direction: column; height: 100%; padding: 96px 72px 84px; }
.label { color: #f0b35a; font-size: 34px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; }
.lines { display: flex; flex: 1; flex-direction: column; gap: 22px; justify-content: center; }
.line { overflow-wrap: anywhere; }
.strong { font-family: "Bricolage Grotesque", "Instrument Sans", sans-serif; font-weight: 700; line-height: 1.04; }
.muted { color: #a4a9b3; line-height: 1.25; }
.accent { color: #8fb4ff; font-weight: 600; line-height: 1.25; }
.foot { align-items: center; color: #6f7582; display: flex; font-size: 30px; justify-content: space-between; }
.bar { background: #8fb4ff; border-radius: 4px; height: 8px; width: 120px; }
`;

/** One slide as a whole HTML page. Every word is escaped: the facts are text, never markup. */
export const slideHtml = (slide: Slide, at: number, of: number, handle = "", embedFonts = true): string => `<!doctype html>
<html><head><meta charset="utf-8"><style>${slideCss(embedFonts)}</style></head>
<body><div class="slide ${slide.kind}">
<div class="label">${esc(slide.label)}</div>
<div class="lines">
${slide.lines.map((l) => `<div class="line ${l.tone}" style="font-size:${Math.round(l.size)}px">${esc(l.text)}</div>`).join("\n")}
</div>
<div class="foot"><span>${handle ? `@${esc(handle.replace(/^@+/, ""))}` : ""}</span><span>${at} / ${of}</span><span class="bar"></span></div>
</div></body></html>`;

const launch = async (): Promise<Browser> => {
  try {
    return await chromium.launch({ channel: "chrome", headless: true });
  } catch {
    /* no Chrome channel: try the paths */
  }
  for (const executablePath of [CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"].filter(Boolean)) {
    try {
      return await chromium.launch({ executablePath, headless: true });
    } catch {
      /* try the next */
    }
  }
  throw new Error("could not launch headless Chrome. Set CHROME_PATH in .env.");
};

export interface Kit {
  dir: string;
  files: string[];
}

/**
 * Write the kit: one JPEG per slide at 1080 by 1350, the caption, the plan it was drawn from,
 * and a note saying what to do with it. Refuses a folder that already holds something, so a
 * second run cannot silently replace slides you have already posted from.
 */
export const renderKit = async (plan: CarouselPlan, dir: string, handle = ""): Promise<Kit> => {
  if (plan.problems.length || !plan.slides.length) throw new Error(`nothing to render: ${plan.problems.join("; ") || "no slides"}`);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error(`${dir} already has files in it. Choose another folder with --out, or remove it.`);
  fs.mkdirSync(dir, { recursive: true });

  const files: string[] = [];
  const browser = await launch();
  try {
    const ctx = await browser.newContext({ deviceScaleFactor: 1, javaScriptEnabled: false, viewport: { height: SLIDE_HEIGHT, width: SLIDE_WIDTH } });
    const page = await ctx.newPage();
    for (let i = 0; i < plan.slides.length; i++) {
      await page.setContent(slideHtml(plan.slides[i], i + 1, plan.slides.length, handle), { waitUntil: "load" });
      await page.evaluate(() => document.fonts.ready.then(() => true)).catch(() => {});
      const file = path.join(dir, `slide-${String(i + 1).padStart(2, "0")}.jpg`);
      await page.screenshot({ path: file, quality: 92, type: "jpeg" });
      files.push(file);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const write = (name: string, text: string): void => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    files.push(file);
  };
  write("caption.txt", `${plan.caption}\n`);
  write("kit.json", `${JSON.stringify(plan, null, 2)}\n`);
  write(
    "README.txt",
    [
      "A draft carousel. Nothing has been posted or queued.",
      "",
      `Slides: slide-01.jpg to slide-${String(plan.slides.length).padStart(2, "0")}.jpg, 1080 x 1350 (4:5), in order.`,
      "Caption: caption.txt. Read both before you use them: the words came from a template and the facts you gave.",
      "",
      "To post it as a carousel, do it by hand in Instagram. AgentSpine's queue holds one image per",
      "post and cannot publish a carousel.",
      "",
      "To queue only the first slide as an ordinary feed post, add slide-01.jpg and the caption to your",
      "kit's instagram-posts.json and plan, host the image, and seed it (docs/INSTAGRAM.md, steps 3 to 6).",
      "It arrives as a pending row that you approve like any other.",
      "",
    ].join("\n"),
  );
  return { dir, files };
};
