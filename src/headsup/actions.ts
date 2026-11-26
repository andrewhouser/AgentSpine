/**
 * What "Yes" does for a heads-up, and what the button says. Pure, so the server, the web client,
 * the iOS client and the lock-screen categories all get the same answer from one place.
 *
 *   research: a birthday or anniversary goes and finds gift ideas or restaurants.
 *   watch:    a flight is tracked for delays and gate changes; an appointment with a place has its
 *             drive watched for traffic.
 *   remind:   a booking gets a reminder sequence and drafted messages (sequence.ts).
 *   ack:      anything else just records that you saw it.
 */
export type YesAction = "ack" | "remind" | "research" | "watch";

export interface ActionFacts {
  /** The flight number as written ("UA 482"), when one was found in the event. */
  flightNumber?: string;
  kind: string;
  location?: string;
  /** Whether the event has a start TIME. A drive cannot be timed for an all-day event. */
  timed: boolean;
  /** Whether a routing key and a home address are set, so a drive watch could actually run. */
  travelReady: boolean;
}

export const yesAction = (f: ActionFacts): YesAction => {
  if (f.kind === "birthday" || f.kind === "anniversary") return "research";
  if (f.kind === "booking") return "remind";
  if (f.kind === "flight" && f.flightNumber) return "watch";
  if (f.kind === "appointment" && f.location && f.timed && f.travelReady) return "watch";
  return "ack";
};

export const yesLabel = (kind: string, action: YesAction): string => {
  if (action === "research") return kind === "birthday" ? "Yes, find gift ideas" : "Yes, find restaurants";
  if (action === "watch") return kind === "flight" ? "Yes, track this flight" : "Yes, watch traffic";
  if (action === "remind") return "Yes, set up reminders";
  return "Got it";
};
