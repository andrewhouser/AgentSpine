/**
 * Image generation via the local MFLUX service (see IMAGE_GENERATION.md, services/mflux/).
 *
 * The service speaks OpenAI's image spec on purpose, so the client is the same
 * `clientFor(url).images.generate()` every chat tier uses — no new transport. It runs on
 * THIS machine (the app host), never the model host: an image render pages the language
 * models out of memory and costs the next chat request 30-60s. That placement is the whole
 * reason the service exists, so this tool must only ever point at the local IMAGE_URL.
 *
 * Two things this tool is careful about:
 *
 *   1. It returns a URL, never the image bytes. A 512px PNG is ~380KB of base64 — feeding
 *      that back into the model's context would blow the window on a single call and cost a
 *      fortune in tokens for something the model cannot even see. So the PNG is written to
 *      disk (IMAGES_DIR, served by src/server.ts at /images/) and only the served path comes
 *      back as text. That path is stable, which is why the image survives a page reload.
 *
 *   2. It does not hardcode a model id. The service hosts one pipeline and advertises it via
 *      /v1/models; a hardcoded id in a client is exactly the mistake MODELS.md documents (a
 *      stale id served the wrong model for 26 days). `images.generate` requires SOME model
 *      field, so the id is discovered from the endpoint at call time, not baked in.
 *
 * Reversible: it writes a new file under a directory it owns and touches nothing else. But
 * the prompt is model-authored and the effect is a file on disk, so it is gated behind an
 * explicit policy surface rather than left on by default.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { clientFor } from "../llm.ts";
import { IMAGE_BASE_URL, IMAGES_DIR } from "../config.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

interface Args {
  prompt?: string;
  /** "512x512" (default) or "768x768". Larger is clamped down — 768 is the host ceiling. */
  size?: string;
}

/**
 * Sizes the service will actually render. The MFLUX ceiling is MFLUX_MAX_SIDE=768 on this
 * 16GB host (measured: 512px peaks 6.13GB, 768px 7.75GB); it returns a 400 for anything
 * larger. Rather than let that surface as an opaque error, a request above the ceiling is
 * clamped down to the largest size that fits — the OpenAI images API has no notion of a
 * per-server ceiling for the model to have known about.
 */
const DEFAULT_SIZE = "512x512";
const MAX_SIDE = 768;

/** Parse "WxH", clamp each side into (0, MAX_SIDE], snap to /16 as MFLUX requires. */
const clampSize = (raw?: string): string => {
  const m = String(raw ?? "").trim().toLowerCase().match(/^(\d+)\s*x\s*(\d+)$/);
  if (!m) return DEFAULT_SIZE;
  const snap = (n: number): number => {
    const clamped = Math.min(MAX_SIDE, Math.max(16, n));
    return Math.floor(clamped / 16) * 16;
  };
  const w = snap(Number(m[1]));
  const h = snap(Number(m[2]));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return DEFAULT_SIZE;
  return `${w}x${h}`;
};

/** Discover the served model id from the endpoint instead of hardcoding one (MODELS.md). */
const discoverModel = async (client: ReturnType<typeof clientFor>): Promise<string> => {
  try {
    const list = await client.models.list();
    const first = list.data?.[0]?.id;
    if (first) return first;
  } catch {
    /* fall through — the generate call carries a harmless placeholder the service ignores */
  }
  return "mflux";
};

export const generateImage: Tool = {
  name: "generate_image",
  description:
    "Generate an image from a text prompt and save it, returning a URL to the saved PNG. " +
    "Use when the user asks you to draw, create, or generate a picture/image/illustration. " +
    "Describe the subject, style, and composition in the prompt as fully as you can — this " +
    "is a small fast model, so a concrete prompt matters. Sizes: '512x512' (default, faster) " +
    "or '768x768' (more detail, slower). A render takes 15-30s, and the first one after a " +
    "quiet spell up to ~20s longer while the pipeline loads. The result is a URL, not the " +
    "image data; hand it back to the user as a Markdown image so it displays.",
  argsSchema: '{ "prompt": string, "size"?: "512x512" | "768x768" }',

  classify: (a: Args): ClassifiedAction => ({
    // Writing a new PNG into a directory this tool owns is reversible — it deletes cleanly
    // and overwrites nothing. The gate is the policy surface, not the reversibility class.
    reversibility: "reversible",
    // Keyed like weather's endpoint target: one surface the allowlist and audit log key on.
    target: "generate_image",
    summary: `Generate a ${clampSize(a?.size)} image: ${String(a?.prompt ?? "").slice(0, 80) || "(no prompt)"}`,
  }),

  checkPolicy: (policy: Policy): PolicyDecision => {
    // Deny-by-default, like every optional surface: absent section = denied.
    if (!policy.images?.enabled) {
      return {
        allowed: false,
        reason:
          "policy.images.enabled is not set (deny by default). Image generation runs a " +
          "local model that writes PNG files to disk from a model-authored prompt; enable " +
          'with "images": { "enabled": true } in policy.json.',
      };
    }
    // A no-op endpoint is a misconfiguration, not a grant. Fail here rather than letting the
    // OpenAI client throw an obscure connection error deep in run().
    if (!IMAGE_BASE_URL) {
      return {
        allowed: false,
        reason:
          "IMAGE_URL is not set in .env, so there is no image service to call. Point it at " +
          "the local MFLUX service (e.g. http://127.0.0.1:8082/v1) — see IMAGE_GENERATION.md.",
      };
    }
    return { allowed: true, reason: "policy.images.enabled is true and IMAGE_URL is set" };
  },

  run: async (a: Args): Promise<string> => {
    const prompt = String(a?.prompt ?? "").trim();
    if (!prompt) return "ERROR: generate_image needs a non-empty prompt.";
    if (!IMAGE_BASE_URL) return "ERROR: IMAGE_URL is not configured; cannot reach the image service.";

    const size = clampSize(a?.size);

    // "not-needed": the local service has no auth. Same keyless posture as the local tiers.
    const client = clientFor(IMAGE_BASE_URL, "not-needed");

    try {
      const model = await discoverModel(client);
      const res = await client.images.generate(
        {
          model,
          prompt,
          // The SDK's size union predates our 768 option and does not include it; the local
          // service validates size itself, so cast past the SDK's narrower literal type.
          size: size as never,
          response_format: "b64_json",
        },
        // A render is 15-30s and the first after idle adds a cold load. Give it generous
        // headroom so the request is not killed mid-generation. (The client default is 10
        // minutes; this is explicit for the reader.)
        { timeout: 120_000 },
      );

      const b64 = res.data?.[0]?.b64_json;
      if (!b64) return "ERROR: the image service returned no image data.";

      // A collision-proof name; the prompt is model text and has no business in the path.
      const name = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${randomUUID().slice(0, 8)}.png`;
      const file = path.join(IMAGES_DIR, name);

      fs.mkdirSync(IMAGES_DIR, { recursive: true });
      fs.writeFileSync(file, Buffer.from(b64, "base64"));

      // The served URL, NOT the bytes — see the header note on context cost. server.ts
      // serves IMAGES_DIR at /images/, and this path is stable across reloads and rebuilds.
      const url = `/images/${name}`;
      return `Generated a ${size} image and saved it. Show it to the user with this Markdown: ![generated image](${url})`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `ERROR: image generation failed: ${msg}`;
    }
  },
};
