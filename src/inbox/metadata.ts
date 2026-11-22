/**
 * What can be read about an inbox item without a model (docs/PLAN-open-work.md, K3): the date inside a PDF, the
 * people and tags it appears to mention. All of it is a SUGGESTION shown for a person to accept; nothing here
 * files, tags or names anyone by itself, in the same way `suggestProject` only recommends a project.
 */
import { listEntities } from "../knowledge/store.ts";
import { rawDb } from "../memory/store.ts";

const valid = (y: number, m: number, d: number): boolean => y >= 1990 && y <= new Date().getFullYear() + 1 && m >= 1 && m <= 12 && d >= 1 && d <= 31;

/**
 * The date a PDF says it was made, as YYYY-MM-DD, or null. Reads the Info dictionary's /CreationDate (then
 * /ModDate) and the XMP create date as plain text, so a PDF whose metadata sits in a compressed object stream
 * gives nothing, which is the honest answer: the item then falls back to the day it was added.
 */
export const pdfDate = (data: Buffer): null | string => {
  // The Info dictionary is near the end of most files and XMP near the start; 256 KB from each end is plenty.
  const head = data.subarray(0, 262_144).toString("latin1");
  const tail = data.length > 262_144 ? data.subarray(Math.max(0, data.length - 262_144)).toString("latin1") : "";
  const text = `${head}\n${tail}`;
  for (const re of [/\/CreationDate\s*\(\s*D:(\d{4})(\d{2})(\d{2})/, /\/ModDate\s*\(\s*D:(\d{4})(\d{2})(\d{2})/, /<xmp:CreateDate>(\d{4})-(\d{2})-(\d{2})/]) {
    const m = re.exec(text);
    if (m && valid(Number(m[1]), Number(m[2]), Number(m[3]))) return `${m[1]}-${m[2]}-${m[3]}`;
  }
  return null;
};

const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Known people (the knowledge store's person entities, by name or alias) who appear in the text as whole words. */
export const suggestPeople = (text: string): string[] => {
  const found: string[] = [];
  for (const e of listEntities("person")) {
    // A one-word name under four letters ("Al", "Jo") matches too much ordinary text to suggest.
    const names = [e.name, ...e.aliases].filter((n) => n.length >= 4 || n.includes(" "));
    if (names.some((n) => new RegExp(`(?:^|[^\\p{L}\\p{N}])${esc(n)}(?:$|[^\\p{L}\\p{N}])`, "iu").test(text))) found.push(e.name);
  }
  return found.slice(0, 8);
};

/** Tags already in use on inbox items or meetings whose word appears in the text, most used first. */
export const suggestTags = (text: string, current: string[] = []): string[] => {
  const counts = new Map<string, number>();
  const add = (tag: string): void => void counts.set(tag, (counts.get(tag) ?? 0) + 1);
  for (const r of rawDb.prepare("SELECT tags FROM inbox_items WHERE tags IS NOT NULL").all() as { tags: string }[]) {
    try {
      for (const t of JSON.parse(r.tags) as unknown[]) add(String(t).toLowerCase());
    } catch {
      // a row with unreadable tags suggests nothing
    }
  }
  try {
    for (const r of rawDb.prepare("SELECT tag FROM meeting_tags").all() as { tag: string }[]) add(String(r.tag).toLowerCase());
  } catch {
    // the meetings module has not created its table in this database
  }
  const hay = text.toLowerCase();
  const have = new Set(current.map((t) => t.toLowerCase()));
  return [...counts.entries()]
    .filter(([tag]) => tag.length >= 3 && !have.has(tag) && new RegExp(`(?:^|[^a-z0-9])${esc(tag)}(?:$|[^a-z0-9])`).test(hay))
    .sort((a, b) => b[1] - a[1])
    .map(([tag]) => tag)
    .slice(0, 6);
};
