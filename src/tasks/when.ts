/**
 * Turning "tomorrow at 3pm", "in 2 days" or "2026-11-12" into a timestamp.
 *
 * Small and deterministic on purpose: the model is told to pass ISO, but a local model that
 * writes "next friday" instead should not produce a task with no due date. Anything this
 * cannot read returns null and the caller says so, rather than guessing.
 */
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

const timeOf = (text: string): null | { h: number; m: number } => {
  const t = /\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text) ?? /\bat\s+(\d{1,2})(?::(\d{2}))?\b/i.exec(text);
  if (!t) {
    if (/\bnoon\b/i.test(text)) return { h: 12, m: 0 };
    if (/\bmorning\b/i.test(text)) return { h: 9, m: 0 };
    if (/\bafternoon\b/i.test(text)) return { h: 14, m: 0 };
    if (/\b(evening|tonight)\b/i.test(text)) return { h: 18, m: 0 };
    return null;
  }
  let h = Number(t[1]);
  const m = Number(t[2] ?? 0);
  const ap = (t[3] ?? "").toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  return h > 23 || m > 59 ? null : { h, m };
};

const at = (d: Date, h: number, m: number): Date => {
  const out = new Date(d);
  out.setHours(h, m, 0, 0);
  return out;
};

/** ISO timestamp for `text` relative to `now`, or null when it cannot be understood. */
export const parseWhen = (text: unknown, now: Date = new Date()): null | string => {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const s = raw.toLowerCase();

  // An explicit date or timestamp. A bare date means 9am local.
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const [y, mo, da] = raw.split("-").map(Number);
    return new Date(y!, mo! - 1, da!, 9, 0, 0, 0).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}/i.test(raw)) {
    const d = new Date(raw.replace(" ", "T"));
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }

  const rel = /\bin\s+(\d+)\s*(minute|min|hour|hr|day|week)s?\b/.exec(s);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!;
    const ms = unit.startsWith("min") ? 60_000 : unit.startsWith("h") ? 3_600_000 : unit === "day" ? 86_400_000 : 604_800_000;
    return new Date(now.getTime() + n * ms).toISOString();
  }

  const time = timeOf(s);
  const dflt = { h: 9, m: 0 };

  if (/\btoday\b|\btonight\b/.test(s)) {
    const t = time ?? (s.includes("tonight") ? { h: 18, m: 0 } : { h: now.getHours() + 1, m: 0 });
    return at(now, Math.min(t.h, 23), t.m).toISOString();
  }
  if (/\btomorrow\b/.test(s)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    const t = time ?? dflt;
    return at(d, t.h, t.m).toISOString();
  }
  if (/\bnext week\b/.test(s)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 7);
    const t = time ?? dflt;
    return at(d, t.h, t.m).toISOString();
  }
  const DAY_WORDS = [
    "sunday|sun",
    "monday|mon",
    "tuesday|tues|tue",
    "wednesday|wed",
    "thursday|thurs|thur|thu",
    "friday|fri",
    "saturday|sat",
  ];
  for (let i = 0; i < 7; i++) {
    if (new RegExp(`\\b(${DAY_WORDS[i]})\\b`).test(s)) {
      const d = new Date(now);
      let add = (i - d.getDay() + 7) % 7;
      if (add === 0) add = 7; // "friday" said on a friday means next friday
      d.setDate(d.getDate() + add);
      const t = time ?? dflt;
      return at(d, t.h, t.m).toISOString();
    }
  }
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
};
