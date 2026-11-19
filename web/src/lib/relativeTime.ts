/**
 * When a message was sent, in the shortest form that still places it: "Just now", "5 min ago",
 * a clock time today, "Yesterday, 9:04 AM", then a date.
 *
 * Takes `now` so it can be tested, and returns "" for something that is not a date rather than
 * "Invalid Date": a missing time should leave a gap, not print an error under a message.
 * A time slightly in the future (the browser's clock and the server's disagree) is "Just now".
 */
export const relativeTime = (iso: string, now: number = Date.now()): string => {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";

  const diff = now - then;
  if (diff < 60_000) return "Just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;

  const when = new Date(then);
  const today = new Date(now);
  const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (when.toDateString() === today.toDateString()) return time;

  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  if (when.toDateString() === yesterday.toDateString()) return `Yesterday, ${time}`;

  const date = when.toLocaleDateString([], {
    day: "numeric",
    month: "short",
    ...(when.getFullYear() === today.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${date}, ${time}`;
};
