/**
 * A call budget for a metered API, kept in code and counted in the database.
 *
 * Neither the flight nor the routing provider's free tier is something to rely on blindly: the
 * published limits disagree between sources and change. So the number of calls is owned here. When
 * a budget is spent, watching pauses and says so, which is better than being cut off by the
 * provider part-way through the one flight you care about, and far better than a surprise bill.
 */
import { kvGet, kvSet } from "../../memory/store.ts";

const pad = (n: number): string => String(n).padStart(2, "0");

/** The calendar month, "2026-11": the budget period for flights. */
export const monthKey = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
/** The calendar day, "2026-11-18": the budget period for drives. */
export const dayKey = (d: Date): string => `${monthKey(d)}-${pad(d.getDate())}`;

const keyFor = (name: string, period: string): string => `headsup:budget:${name}:${period}`;

export const used = (name: string, period: string): number => {
  const n = Number(kvGet(keyFor(name, period))?.value ?? 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/** True while there is room for `n` more calls. A limit of 0 or less means none are allowed. */
export const hasRoom = (name: string, period: string, limit: number, n = 1): boolean => limit > 0 && used(name, period) + n <= limit;

/** Record `n` calls. Call BEFORE the request, so a crash mid-request still counts. */
export const spend = (name: string, period: string, n = 1): void => {
  kvSet(keyFor(name, period), String(used(name, period) + n));
};

/** Whether the "budget used up" notice has been given for this period, and marking it given. */
export const noticeGiven = (name: string, period: string): boolean => kvGet(`${keyFor(name, period)}:notice`)?.value === "1";
export const markNoticeGiven = (name: string, period: string): void => kvSet(`${keyFor(name, period)}:notice`, "1");
