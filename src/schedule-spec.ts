/**
 * Human-readable schedule specs — no cron syntax. Two shapes:
 *
 *   interval:  "every 30 minutes"  "every 2 hours"  "every 1440 minutes"  "every day"
 *   at a time: "weekdays at 8:00am"  "daily at 07:30"  "mon,wed,fri at 6pm"
 *              "weekends at 10am"  "at 9am"  "tue-thu at 17:00, 21:00"
 *
 * parseSpec turns a spec into structured form; nextRun computes the next fire time.
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
export type Spec = IntervalSpec | AtSpec;

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

export const parseSpec = (input: string): Spec | null => {
  const s = String(input ?? "").trim().toLowerCase();
  if (!s) return null;

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

/** The next fire time strictly after `from`, or null if the spec is unparseable. */
export const nextRun = (input: string, from: Date = new Date()): Date | null => {
  const spec = parseSpec(input);
  if (!spec) return null;
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
