/**
 * Getting text out of a file, including formats that aren't plain text.
 *
 * ## No new dependencies, on purpose
 *
 * The npm ecosystem's document parsers are exactly the kind of dependency this project
 * has said no to before — `@huggingface/transformers` was removed for pulling four no-fix
 * high vulnerabilities, and `npm audit` = 0 is a maintained value here. A PDF parser is a
 * large attack surface pointed directly at untrusted input.
 *
 * So extraction shells out instead:
 *
 *   - **`textutil`** ships with macOS. It handles rtf, rtfd, doc, docx, odt, wordml,
 *     webarchive and html. Nothing to install, ever.
 *   - **`pdftotext`** comes from poppler (`brew install poppler`) and is optional. Without
 *     it, PDFs are skipped with a status naming that exact command — a missing converter
 *     should tell you how to fix it, not fail silently and leave you wondering why a
 *     project can't answer questions about a document you clearly added.
 *
 * ## Running them safely
 *
 * `execFile`, never `exec` — there is no shell, so a filename containing `;` or `$()` is
 * an argument and cannot be anything else. Every invocation is capped by a timeout and an
 * output ceiling, because these are being pointed at whatever is on disk and a malformed
 * file that makes a converter spin should cost one skipped file, not the whole index.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Plain text, read directly. */
export const TEXT_EXTENSIONS = new Set([
  ".c", ".cfg", ".conf", ".cpp", ".cs", ".css", ".csv", ".go", ".h", ".htm", ".ini",
  ".java", ".js", ".json", ".jsx", ".log", ".lua", ".md", ".mdx", ".mjs", ".php", ".py",
  ".rb", ".rs", ".rst", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx", ".txt", ".vue",
  ".xml", ".yaml", ".yml",
]);

/** Converted with `textutil`, which is part of macOS. */
export const TEXTUTIL_EXTENSIONS = new Set([".doc", ".docx", ".html", ".odt", ".rtf", ".rtfd", ".webarchive"]);

/** Converted with `pdftotext` if poppler is installed. */
export const PDF_EXTENSIONS = new Set([".pdf"]);

export const INDEXABLE_EXTENSIONS = new Set([
  ...TEXT_EXTENSIONS,
  ...TEXTUTIL_EXTENSIONS,
  ...PDF_EXTENSIONS,
]);

const EXTRACT_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 8_000_000;

/** Whether a converter binary is on PATH. Probed once; the answer doesn't change mid-run. */
const available = new Map<string, boolean>();

const has = async (binary: string): Promise<boolean> => {
  const cached = available.get(binary);
  if (cached !== undefined) return cached;
  let ok = false;
  try {
    await run("/usr/bin/which", [binary], { timeout: 5000 });
    ok = true;
  } catch {
    ok = false;
  }
  available.set(binary, ok);
  return ok;
};

export interface Extracted {
  /** Why nothing came back, when it didn't. Surfaced in the source's status. */
  skipped?: string;
  text: string;
}

/**
 * The text of one file, or a reason there isn't any.
 *
 * Never throws: indexing walks whatever is on disk, and one unreadable file must not take
 * the rest of the source down with it.
 */
export const extractText = async (file: string, maxBytes: number): Promise<Extracted> => {
  const ext = path.extname(file).toLowerCase();

  if (TEXT_EXTENSIONS.has(ext)) {
    try {
      if (fs.statSync(file).size > maxBytes) return { skipped: "larger than the size limit", text: "" };
      const text = fs.readFileSync(file, "utf8");
      // A NUL byte means this is binary despite its extension; embedding it is noise.
      if (text.includes("\u0000")) return { skipped: "binary content", text: "" };
      return { text };
    } catch (err) {
      return { skipped: err instanceof Error ? err.message : String(err), text: "" };
    }
  }

  if (TEXTUTIL_EXTENSIONS.has(ext)) {
    if (process.platform !== "darwin") return { skipped: "textutil is macOS-only", text: "" };
    try {
      const { stdout } = await run("/usr/bin/textutil", ["-convert", "txt", "-stdout", file], {
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: EXTRACT_TIMEOUT_MS,
      });
      return { text: stdout };
    } catch (err) {
      return { skipped: `textutil failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`, text: "" };
    }
  }

  if (PDF_EXTENSIONS.has(ext)) {
    if (!(await has("pdftotext"))) {
      return { skipped: "needs pdftotext — install with: brew install poppler", text: "" };
    }
    try {
      // `-layout` keeps columns readable; `-` writes to stdout.
      const { stdout } = await run("pdftotext", ["-layout", "-nopgbrk", file, "-"], {
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: EXTRACT_TIMEOUT_MS,
      });
      return { text: stdout };
    } catch (err) {
      return { skipped: `pdftotext failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}`, text: "" };
    }
  }

  return { skipped: "unsupported format", text: "" };
};

/** What the UI shows about which formats this machine can actually index right now. */
export const converterStatus = async (): Promise<{ pdf: boolean; rich: boolean }> => ({
  pdf: await has("pdftotext"),
  rich: process.platform === "darwin",
});
