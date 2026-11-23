// ComfyUI backend for generate_image.
//
// The user never sees a graph. The model writes a plain-language prompt; this file owns the
// workflow (code owns the numbers: steps, cfg, sampler, size caps), submits it, polls
// /history until it finishes, and returns the PNG bytes. ComfyUI's API is: POST /prompt
// -> { prompt_id }; GET /history/{id} is {} until the job is done, then holds the outputs;
// GET /view fetches an output file.
//
// Two workflow families, chosen by the model filename in COMFY_MODEL:
//   - "zimage": Z-Image Turbo (a diffusion_models file; needs the qwen_3_4b text encoder and
//     ae VAE). 8 steps at cfg 1, the settings the model was distilled for.
//   - "sdxl":   any SDXL checkpoint from models/checkpoints.

import { randomInt } from "node:crypto";

export type ComfyWorkflowKind = "zimage" | "sdxl";

export interface ComfyOptions {
  baseUrl: string;
  model: string;
  kind: ComfyWorkflowKind;
  prompt: string;
  negative?: string;
  width: number;
  height: number;
  /** Total time to wait for the render, including a cold model load. */
  timeoutMs?: number;
  pollMs?: number;
}

type Node = { class_type: string; inputs: Record<string, unknown> };
export type Graph = Record<string, Node>;

// Prompt text is model-authored, so it only ever goes into a text input, never into the graph
// structure. The seed is random per render: same sentence, a fresh picture each time.
export function buildGraph(o: Omit<ComfyOptions, "baseUrl" | "timeoutMs" | "pollMs">): Graph {
  const seed = randomInt(0, 2 ** 31);
  const negative = o.negative ?? "";
  if (o.kind === "zimage") {
    return {
      "1": { class_type: "UNETLoader", inputs: { unet_name: o.model, weight_dtype: "default" } },
      "2": { class_type: "CLIPLoader", inputs: { clip_name: "qwen_3_4b.safetensors", type: "lumina2", device: "default" } },
      "3": { class_type: "VAELoader", inputs: { vae_name: "ae.safetensors" } },
      "4": { class_type: "ModelSamplingAuraFlow", inputs: { model: ["1", 0], shift: 3 } },
      "5": { class_type: "CLIPTextEncode", inputs: { text: o.prompt, clip: ["2", 0] } },
      "6": { class_type: "CLIPTextEncode", inputs: { text: negative, clip: ["2", 0] } },
      "7": { class_type: "EmptySD3LatentImage", inputs: { width: o.width, height: o.height, batch_size: 1 } },
      "8": {
        class_type: "KSampler",
        inputs: {
          model: ["4", 0], positive: ["5", 0], negative: ["6", 0], latent_image: ["7", 0],
          seed, steps: 8, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1,
        },
      },
      "9": { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } },
      "10": { class_type: "SaveImage", inputs: { images: ["9", 0], filename_prefix: "agentspine" } },
    };
  }
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: o.model } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: o.prompt, clip: ["1", 1] } },
    "3": { class_type: "CLIPTextEncode", inputs: { text: negative, clip: ["1", 1] } },
    "4": { class_type: "EmptyLatentImage", inputs: { width: o.width, height: o.height, batch_size: 1 } },
    "5": {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0], positive: ["2", 0], negative: ["3", 0], latent_image: ["4", 0],
        seed, steps: 28, cfg: 6, sampler_name: "dpmpp_2m", scheduler: "karras", denoise: 1,
      },
    },
    "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
    "7": { class_type: "SaveImage", inputs: { images: ["6", 0], filename_prefix: "agentspine" } },
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function json(res: Response): Promise<any> {
  const text = await res.text();
  if (!res.ok) throw new Error(`ComfyUI ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : {};
}

/** Submit, poll, fetch. Returns PNG bytes. Throws with ComfyUI's own node error on a bad graph. */
export async function renderWithComfy(o: ComfyOptions): Promise<Buffer> {
  const base = o.baseUrl.replace(/\/+$/, "");
  const deadline = Date.now() + (o.timeoutMs ?? 300_000);
  const graph = buildGraph(o);

  const sub = await json(
    await fetch(`${base}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: graph }),
      signal: AbortSignal.timeout(15_000),
    }),
  );
  const id = String(sub.prompt_id ?? "");
  if (!id) throw new Error("ComfyUI did not return a prompt_id");

  while (Date.now() < deadline) {
    await sleep(o.pollMs ?? 1000);
    // A box under memory pressure (a 12 GB model on a 16 GB Mac) can leave ComfyUI unable to
    // answer a status check for tens of seconds. That is a slow render, not a failed one, so a
    // poll that times out or drops is retried until the overall deadline. Measured 2026-11-23:
    // Z-Image bf16 at 1024px stalled the server past the old 15s limit and killed a healthy job.
    let hist: any;
    try {
      hist = await json(await fetch(`${base}/history/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(60_000) }));
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("ComfyUI ")) throw err; // a real HTTP error
      continue;
    }
    const entry = hist[id];
    if (!entry) continue; // still queued or running
    const status = entry.status?.status_str;
    if (status === "error") {
      const msgs = (entry.status?.messages ?? []).filter((m: unknown[]) => m[0] === "execution_error");
      throw new Error(`ComfyUI render failed: ${JSON.stringify(msgs[0]?.[1]?.exception_message ?? "see ComfyUI log").slice(0, 300)}`);
    }
    for (const out of Object.values<any>(entry.outputs ?? {})) {
      const img = out.images?.[0];
      if (!img) continue;
      const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? "", type: img.type ?? "output" });
      const res = await fetch(`${base}/view?${q}`, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) throw new Error(`ComfyUI /view ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    }
    if (status === "success") throw new Error("ComfyUI finished but produced no image");
  }
  // Best effort: free the queue slot so a stuck job does not block the next request.
  await fetch(`${base}/interrupt`, { method: "POST" }).catch(() => {});
  throw new Error(`ComfyUI render did not finish in ${Math.round((o.timeoutMs ?? 300_000) / 1000)}s`);
}

// Style words the model can pick; the code expands them so the model never needs to know
// checkpoint-specific prompt tricks. Photorealistic is the default the user asked for.
export const STYLES: Record<string, { suffix: string; negative: string }> = {
  photorealistic: {
    suffix: ", photorealistic, natural lighting, high detail, sharp focus, 35mm photograph",
    negative: "painting, illustration, cartoon, cgi, 3d render, watermark, text, lowres, blurry",
  },
  painting: { suffix: ", oil painting, visible brushwork, rich color", negative: "photo, watermark, text, lowres" },
  illustration: { suffix: ", detailed digital illustration, clean lines", negative: "photo, watermark, text, lowres" },
};
