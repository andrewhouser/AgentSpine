/**
 * Wall-clock times in a named zone, without a date library.
 *
 * The posting calendar is written in Eastern time and the service might not be: the Mini's
 * clock zone is a setting, not a promise. So a slot is stored as the local text the calendar
 * used plus the UTC instant it means, and the conversion goes through Intl with the zone named
 * on the row, never through the machine's own zone.
 */

/** The zone's wall clock at `at`, as the same "YYYY-MM-DD HH:mm" text the plan uses. */
export const zonedText = (at: Date, tz: string): string => {
  const parts = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: tz,
    year: "numeric",
  }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`;
};

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/;

/**
 * "2026-11-23 09:00" in `tz` as an instant, or null when the text is not a real local time.
 *
 * The round trip at the end is the check that matters: a time inside the spring-forward gap
 * does not exist, and Intl would quietly hand back the hour after it. A post scheduled for a
 * time that never happens should be refused when it is seeded, not published an hour late.
 */
export const zonedToUtc = (local: string, tz: string): Date | null => {
  const m = LOCAL.exec(String(local ?? "").trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  if (Number.isNaN(wall)) return null;
  const want = `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}`;
  let offsetOf: (at: number) => number;
  try {
    zonedText(new Date(wall), tz); // throws RangeError on an unknown zone
    offsetOf = (at) => {
      const t = LOCAL.exec(zonedText(new Date(at), tz))!.slice(1).map(Number);
      return Date.UTC(t[0], t[1] - 1, t[2], t[3], t[4]) - at;
    };
  } catch {
    return null;
  }
  // Two passes: the offset at the first guess can be the wrong side of a clock change.
  let at = wall - offsetOf(wall);
  at = wall - offsetOf(at);
  return zonedText(new Date(at), tz) === want ? new Date(at) : null;
};

/** How a slot is shown to a person: "Mon Nov 23, 2026, 9:00 AM EST". */
export const zonedLabel = (at: Date, tz: string): string =>
  new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZone: tz,
    timeZoneName: "short",
    weekday: "short",
    year: "numeric",
  }).format(at);

/** The calendar day in a zone, "YYYY-MM-DD". */
export const isoDay = (at: Date, tz: string): string => zonedText(at, tz).slice(0, 10);
