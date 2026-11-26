/**
 * A gig carousel from a terminal:  npm run carousel -- <facts.json> [--out <folder>] [--plan]
 *
 *   <facts.json>   The gig: title, date, venue, line-up, and optionally city, doors, price, link,
 *                  tagline, handle, tags. src/carousel/example-gig.json is one to copy.
 *   --out          Where the kit goes. Default: drafts/carousel/<date>-<title>. It must be empty.
 *   --plan         Print the slides and the caption and write nothing. No Chrome needed.
 *
 * It draws slides and writes a caption into a folder. It posts nothing and queues nothing.
 */
import fs from "node:fs";
import path from "node:path";
import { planCarousel } from "./plan.ts";
import type { GigFacts } from "./plan.ts";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--out");
const outAt = args.indexOf("--out");

if (!file) {
  console.error("usage: npm run carousel -- <facts.json> [--out <folder>] [--plan]");
  process.exit(1);
}

let facts: GigFacts;
try {
  facts = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (err) {
  console.error(`Could not read ${file}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const plan = planCarousel(facts);
if (plan.problems.length) {
  console.error(`Not enough to make a carousel: ${plan.problems.join("; ")}.`);
  process.exit(1);
}

if (args.includes("--plan")) {
  plan.slides.forEach((s, i) => {
    console.log(`\nSlide ${i + 1} (${s.kind}) — ${s.label}`);
    for (const l of s.lines) console.log(`  ${String(l.size).padStart(3)}px ${l.tone.padEnd(6)} ${l.text}`);
  });
  console.log(`\nCaption (${plan.caption.length} characters):\n${plan.caption}`);
} else {
  const { renderKit } = await import("./render.ts");
  const dir = path.resolve(outAt >= 0 && args[outAt + 1] ? args[outAt + 1] : path.join("drafts", "carousel", plan.slug));
  try {
    const kit = await renderKit(plan, dir, String(facts.handle ?? ""));
    console.log(`Wrote ${plan.slides.length} slides and a caption to ${kit.dir}`);
    console.log("Nothing was posted or queued. README.txt in that folder says what to do next.");
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
