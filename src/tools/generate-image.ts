/**
 * Image generation via the local MFLUX service (see docs/IMAGE_GENERATION.md, services/mflux/).
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
 *      /v1/models; a hardcoded id in a client is exactly the mistake docs/MODELS.md documents (a
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
import { COMFY_MODEL, COMFY_URL, COMFY_WORKFLOW, IMAGE_BASE_URL, IMAGES_DIR } from "../config.ts";
import { readAttachment } from "../attachments.ts";
import { freeComfy, renderWithComfy, STYLES } from "../comfy.ts";
import { publish } from "../events.ts";
import * as store from "../memory/store.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool, ToolContext } from "../types.ts";

interface Args {
  /** ComfyUI only: "photorealistic" (default), "painting" or "illustration". */
  style?: string;
  /** "draft" = MFLUX (fast), "best" = ComfyUI. Only meaningful when both are configured. */
  quality?: string;
  /** Start from this picture: an attachment id, or a /images/ URL from this conversation. */
  source_image?: number | string;
  /** How far an edit may move from the source: "subtle", "moderate" (default) or "strong". */
  change?: string;
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
// ComfyUI runs on a machine with room for a full-size render (Z-Image Turbo and SDXL are
// both native at ~1024), so its default and ceiling are larger than MFLUX's.
const DEFAULT_SIZE = "512x512";
const MAX_SIDE = 768;

const ASKED_FOR_DRAFT = /\bdraft\b|\bquickly\b|\b(quick|rough|fast)\s+(version|image|picture|sketch|render|mock-?up|one)\b/i;

/**
 * Which backend serves a request. quality "draft" is MFLUX (about 35 s, 768px max, weaker at
 * exact subjects); "best" is ComfyUI (minutes, 1024px, a tuned photoreal checkpoint). Measured
 * 2026-11-23 on the 16 GB Mini. When only one is configured it serves everything; when both
 * are, an unspecified quality means best. Code picks, so the model never sees a URL.
 */
export const pickBackend = (quality?: string, goal?: string): "comfy" | "mflux" => {
  if (!COMFY_URL) return "mflux";
  if (!IMAGE_BASE_URL) return "comfy";
  // Read off the user's own words too. Observed 2026-11-23: asked for "a quick rough draft", the
  // model left quality out and the user would have waited seven minutes for a sketch. Narrow on
  // purpose, so "a fast car" or "rough seas" are still subjects and not a speed request.
  const asked = quality ?? (ASKED_FOR_DRAFT.test(goal ?? "") ? "draft" : "best");
  return String(asked).toLowerCase() === "draft" ? "mflux" : "comfy";
};
const BOTH = Boolean(COMFY_URL && IMAGE_BASE_URL);

// Code owns the numbers. ComfyUI denoise: how much of the source is redrawn. Below ~0.3 an edit
// barely shows; above ~0.8 the composition is gone and it is a new picture.
const CHANGE: Record<string, number> = { subtle: 0.35, moderate: 0.55, strong: 0.75 };

const hasSource = (a?: Args): boolean => a?.source_image !== undefined && a?.source_image !== null && a?.source_image !== "";

const isLoopback = (url: string): boolean => {
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname);
  } catch {
    return false;
  }
};

/**
 * The bytes of a source picture, or the reason there are none. Same structural gate as
 * look_at_image: the source must belong to the CURRENT run's conversation, read from the ledger,
 * so an id or URL invented by the model or lifted from a page reaches nothing. One message for
 * "no such image" and "not yours" so a model cannot enumerate other threads.
 */
export const resolveSource = (raw: number | string, runId: null | number | undefined): Buffer | string => {
  const conversationId = runId == null ? null : (store.getRun(runId)?.conversation_id ?? null);
  if (conversationId == null) return "ERROR: this run has no conversation, so it has no source image to edit.";
  const missing = `ERROR: there is no image ${raw} in this conversation.`;
  const text = String(raw).trim();
  const named = text.match(/\/images\/([A-Za-z0-9._-]+\.png)/)?.[1];
  if (named) {
    if (named.includes("..") || !store.conversationMentions(conversationId, `/images/${named}`)) return missing;
    const file = path.join(IMAGES_DIR, named);
    return fs.existsSync(file) ? fs.readFileSync(file) : missing;
  }
  const id = Number(text.replace(/^#/, ""));
  if (!Number.isInteger(id) || id <= 0) return missing;
  const row = store.getAttachment(id);
  if (!row || row.conversation_id !== conversationId) return missing;
  return readAttachment(row) ?? missing;
};

/** Parse "WxH", clamp each side into (0, MAX_SIDE], snap to /16 as MFLUX requires. */
const clampSize = (raw?: string, backend: "comfy" | "mflux" = "mflux"): string => {
  const maxSide = backend === "comfy" ? 1536 : MAX_SIDE;
  const dflt = backend === "comfy" ? "1024x1024" : DEFAULT_SIZE;
  const m = String(raw ?? "").trim().toLowerCase().match(/^(\d+)\s*x\s*(\d+)$/);
  if (!m) return dflt;
  const snap = (n: number): number => {
    const clamped = Math.min(maxSide, Math.max(16, n));
    return Math.floor(clamped / 16) * 16;
  };
  const w = snap(Number(m[1]));
  const h = snap(Number(m[2]));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return dflt;
  return `${w}x${h}`;
};

/** Discover the served model id from the endpoint instead of hardcoding one (docs/MODELS.md). */
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
    "is a local model, so a concrete prompt matters. " +
    (BOTH
      ? "Use quality 'draft' only when the user asks for something quick or rough; otherwise leave it out. "
      : "") +
    (COMFY_URL
      ? "To change an existing picture, pass source_image (an image id from this conversation, or " +
        "the /images/ URL of an earlier result), describe the whole desired picture in prompt, and " +
        "set change to 'subtle', 'moderate' or 'strong'. A best-quality render can take several minutes. "
      : "Sizes: '512x512' (default, faster) or '768x768' (more detail, slower). A render takes 15-30s. ") +
    "The result is a URL, not the image data; hand it back to the user as a Markdown image so it displays.",
  argsSchema: COMFY_URL
    ? '{ "prompt": string, ' +
      (BOTH ? '"quality"?: "draft" (fast, ~35s, may get details wrong) | "best" (default, slower, more accurate), ' : "") +
      '"style"?: "photorealistic" | "painting" | "illustration", "size"?: "WxH, e.g. 1024x1024 or 1344x768 (landscape)", "source_image"?: number | "/images/name.png", "change"?: "subtle" | "moderate" | "strong" }'
    : '{ "prompt": string, "size"?: "512x512" | "768x768" }',

  classify: (a: Args): ClassifiedAction => ({
    // Writing a new PNG into a directory this tool owns is reversible — it deletes cleanly
    // and overwrites nothing. The gate is the policy surface, not the reversibility class.
    reversibility: "reversible",
    // Keyed like weather's endpoint target: one surface the allowlist and audit log key on.
    target: "generate_image",
    summary: `${hasSource(a) ? `Edit image ${a?.source_image} as a` : "Generate a"} ${clampSize(a?.size, hasSource(a) ? "comfy" : pickBackend(a?.quality))} image: ${String(a?.prompt ?? "").slice(0, 80) || "(no prompt)"}`,
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
    if (!IMAGE_BASE_URL && !COMFY_URL) {
      return {
        allowed: false,
        reason:
          "IMAGE_URL is not set in .env, so there is no image service to call. Point it at " +
          "the local MFLUX service (e.g. http://127.0.0.1:8082/v1) — see docs/IMAGE_GENERATION.md.",
      };
    }
    return { allowed: true, reason: "policy.images.enabled is true and IMAGE_URL is set" };
  },

  run: async (a: Args, ctx: ToolContext): Promise<string> => {
    const prompt = String(a?.prompt ?? "").trim();
    if (!prompt) return "ERROR: generate_image needs a non-empty prompt.";
    if (!IMAGE_BASE_URL && !COMFY_URL) return "ERROR: IMAGE_URL is not configured; cannot reach the image service.";

    // Editing needs ComfyUI whatever quality was asked for: MFLUX here is text-to-image only.
    const editing = hasSource(a);
    if (editing && !COMFY_URL) return "ERROR: editing an image needs ComfyUI, and COMFY_URL is not set.";
    // A user's photo stays on this machine, whatever COMFY_URL is later pointed at.
    if (editing && !isLoopback(COMFY_URL)) return "ERROR: refusing to send a source image to a ComfyUI that is not on this machine.";
    const backend = editing ? "comfy" : pickBackend(a?.quality, ctx?.run?.goal);
    const size = clampSize(a?.size, backend);
    const source = editing ? resolveSource(a.source_image as number | string, ctx?.runId) : undefined;
    if (typeof source === "string") return source;

    // The two pipelines do not fit in 16 GB together, so each asks the other to let go first.
    if (backend === "comfy" && IMAGE_BASE_URL) {
      await fetch(`${IMAGE_BASE_URL.replace(/\/v1\/?$/, "")}/unload`, { method: "POST", signal: AbortSignal.timeout(5_000) }).catch(() => {});
    }
    if (backend === "mflux" && COMFY_URL) await freeComfy(COMFY_URL);

    if (backend === "comfy") {
      try {
        const [width, height] = size.split("x").map(Number) as [number, number];
        // An edit keeps the source's look unless a style was asked for; forcing "photorealistic"
        // onto someone's painting would fight the picture they asked to keep.
        const style =
          editing && !a?.style
            ? { suffix: "", negative: "watermark, text, lowres" }
            : (STYLES[String(a?.style ?? "photorealistic").toLowerCase()] ?? STYLES.photorealistic!);
        // Submit, poll until ComfyUI reports done (a cold model load can take a minute or two),
        // then write the PNG ourselves so it is served from /images/ like every other result.
        const png = await renderWithComfy({
          baseUrl: COMFY_URL,
          model: COMFY_MODEL,
          kind: COMFY_WORKFLOW,
          prompt: prompt + style.suffix,
          negative: style.negative,
          width,
          height,
          // A cold 1024px SDXL render measured 218 s on a quiet 16 GB Mini and about 450 s with
          // 13 GB already in swap, which is too close to any shorter limit.
          timeoutMs: 900_000,
          source,
          denoise: CHANGE[String(a?.change ?? "moderate").toLowerCase()] ?? CHANGE.moderate,
          onProgress: (label) => publish(ctx?.runId ?? null, { label, tool: "generate_image", type: "tool_progress" }),
        });
        const name = `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${randomUUID().slice(0, 8)}.png`;
        fs.mkdirSync(IMAGES_DIR, { recursive: true });
        fs.writeFileSync(path.join(IMAGES_DIR, name), png);
        return `Generated a ${size} image and saved it. Show it to the user with this Markdown: ![generated image](/images/${name})`;
      } catch (err) {
        return `ERROR: image generation failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

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
