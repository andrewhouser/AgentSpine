/**
 * Human-readable schedule specs — no cron syntax. Three shapes:
 *
 *   interval:  "every 30 minutes"  "every 2 hours"  "every 1440 minutes"  "every day"
 *   at a time: "weekdays at 8:00am"  "daily at 07:30"  "mon,wed,fri at 6pm"
 *              "weekends at 10am"  "at 9am"  "tue-thu at 17:00, 21:00"
 *   just once: "in 30 minutes"  "tomorrow at 9am"  "today at 5pm"
 *              "next tuesday at 9am"  "on 2026-08-15 at 14:00"  "aug 15 at 9am"
 *
 * parseSpec turns a spec into structured form; nextRun computes the next fire time.
 *
 * The one-shot forms are all explicitly marked — by `in`, `once`, `today`, `tomorrow`,
 * `next`, or a date. That is deliberate rather than incidental: "tue at 9am" already means
 * *every* Tuesday, and a grammar where a one-shot could be spelled the same way as a
 * recurrence would make "remind me Tuesday" a coin flip between one reminder and a
 * permanent one. Every recurring spec that parsed before this existed still parses to
 * exactly what it did.
 */

export interface IntervalSpec {
  kind: "interval";
  minutes: number;
}
export interface AtSpec {
  kind: "at";
  times: { h: number; m: number }[];
  days: Set<number>; // 0=Sun .. 6=Sat
}
/** Fires once, at an absolute instant, then retires. Resolved against `from` at parse time. */
export interface OnceSpec {
  kind: "once";
  at: Date;
}
export type Spec = IntervalSpec | AtSpec | OnceSpec;

const DOW: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const parseDays = (s: string): Set<number> | null => {
  s = s.trim();
  if (!s || s === "daily" || s === "every day" || s === "everyday") return new Set([0, 1, 2, 3, 4, 5, 6]);
  if (s === "weekdays" || s === "weekday") return new Set([1, 2, 3, 4, 5]);
  if (s === "weekends" || s === "weekend") return new Set([0, 6]);
  const out = new Set<number>();
  for (const part of s.split(/[,\s]+/).filter(Boolean)) {
    const range = part.split("-");
    if (range.length === 2) {
      const a = DOW[range[0]];
      const b = DOW[range[1]];
      if (a == null || b == null) return null;
      for (let d = a; ; d = (d + 1) % 7) {
        out.add(d);
        if (d === b) break;
      }
    } else {
      const d = DOW[part];
      if (d == null) return null;
      out.add(d);
    }
  }
  return out.size ? out : null;
};

const parseTime = (s: string): { h: number; m: number } | null => {
  const m = s.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return { h, m: min };
};

const MONTHS: Record<string, number> = {
  jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2, apr: 3, april: 3,
  may: 4, jun: 5, june: 5, jul: 6, july: 6, aug: 7, august: 7,
  sep: 8, sept: 8, september: 8, oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
};

const RELATIVE_UNITS: Record<string, number> = { d: 1440, h: 60, m: 1, w: 10_080 };

/** Build a local-time Date. Month is 0-based, matching the Date constructor. */
const at = (y: number, mo: number, d: number, t: { h: number; m: number }): Date =>
  new Date(y, mo, d, t.h, t.m, 0, 0);

/**
 * The one-shot forms. Returns null when `s` is not one of them, which lets the recurring
 * parser below have its unchanged crack at the string.
 *
 * Every branch resolves against `from` rather than against the wall clock, so the whole
 * grammar is testable without waiting for Tuesday.
 */
const parseOnce = (input: string, from: Date): OnceSpec | null => {
  // "in 30 minutes" — the only form with no clock time in it.
  const rel = input.match(/^in\s+(\d+)\s*(minutes?|mins?|hours?|hrs?|days?|weeks?)$/);
  if (rel) {
    const n = Number(rel[1]);
    const mins = n * RELATIVE_UNITS[rel[2][0]];
    return n > 0 ? { kind: "once", at: new Date(from.getTime() + mins * 60_000) } : null;
  }

  // "once at ..." / "once on ..." / "once ..." is an explicit marker; strip it and read the
  // rest as one of the dated forms below. This is also the canonical stored form.
  const s = input.replace(/^once\s+(?:at\s+|on\s+)?/, "");
  const marked = s !== input;

  const y0 = from.getFullYear();

  // A marked bare time — "once at 9am" — is today at that time. Checked before the split
  // below, which needs a day part to split on.
  if (marked) {
    const only = parseTime(s);
    if (only) return { kind: "once", at: at(y0, from.getMonth(), from.getDate(), only) };
  }

  // "<day> at <time>", where <day> is a date or a relative day name. The " at " is optional
  // so the canonical "once at 2026-08-15 14:00" round-trips through its own output.
  const split = s.match(/^(.*?)(?:\s+at\s+|\s+)([\d:apm\s]+)$/);
  if (!split) return null;
  const day = split[1].trim();
  const time = parseTime(split[2]);
  if (!time) return null;

  const y = y0;

  if (day === "today") return { kind: "once", at: at(y, from.getMonth(), from.getDate(), time) };
  if (day === "tomorrow") return { kind: "once", at: at(y, from.getMonth(), from.getDate() + 1, time) };

  // "next tuesday" — the next occurrence strictly after today, so saying it ON a Tuesday
  // means the following one rather than in a few hours' time.
  const nextDow = day.match(/^next\s+(\w+)$/);
  if (nextDow) {
    const target = DOW[nextDow[1]];
    if (target == null) return null;
    const ahead = ((target - from.getDay() + 6) % 7) + 1; // 1..7, never 0
    return { kind: "once", at: at(y, from.getMonth(), from.getDate() + ahead, time) };
  }

  // "2026-08-15"
  const iso = day.match(/^(?:on\s+)?(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return { kind: "once", at: at(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), time) };

  // "aug 15" / "on August 15th". No year, so take this year's — or next year's if that date
  // has already gone by, since "August 15" said in September plainly means the coming one.
  const named = day.match(/^(?:on\s+)?([a-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?$/);
  if (named) {
    const mo = MONTHS[named[1]];
    if (mo == null) return null;
    const d = Number(named[2]);
    if (d < 1 || d > 31) return null;
    const candidate = at(y, mo, d, time);
    return { kind: "once", at: candidate.getTime() > from.getTime() ? candidate : at(y + 1, mo, d, time) };
  }

  return null;
};

export const parseSpec = (input: string, from: Date = new Date()): Spec | null => {
  const s = String(input ?? "").trim().toLowerCase();
  if (!s) return null;

  const once = parseOnce(s, from);
  if (once) return once;

  const iv = s.match(/^every\s+(\d+)?\s*(minutes?|mins?|hours?|hrs?|days?)$/);
  if (iv) {
    const n = iv[1] ? Number(iv[1]) : 1;
    const unit = iv[2];
    const mult = /^h/.test(unit) ? 60 : /^d/.test(unit) ? 1440 : 1;
    const minutes = n * mult;
    return minutes > 0 ? { kind: "interval", minutes } : null;
  }

  const at = s.indexOf(" at ");
  let daysPart = "daily";
  let timePart: string;
  if (at >= 0) {
    daysPart = s.slice(0, at) || "daily";
    timePart = s.slice(at + 4);
  } else if (s.startsWith("at ")) {
    timePart = s.slice(3);
  } else {
    return null;
  }

  const days = parseDays(daysPart);
  if (!days) return null;
  const times: { h: number; m: number }[] = [];
  for (const t of timePart.split(",").map((x) => x.trim()).filter(Boolean)) {
    const pt = parseTime(t);
    if (!pt) return null;
    times.push(pt);
  }
  return times.length ? { kind: "at", times, days } : null;
};

/**
 * The next fire time strictly after `from`. Null means the spec is unparseable OR — for a
 * one-shot — that its moment has already gone by. Callers must tell those apart before
 * blaming the syntax: see `isOneShot`.
 */
export const nextRun = (input: string, from: Date = new Date()): Date | null => {
  const spec = parseSpec(input, from);
  if (!spec) return null;
  if (spec.kind === "once") return spec.at.getTime() > from.getTime() ? spec.at : null;
  if (spec.kind === "interval") return new Date(from.getTime() + spec.minutes * 60_000);

  const times = [...spec.times].sort((a, b) => a.h - b.h || a.m - b.m);
  for (let add = 0; add <= 8; add++) {
    const base = new Date(from);
    base.setDate(base.getDate() + add);
    for (const t of times) {
      const c = new Date(base.getFullYear(), base.getMonth(), base.getDate(), t.h, t.m, 0, 0);
      if (c.getTime() > from.getTime() && spec.days.has(c.getDay())) return c;
    }
  }
  return null;
};

/** True if the string is a valid schedule spec. */
export const isValidSpec = (input: string): boolean => parseSpec(input) != null;

/**
 * True if the spec fires exactly once. Says nothing about whether that moment is still
 * ahead — a fired one-shot is still a one-shot, which is precisely what the scheduler needs
 * to know when deciding to retire the job instead of re-arming it.
 */
export const isOneShot = (input: string, from: Date = new Date()): boolean =>
  parseSpec(input, from)?.kind === "once";

const pad = (n: number): string => String(n).padStart(2, "0");

/**
 * The text a spec should be STORED as.
 *
 * Recurring specs are already absolute statements and are kept exactly as written. A
 * one-shot is not: "in 30 minutes" is a sentence about the moment it was spoken, and
 * storing it verbatim would leave a row that re-reads as a different time on every glance,
 * displays on the Automations page as a job perpetually half an hour away, and — once the
 * scheduler consults it after firing — resolves to yet another half hour in the future
 * instead of being finished. So a one-shot is resolved once, here, at creation, and stored
 * as the instant it meant. `once at 2026-08-15 14:30` parses back to itself.
 *
 * Returns null when the input is unparseable.
 */
export const canonicalSpec = (input: string, from: Date = new Date()): string | null => {
  const spec = parseSpec(input, from);
  if (!spec) return null;
  if (spec.kind !== "once") return String(input ?? "").trim();
  const d = spec.at;
  return `once at ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
