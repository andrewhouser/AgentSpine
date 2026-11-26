/**
 * headsup_kind_set: turn one kind of heads-up on or off.
 *
 * Irreversible-tier and `confirmWhenUnattended`, like `date_remember`: it changes what every future
 * unattended morning run will do, so it is always queued for your approval, from a chat or from a
 * schedule alike. The learning code (src/headsup/outcomes.ts) queues this very call when you have
 * passed on nearly every offer of a kind, so approving that card has something to run.
 *
 * It only flips the preference. It never touches a watch that is already running, and it cannot
 * write policy.json, profile.md or goals.md.
 */
import { updatePrefs } from "../headsup/prefs.ts";
import type { ClassifiedAction, PolicyDecision, Tool } from "../types.ts";

const KINDS = ["anniversary", "appointment", "bill", "birthday", "booking", "flight", "recurring"];

const parse = (a: any): { enabled: boolean; kind: string } | { error: string } => {
  const kind = String(a?.kind ?? "");
  if (!KINDS.includes(kind)) return { error: `kind must be one of ${KINDS.join(", ")}.` };
  if (typeof a?.enabled !== "boolean") return { error: "enabled must be true or false." };
  return { enabled: a.enabled, kind };
};

export const headsupKindSet: Tool = {
  name: "headsup_kind_set",
  confirmWhenUnattended: true,
  description:
    "Turn one kind of Heads-up (birthday, bill, appointment, booking, anniversary, flight, recurring) on or off. Use when the " +
    "user asks to stop or resume a kind. It is QUEUED for their approval, so say it is proposed, not done. It never " +
    "affects a flight or drive already being watched.",
  argsSchema: '{ "kind": "anniversary" | "appointment" | "bill" | "birthday" | "booking" | "flight" | "recurring", "enabled": boolean }',
  classify: (a): ClassifiedAction => {
    const p = parse(a);
    return {
      reversibility: "irreversible",
      summary:
        "error" in p
          ? `HEADS-UP KIND (invalid: ${p.error})`
          : `${p.enabled ? "TURN ON" : "TURN OFF"} ${p.kind.toUpperCase()} HEADS-UPS.\nWatches already running are not affected. You can change it back in Settings.`,
      target: "headsup-kind",
    };
  },
  checkPolicy: (): PolicyDecision => ({ allowed: true, reason: "local preference only, and always queued for approval" }),
  run: async (a) => {
    const p = parse(a);
    if ("error" in p) return `ERROR: ${p.error}`;
    const r = updatePrefs({ kinds: { [p.kind]: p.enabled } });
    return r.ok ? `${p.kind} heads-ups are now ${p.enabled ? "on" : "off"}.` : `ERROR: ${r.error}`;
  },
};
