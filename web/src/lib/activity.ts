import type { LiveToolCall } from "./types.ts";

const clip = (s: string, n = 80): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** The quoted/trailing part of a card summary: `Web search: "x"` becomes `"x"`. */
const subject = (call: LiveToolCall): string => {
  const raw = call.summary ?? "";
  const i = raw.indexOf(": ");
  const tail = i >= 0 ? raw.slice(i + 2) : raw;
  return clip(tail.trim());
};

/**
 * One short phrase for what the run is doing right now, built from its newest tool call.
 * The full detail lives in the Trace tab; this is only the line next to "thinking".
 */
export const describeActivity = (calls: LiveToolCall[]): null | string => {
  const call = [...calls].reverse().find((c) => c.status === null) ?? calls[calls.length - 1];
  if (!call) return null;
  // Once a call has a result the model is reasoning about it, not still running it.
  const inFlight = call.status === null;
  const what = subject(call);

  switch (call.tool) {
    case "web_search":
      return inFlight ? `searching the web${what ? `: ${what}` : ""}` : "reviewing search results";
    case "web_read":
      return inFlight ? "reading a page" : "reviewing the page";
    case "read_more":
      return inFlight ? "reading more of the page" : "reviewing the page";
    default:
      return inFlight ? `using ${call.tool}${what ? `: ${what}` : ""}` : `reviewing ${call.tool} result`;
  }
};
