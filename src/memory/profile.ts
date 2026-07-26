/**
 * The user profile — standing facts the assistant should know on every single run.
 *
 * This is the one piece of context that is *trusted by construction*: `profile.md` is
 * human-curated, lives in the repo, and nothing automated ever writes to it. That is
 * deliberate. Reflected memories are model-generated and can be wrong or poisoned;
 * the profile is the ground truth you can always correct by hand in a text editor.
 *
 * Read fresh from disk on every call (like `loadPolicy`), so editing the file changes
 * behavior on the next run with no restart.
 */
import fs from "node:fs";
import { PROFILE_PATH, PROFILE_MAX_CHARS } from "../config.ts";

/**
 * Drop HTML comments — the template's guidance is for the human, not the model — then
 * collapse the blank runs they leave behind. Single blank lines survive, because the
 * profile is markdown and headings need their separation to still read as structure.
 */
const strip = (raw: string): string =>
  raw
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/**
 * True when nothing but headings survived — i.e. the template was never filled in.
 * Injecting a wall of empty section headers would only spend context saying nothing.
 */
const isOnlyHeadings = (text: string): boolean =>
  text.split("\n").every((line) => line.trim() === "" || line.trimStart().startsWith("#"));

/**
 * The profile as text, or "" if there is no file / it is effectively empty.
 * Empty-safe by design: a missing profile.md is a normal state, not an error.
 */
export const loadProfile = (): string => {
  let raw: string;
  try {
    raw = fs.readFileSync(PROFILE_PATH, "utf8");
  } catch {
    return ""; // no profile yet — perfectly fine
  }
  const text = strip(raw);
  if (!text || isOnlyHeadings(text)) return "";
  return text.length > PROFILE_MAX_CHARS
    ? text.slice(0, PROFILE_MAX_CHARS) + "\n…(profile truncated)"
    : text;
};

/** The profile formatted as a context message, or null when there is nothing to say. */
export const profileMessage = (): string | null => {
  const text = loadProfile();
  if (!text) return null;
  return (
    "About the person you work for. This is user-authored and trusted — treat it as " +
    "standing context for everything below, and prefer it over your own assumptions.\n\n" +
    text
  );
};
