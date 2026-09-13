/**
 * Uploaded images — where the bytes go, and what is trusted about them.
 *
 * ## The type is sniffed, never believed
 *
 * A browser sends a `Content-Type` with its upload and the file picker sends a filename,
 * and neither is evidence. Both are attacker-chosen in the case that matters: a page open
 * in another tab can POST to this server, and the dashboard's token is the only thing
 * standing between it and this route. So the format is decided by the first bytes of the
 * file and nothing else, the stored name is sanitised to a label, and a file whose magic
 * number is not an image this system can read is refused before it is written anywhere.
 *
 * The extension on disk comes from the sniff too, so a file's name can never disagree with
 * its content — which is what turns "an image upload directory" into something that can be
 * served back out without a second thought.
 *
 * ## HEIC is converted, because a phone photograph is the whole point
 *
 * The use this was built for is pointing a camera at something and asking about it, and on
 * an iPhone that produces HEIC. Pillow — which `mlx_vlm` decodes with — cannot read HEIC
 * without `pillow-heif`, and the failure is a decoder error deep in the serving stack rather
 * than anything a user could act on. macOS ships `sips`, which converts it in about 100ms,
 * so the conversion happens here at the boundary and everything downstream sees a JPEG.
 * A machine without `sips` gets a clear refusal naming HEIC, not a stack trace.
 *
 * ## Bytes on disk, metadata in the ledger
 *
 * `spine.db` is pruned on a schedule and read by hand with `sqlite3`; a few megabytes of
 * photograph per turn would spoil both. The row in `attachments` holds the path, the size,
 * and later the description; this module owns the file.
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import { ATTACHMENTS_DIR, VISION_MAX_BYTES, VISION_MAX_EDGE } from "./config.ts";
import * as store from "./memory/store.ts";

const exec = promisify(execFile);

export class UnsupportedImageError extends Error {}

/**
 * Magic numbers for the formats this system accepts.
 *
 * Deliberately a short list. Every entry is a format the vision server has actually decoded,
 * rather than everything Pillow claims to read — an image type that arrives once a year and
 * then fails inside the model server is worse than one refused at the door with its name in
 * the message.
 */
const SIGNATURES: { ext: string; matches: (b: Buffer) => boolean; mime: string }[] = [
  {
    ext: ".png",
    matches: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    mime: "image/png",
  },
  { ext: ".jpg", matches: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, mime: "image/jpeg" },
  {
    ext: ".gif",
    matches: (b) => ["GIF87a", "GIF89a"].includes(b.subarray(0, 6).toString("latin1")),
    mime: "image/gif",
  },
  {
    ext: ".webp",
    matches: (b) =>
      b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP",
    mime: "image/webp",
  },
];

/**
 * HEIC and its siblings, which share the ISO base-media container with MP4 and are told
 * apart by the brand at offset 8. Matched separately from the list above because these are
 * the formats that must be CONVERTED rather than stored as they arrived.
 */
const HEIF_BRANDS = new Set(["heic", "heim", "heis", "heix", "hevc", "hevm", "hevs", "mif1", "msf1"]);

const isHeif = (b: Buffer): boolean =>
  b.length > 12 &&
  b.subarray(4, 8).toString("latin1") === "ftyp" &&
  HEIF_BRANDS.has(b.subarray(8, 12).toString("latin1"));

export interface SniffResult {
  ext: string;
  mime: string;
  /** True when the bytes must be converted before anything downstream can read them. */
  needsConversion: boolean;
}

/** What this actually is, by its first bytes. Throws when it is not an image we can read. */
export const sniffImage = (bytes: Buffer): SniffResult => {
  for (const s of SIGNATURES) if (s.matches(bytes)) return { ext: s.ext, mime: s.mime, needsConversion: false };
  if (isHeif(bytes)) return { ext: ".jpg", mime: "image/jpeg", needsConversion: true };
  throw new UnsupportedImageError(
    "that file is not an image this can read — PNG, JPEG, WebP, GIF and HEIC are supported",
  );
};

/**
 * A filename reduced to something safe to store and to show.
 *
 * It is only ever a LABEL: the file on disk is named from a random id plus the sniffed
 * extension, so nothing here can influence a path. Stripping directory parts and control
 * characters anyway means the name is also safe to render in the thread and to put in a
 * header, which is the second place a crafted filename tends to land.
 */
export const safeName = (name: unknown): null | string => {
  const raw = String(name ?? "").split(/[/\\]/).pop() ?? "";
  const clean = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 120);
  return clean || null;
};

const ensureDir = (): void => {
  fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
};

/** Convert HEIC to JPEG with the converter macOS already has. */
const toJpeg = async (input: string, output: string): Promise<void> => {
  try {
    await exec("/usr/bin/sips", ["-s", "format", "jpeg", input, "--out", output], { timeout: 30_000 });
  } catch (err) {
    throw new UnsupportedImageError(
      `that photo is HEIC and could not be converted to JPEG (${err instanceof Error ? err.message : String(err)}). ` +
        "Re-export it as JPEG, or set the iPhone camera to Most Compatible.",
    );
  }
  if (!fs.existsSync(output)) throw new UnsupportedImageError("HEIC conversion produced no file");
};

export interface StoredAttachment {
  bytes: number;
  id: number;
  mime: string;
  name: null | string;
}

/**
 * Validate, convert if needed, write to disk, and record the row.
 *
 * Returns before the image has been looked at — perception happens when the turn runs, not
 * at upload, so the composer stays responsive while someone attaches three photos and then
 * writes their question.
 */
export const storeImage = async (
  bytes: Buffer,
  opts: { conversationId: number | null; name?: unknown },
): Promise<StoredAttachment> => {
  if (!bytes.length) throw new UnsupportedImageError("empty upload");
  if (bytes.length > VISION_MAX_BYTES) {
    throw new UnsupportedImageError(`image is larger than the ${Math.round(VISION_MAX_BYTES / 1e6)}MB limit`);
  }

  const sniffed = sniffImage(bytes);
  ensureDir();

  const id = crypto.randomBytes(12).toString("hex");
  const file = path.join(ATTACHMENTS_DIR, `${id}${sniffed.ext}`);

  if (sniffed.needsConversion) {
    const scratch = path.join(ATTACHMENTS_DIR, `${id}.heic`);
    fs.writeFileSync(scratch, bytes);
    try {
      await toJpeg(scratch, file);
    } finally {
      // The original is not kept: nothing downstream can read it, and holding a second copy
      // of every photograph would double the directory for no reader.
      fs.rmSync(scratch, { force: true });
    }
  } else {
    fs.writeFileSync(file, bytes);
  }

  const size = fs.statSync(file).size;
  const name = safeName(opts.name);
  const rowId = store.addAttachment({
    bytes: size,
    conversationId: opts.conversationId,
    kind: "image",
    mime: sniffed.mime,
    name,
    path: file,
  });

  return { bytes: size, id: rowId, mime: sniffed.mime, name };
};

/** The bytes of a stored attachment, or null when the file has gone. */
export const readAttachment = (row: store.AttachmentRow): Buffer | null => {
  try {
    return fs.readFileSync(row.path);
  } catch {
    return null;
  }
};

/** Pixel dimensions, via the tool already depended on. Null when they cannot be read. */
const dimensionsOf = async (file: string): Promise<null | { height: number; width: number }> => {
  try {
    const { stdout } = await exec("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", file], {
      timeout: 15_000,
    });
    const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
    const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
    return width > 0 && height > 0 ? { height, width } : null;
  } catch {
    return null;
  }
};

/** Where the downscaled copy for a given ceiling lives, beside the original. */
const modelCopyPath = (file: string): string => `${file}.v${VISION_MAX_EDGE}.jpg`;

/**
 * The file to actually send the vision model — the original when it is already small
 * enough, a cached downscaled copy when it is not.
 *
 * This is the single most valuable thing in this module. A Qwen3-VL prompt grows with the
 * image's pixel count, and phones and screenshots are enormous: measured here, one 3840x2160
 * photograph took **81.3s** to describe at full size and **5.0s** at 1024px, with no loss of
 * specificity in the description. Sending what the camera produced would have made the
 * feature unusable and looked like a slow model rather than an oversized input.
 *
 * The original is kept untouched — it is what the thread displays, and what a later
 * `look_at_image` could be pointed at with a higher ceiling. The downscale is cached rather
 * than redone per call, so re-examining a photograph costs the model call and nothing else.
 *
 * `sips -Z` is a maximum-dimension resample, but it ENLARGES an image that is already
 * smaller, so the dimensions are checked first. Skipping that check would have quietly
 * upscaled every screenshot into four times the prompt tokens it needed.
 */
export const modelImageFile = async (row: store.AttachmentRow): Promise<null | string> => {
  if (!fs.existsSync(row.path)) return null;

  const cached = modelCopyPath(row.path);
  if (fs.existsSync(cached)) return cached;

  const size = await dimensionsOf(row.path);
  // Unreadable dimensions, or an image already within the ceiling: send it as it is. Erring
  // toward the original means a failure here costs latency, never the picture.
  if (!size || (size.width <= VISION_MAX_EDGE && size.height <= VISION_MAX_EDGE)) return row.path;

  try {
    await exec("/usr/bin/sips", ["-Z", String(VISION_MAX_EDGE), row.path, "--out", cached], { timeout: 30_000 });
  } catch {
    return row.path;
  }
  return fs.existsSync(cached) ? cached : row.path;
};

/**
 * A stored image as the `data:` URI an OpenAI image content part wants, downscaled for the
 * model if it needs to be.
 *
 * Base64 rather than a URL on purpose: a URL would make the model server fetch from this
 * one, which turns a local perception call into a network dependency pointing the wrong way
 * and only works while the dashboard is reachable from the model host.
 */
export const asDataUri = async (row: store.AttachmentRow): Promise<null | string> => {
  const file = await modelImageFile(row);
  if (!file) return null;
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return null;
  }
  // A downscaled copy is always JPEG, whatever the original was.
  const mime = file === row.path ? row.mime : "image/jpeg";
  return `data:${mime};base64,${bytes.toString("base64")}`;
};

/** Delete the row, its file, and any downscaled copy made for the model. */
export const removeAttachment = (row: store.AttachmentRow): void => {
  for (const file of [row.path, modelCopyPath(row.path)]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* the row goes either way — a missing file is the state this wanted */
    }
  }
  store.deleteAttachment(row.id);
};

/**
 * Drop uploads that were never sent.
 *
 * Someone attaches a photo, changes their mind, and closes the tab: the row has no run and
 * the file has no reader, and nothing will ever come looking for it. Anything still
 * unclaimed after `hours` is swept, on the same cycle that prunes the ledger.
 */
export const sweepUnsentAttachments = (hours = 24): number => {
  const cutoff = new Date(Date.now() - hours * 3600_000).toISOString();
  let removed = 0;
  for (const row of store.orphanedAttachments(cutoff)) {
    removeAttachment(row);
    removed += 1;
  }
  return removed;
};
