/**
 * The gig carousel kit (src/carousel, PLAN-open-work section 14, U10).
 *
 * The plan is pure code, so every awkward gig is a case here: a venue name that runs long, a
 * five-act bill, no link, a bill too long for Instagram's ten images, facts that are missing.
 * The render test draws the example with headless Chrome and is skipped, with the reason
 * printed, where Chrome cannot be launched. Nothing here posts or queues anything, and a test
 * reads the source to keep it that way.
 *
 *   node test/carousel.test.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const { ACTS_PER_SLIDE, CAPTION_MAX, dayLine, LINE_MAX_CHARS, planCarousel, shownLink, sizeFor, SIZE_STEPS, SLIDE_HEIGHT, SLIDE_WIDTH, SLIDES_MAX } = await import("../src/carousel/plan.ts");
const { slideHtml } = await import("../src/carousel/render.ts");

let passed = 0;
let failed = 0;
const check = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(70)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
};

const REPO = path.dirname(import.meta.dirname);
const example = JSON.parse(fs.readFileSync(path.join(REPO, "src/carousel/example-gig.json"), "utf8"));
const gig = (over = {}) => ({ ...example, ...over });
const texts = (slide) => slide.lines.map((l) => l.text);

console.log("\nTHE DAY — worked out from the date alone, the same in every time zone");
for (const [date, want] of [
  ["2026-12-12", "Saturday 12 December"],
  ["2026-01-01", "Thursday 1 January"],
  ["2028-02-29", "Tuesday 29 February"],
  ["2027-02-29", null],
  ["2026-13-01", null],
  ["12/12/2026", null],
  ["", null],
]) {
  check(date || "(empty)", dayLine(date), want);
}

console.log("\nTHE EXAMPLE — three slides and a caption");
{
  const p = planCarousel(example);
  check("no problems", p.problems, []);
  check("cover, line-up, details", p.slides.map((s) => s.kind), ["cover", "lineup", "details"]);
  check("the cover leads with the day and the title", [p.slides[0].label, texts(p.slides[0])], ["Saturday 12 December", ["Low Lights", "House and disco, all night", "The Lantern Room, Springfield"]]);
  check("the line-up lists each act with its time", texts(p.slides[1]), ["Alex Chen", "21:00", "Sam Rivera", "23:00", "Jordan Lee", "01:00"]);
  check("the details end on the link, without its scheme", texts(p.slides[2]).at(-1), "example.com/low-lights");
  check("the caption carries the full link and only the tags given", [p.caption.includes("https://example.com/low-lights"), p.caption.endsWith("#house #disco #springfield")], [true, true]);
  check("the folder name is the date and the title", p.slug, "2026-12-12-low-lights");
  check("the same facts give the same plan", JSON.stringify(planCarousel(example)), JSON.stringify(p));
}

console.log("\nTYPE SIZE — the largest step that holds the text, down to a floor");
{
  check("steps run largest first", SIZE_STEPS.map((s) => s.size).every((v, i, a) => i === 0 || v < a[i - 1]), true);
  for (const s of SIZE_STEPS) {
    check(`${s.chars} characters fit at ${s.size}px`, sizeFor("x".repeat(s.chars)), s.size);
  }
  check("one character more drops a step", sizeFor("x".repeat(SIZE_STEPS[0].chars + 1)), SIZE_STEPS[1].size);
  check("past the last step the floor holds", sizeFor("x".repeat(500)), SIZE_STEPS.at(-1).size);
}

console.log("\nA LONG VENUE NAME — smaller, then cut, never off the slide");
{
  const long = "The Old Municipal Tramway Depot and Exhibition Hall, Lower East Quay Entrance, Second Floor Ballroom";
  const p = planCarousel(gig({ city: "", venue: long }));
  const where = p.slides[0].lines.at(-1).text;
  check("it is cut at the line limit with an ellipsis", [where.length, where.endsWith("…")], [LINE_MAX_CHARS, true]);
  check("the caption keeps the whole name", p.caption.includes(long), true);
  const longTitle = planCarousel(gig({ title: "An Evening of Slow Disco, Deep House and Whatever Else Turns Up" }));
  check("a long title takes a smaller size than a short one", longTitle.slides[0].lines[0].size < planCarousel(example).slides[0].lines[0].size, true);
  check("a line break in a fact cannot add a line", planCarousel(gig({ venue: "The Lantern\nRoom\tUpstairs" })).slides[0].lines.at(-1).text, "The Lantern Room Upstairs, Springfield");
}

console.log("\nA FIVE-ACT BILL — a second line-up slide, one size per slide");
{
  const five = ["Alex Chen", "Sam Rivera", "Jordan Lee", "Riley Park", "Casey Morgan and the Late Night Rhythm Section"].map((name) => ({ name }));
  const p = planCarousel(gig({ lineup: five }));
  check("four slides", p.slides.map((s) => s.kind), ["cover", "lineup", "lineup", "details"]);
  check("the labels count the pages", [p.slides[1].label, p.slides[2].label], ["Line-up 1 of 2", "Line-up 2 of 2"]);
  check(`${ACTS_PER_SLIDE} acts on the first, the fifth on the second`, [p.slides[1].lines.length, texts(p.slides[2])], [ACTS_PER_SLIDE, [five[4].name]]);
  check("acts on one slide share a size", new Set(p.slides[1].lines.map((l) => l.size)).size, 1);
  check("a long name sets a smaller size for its slide", p.slides[2].lines[0].size < p.slides[1].lines[0].size, true);
  check("an act with no name is left out", planCarousel(gig({ lineup: [{ name: " " }, { name: "Alex Chen" }] })).slides[1].lines.length, 1);

  const huge = planCarousel(gig({ lineup: Array.from({ length: 60 }, (_, i) => ({ name: `Act ${i + 1}` })) }));
  check(`a bill too long for Instagram stops at ${SLIDES_MAX} slides`, huge.slides.length, SLIDES_MAX);
  check("... and still ends on the details", huge.slides.at(-1).kind, "details");
  check("... and the caption stays inside the limit", huge.caption.length <= CAPTION_MAX, true);
}

console.log("\nNO LINK — no line about one");
{
  const p = planCarousel(gig({ link: undefined }));
  check("the details slide has no link line", p.slides.at(-1).lines.some((l) => l.tone === "accent"), false);
  check("the caption does not mention tickets", /Tickets|http/.test(p.caption), false);
  for (const [link, want] of [
    ["https://example.com/low-lights/", "example.com/low-lights"],
    ["http://example.com", "example.com"],
    ["javascript:alert(1)", ""],
    ["example.com", ""],
    ["https://example.com/a b", ""],
  ]) {
    check(`shown link for ${link}`, shownLink(link), want);
  }
  const bare = planCarousel({ date: "2026-12-12", lineup: [{ name: "Alex Chen" }], title: "Low Lights", venue: "The Lantern Room" });
  check("only the four required facts still makes a kit", [bare.problems, bare.slides.length, bare.caption], [[], 3, "Low Lights. Saturday 12 December at The Lantern Room.\n\nLine-up: Alex Chen."]);
}

console.log("\nMISSING FACTS — it says what is needed and draws nothing");
{
  check("nothing at all", planCarousel({}).problems.length, 4);
  check("no slides and no caption", [planCarousel({}).slides, planCarousel({}).caption], [[], ""]);
  check("a date that is not a day", planCarousel(gig({ date: "2027-02-29" })).problems, ['a date is needed, as "2026-12-12"']);
  check("an empty line-up", planCarousel(gig({ lineup: [] })).problems, ["the line-up needs at least one act"]);
  check("tags are cleaned, never invented", planCarousel(gig({ tags: ["#house", "deep house!", "", 7] })).caption.endsWith("#house #deephouse #7"), true);
}

console.log("\nTHE TEMPLATE — facts are text, never markup");
{
  const p = planCarousel(gig({ handle: "exampleshow", title: '<script>alert("x")</script> & co' }));
  const html = slideHtml(p.slides[0], 1, p.slides.length, "@exampleshow", false);
  check("markup in a fact is escaped", [html.includes("<script>"), html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; co")], [false, true]);
  check("the handle and the count are in the footer", [html.includes("@exampleshow"), html.includes("1 / 3")], [true, true]);
  check("the page is exactly Instagram's 4:5", [SLIDE_WIDTH, SLIDE_HEIGHT, html.includes(`width: ${SLIDE_WIDTH}px; height: ${SLIDE_HEIGHT}px`)], [1080, 1350, true]);
}

console.log("\nIT PUBLISHES NOTHING");
{
  const src = fs.readdirSync(path.join(REPO, "src/carousel")).filter((f) => f.endsWith(".ts")).map((f) => fs.readFileSync(path.join(REPO, "src/carousel", f), "utf8")).join("\n");
  check("no import from the Instagram code", /from "\.\.\/instagram\//.test(src), false);
  check("no network call and no model call", /fetch\(|https\.request|router\.ts|llm\.ts/.test(src), false);
}

console.log("\nTHE RENDER — real slides, where Chrome can be launched");
{
  const { renderKit } = await import("../src/carousel/render.ts");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentspine-carousel-"));
  const out = path.join(dir, "kit");
  try {
    const kit = await renderKit(planCarousel(example), out, example.handle);
    const names = fs.readdirSync(out).sort();
    check("three slides, the caption, the plan and the note", names, ["README.txt", "caption.txt", "kit.json", "slide-01.jpg", "slide-02.jpg", "slide-03.jpg"]);
    // A JPEG's size is in its SOF0 or SOF2 segment: find it and read the two big-endian numbers.
    const jpeg = fs.readFileSync(path.join(out, "slide-01.jpg"));
    let at = 2;
    let size = null;
    while (at < jpeg.length - 9) {
      const marker = jpeg[at + 1];
      if (marker === 0xc0 || marker === 0xc2) {
        size = [jpeg.readUInt16BE(at + 7), jpeg.readUInt16BE(at + 5)];
        break;
      }
      at += 2 + jpeg.readUInt16BE(at + 2);
    }
    check("each slide is a 1080 by 1350 JPEG", [jpeg[0] === 0xff && jpeg[1] === 0xd8, size], [true, [1080, 1350]]);
    check("it is under Instagram's 8 MB", jpeg.length < 8_000_000, true);
    check("the caption file is the planned caption", fs.readFileSync(path.join(out, "caption.txt"), "utf8").trim(), planCarousel(example).caption);
    check("the note says nothing was posted", /Nothing has been posted or queued/.test(fs.readFileSync(path.join(out, "README.txt"), "utf8")), true);
    check("it reports the files it wrote", kit.files.length, 6);
    let refused = "";
    try {
      await renderKit(planCarousel(example), out);
    } catch (err) {
      refused = err.message;
    }
    check("a second run into the same folder is refused", /already has files/.test(refused), true);
  } catch (err) {
    console.log(`  SKIP  the render did not run: ${String(err?.message ?? err).split("\n")[0]}`);
  } finally {
    fs.rmSync(dir, { force: true, recursive: true });
  }
  let nothing = "";
  try {
    await renderKit(planCarousel({}), path.join(os.tmpdir(), "agentspine-carousel-none"));
  } catch (err) {
    nothing = err.message;
  }
  check("a plan with problems is never rendered", /nothing to render/.test(nothing), true);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
