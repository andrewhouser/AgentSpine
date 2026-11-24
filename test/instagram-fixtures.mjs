/**
 * Shared pieces for the test/instagram-*.test.mjs suites. Not a suite itself.
 *
 * Nothing here imports from src/, because each suite has to set SPINE_DB_PATH and the config
 * directory before the first src/ module loads. Nothing here touches the network either: Meta
 * is `fakeClient`, and the image host and the stream status page are `fakeFetch`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Point every path the Instagram code reads at a throwaway directory. Call before importing src/. */
export const isolate = (name) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `agentspine-${name}-`));
  process.env.SPINE_DB_PATH = path.join(root, "t.db");
  process.env.AGENTSPINE_CONFIG_DIR = path.join(root, "config");
  process.env.INSTAGRAM_TOKEN_PATH = path.join(root, "config", "instagram-token.json");
  process.env.EMBEDDINGS_URL = "";
  return root;
};

export const checker = (width = 62) => {
  const state = { failed: 0, passed: 0 };
  const check = (label, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    ok ? state.passed++ : state.failed++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(width)} ${ok ? "" : `${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`}`);
  };
  const done = () => {
    console.log(`\n${state.passed} passed, ${state.failed} failed\n`);
    process.exit(state.failed ? 1 : 0);
  };
  return { check, done };
};

/** The smallest byte string with a JPEG start marker and a frame header saying `w` by `h`. */
export const jpeg = (w, h, fill = 0) =>
  Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 255, w >> 8, w & 255, 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1]),
    Buffer.alloc(32, fill),
    Buffer.from([0xff, 0xd9]),
  ]);

export const ACCOUNT = "exampleshow";
export const BASE_URL = "https://media.example.test/kit/";
export const LIVE_URL = "https://show.example.test/api/status";

/**
 * A marketing kit on disk, in the shape of djlive/docs/marketing: a posts file and its images.
 * `approved: true` is set on purpose, to prove the import ignores it.
 */
export const makeKit = (root) => {
  const kitDir = path.join(root, "kit");
  fs.mkdirSync(path.join(kitDir, "images", "stories"), { recursive: true });
  const files = {
    "images/evergreen.jpg": jpeg(1080, 1350, 1),
    "images/friday.jpg": jpeg(1080, 1350, 2),
    "images/live.jpg": jpeg(1080, 1350, 3),
    "images/stories/friday-story.jpg": jpeg(1080, 1920, 4),
    "images/stories/live-story.jpg": jpeg(1080, 1920, 5),
    "images/wide.jpg": jpeg(3000, 1000, 6),
  };
  for (const [rel, bytes] of Object.entries(files)) fs.writeFileSync(path.join(kitDir, rel), bytes);
  fs.writeFileSync(path.join(kitDir, "images", "not-a-jpeg.jpg"), Buffer.from("PNG pretending"));
  const file = {
    account: ACCOUNT,
    posts: [
      { approved: true, caption: "Every Friday at 7 PM Eastern.\n\nLink in bio. #breaks #house", id: "E1", image: "images/evergreen.jpg", kind: "evergreen", release_condition: null, story_image: null },
      { approved: true, caption: "It's Friday.", id: "F1", image: "images/friday.jpg", kind: "showday", release_condition: "Fridays only.", story_image: "images/stories/friday-story.jpg" },
      { approved: true, caption: "Live now.", id: "L1", image: "images/live.jpg", kind: "showday", release_condition: "Only once the stream is actually up.", story_image: "images/stories/live-story.jpg" },
      { caption: "Wide.", id: "W1", image: "images/wide.jpg", kind: "evergreen", story_image: null },
      { caption: "Fake.", id: "N1", image: "images/not-a-jpeg.jpg", kind: "evergreen", story_image: null },
      { caption: "Gone.", id: "G1", image: "images/missing.jpg", kind: "evergreen", story_image: null },
      { caption: "x".repeat(2201), id: "LONG", image: "images/evergreen.jpg", kind: "evergreen", story_image: null },
    ],
    timezone: "America/New_York",
  };
  return { file, files, kitDir };
};

/**
 * Stands in for the image host and the stream status page. `images` maps a URL to bytes;
 * `live` is the stream state the status page reports, or an Error to throw.
 */
export const fakeFetch = (o = {}) => {
  const calls = [];
  const f = async (url) => {
    calls.push(url);
    if (url === LIVE_URL) {
      if (f.live instanceof Error) throw f.live;
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: { state: f.live } }) };
    }
    const bytes = f.images[url];
    if (!bytes) return { ok: false, status: 404, text: async () => "" };
    return {
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      headers: { get: (n) => (n.toLowerCase() === "content-type" ? (f.contentType ?? "image/jpeg") : null) },
      ok: true,
      status: 200,
      text: async () => "",
    };
  };
  f.calls = calls;
  f.images = o.images ?? {};
  f.live = o.live ?? "offline";
  return f;
};

/** The hosted copy of every kit image, as fakeFetch wants it. */
export const hosted = (files) => Object.fromEntries(Object.entries(files).map(([rel, bytes]) => [BASE_URL + rel, bytes]));

/**
 * Stands in for Meta. Every method records its call; each can be replaced per test. The
 * defaults describe a healthy account: the right username, quota to spare, containers that are
 * FINISHED at once, and a publish that returns a new media id.
 */
export const fakeClient = (over = {}) => {
  const calls = [];
  let n = 0;
  const base = {
    containerStatus: async () => ({ detail: null, statusCode: "FINISHED" }),
    createImageContainer: async () => `C${++n}`,
    me: async () => ({ accountType: "Business", userId: "1784", username: ACCOUNT }),
    media: async (id) => ({ id, mediaType: "IMAGE", permalink: `https://www.instagram.com/p/${id}/`, timestamp: null }),
    mediaInsights: async (_id, metrics) => Object.fromEntries(metrics.map((m) => [m, 1])),
    publishContainer: async () => `M${++n}`,
    publishingLimit: async () => ({ durationSec: 86400, total: 50, used: 0 }),
    recentMedia: async () => [],
    recentStories: async () => [],
    refreshToken: async () => ({ accessToken: "refreshed-token", expiresInSec: 5183944 }),
  };
  const client = { calls, count: (name) => calls.filter((c) => c.name === name).length };
  for (const name of Object.keys(base)) {
    client[name] = async (...args) => {
      calls.push({ args, name });
      return (client.over[name] ?? base[name])(...args);
    };
  }
  client.over = { ...over };
  return client;
};
