/**
 * Local OCR through a small Vision helper (tools/vision-ocr.swift).
 *
 * macOS ships the Vision framework, so reading a screenshot or a scanned PDF needs no model download and no
 * new dependency: the helper is compiled once with `swiftc`, cached beside the inbox, and run per file. It
 * recognises text entirely on this machine. If it cannot be built or run (not macOS, no Swift toolchain,
 * `INBOX_OCR=off`), `ocrAvailable()` says so and the caller records the item as "needs OCR". An empty result
 * is never presented as a successful read of an empty page.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { INBOX_DIR, INBOX_OCR, INBOX_OCR_TIMEOUT_MS } from "../config.ts";

const run = promisify(execFile);
const SOURCE = new URL("../../tools/vision-ocr.swift", import.meta.url).pathname;

let building: null | Promise<null | string> = null;

/** The compiled helper's path, building it if needed, or null when OCR cannot run here. */
export const ocrBinary = (): Promise<null | string> => {
  if (!INBOX_OCR || process.platform !== "darwin") return Promise.resolve(null);
  building ??= (async () => {
    const bin = path.join(INBOX_DIR, ".cache", "vision-ocr");
    try {
      const fresh = fs.existsSync(bin) && fs.statSync(bin).mtimeMs >= fs.statSync(SOURCE).mtimeMs;
      if (fresh) return bin;
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      await run("swiftc", ["-O", SOURCE, "-o", bin], { timeout: 180_000 });
      return bin;
    } catch {
      return null;
    }
  })();
  return building;
};

export const ocrAvailable = async (): Promise<boolean> => (await ocrBinary()) !== null;

export interface OcrResult {
  /** Why there is no text, when there isn't. */
  reason?: string;
  text: string;
}

/** Recognised text from an image or PDF, or the reason it could not be read. Never throws. */
export const ocrFile = async (file: string): Promise<OcrResult> => {
  const bin = await ocrBinary();
  if (!bin) return { reason: "OCR is not available on this machine (needs macOS with the Swift toolchain, and INBOX_OCR on)", text: "" };
  try {
    const { stdout } = await run(bin, [file], { maxBuffer: 64 * 1024 * 1024, timeout: INBOX_OCR_TIMEOUT_MS });
    const text = stdout.trim();
    return text ? { text } : { reason: "OCR ran but found no text on the page", text: "" };
  } catch (err) {
    return { reason: `OCR failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`, text: "" };
  }
};

/** Draws a known phrase and reads it back, to prove the helper works on this machine. */
export const ocrSelfTest = async (): Promise<string> => {
  const bin = await ocrBinary();
  if (!bin) return "";
  try {
    return (await run(bin, ["--selftest"], { timeout: 60_000 })).stdout.trim();
  } catch {
    return "";
  }
};
