/**
 * Exact state, for watchers.
 *
 * A watcher is only as good as its notion of "did this change?". Asking the model to
 * remember what a page said last week and eyeball the difference produces a thing that
 * cries wolf on a reworded headline and stays quiet when the version number moves. So
 * change detection doesn't go through the model or through semantic memory at all — it
 * goes through a string comparison against a key in the `kv` table.
 *
 * Both tools are reversible and always permitted: they touch nothing but AgentSpine's own
 * local database. The `memory_*` tools are the fuzzy counterpart — use those for "what do
 * I know about X", these for "is this byte-for-byte what I saw last time".
 */
import * as store from "../memory/store.ts";
import type { ClassifiedAction, Policy, PolicyDecision, Tool } from "../types.ts";

const MAX_KEY = 200;
const MAX_VALUE = 8000;

const always = (_p: Policy): PolicyDecision => ({ allowed: true, reason: "local state access" });

const cleanKey = (k: unknown): string => String(k ?? "").trim().slice(0, MAX_KEY);

export const stateGet: Tool = {
  name: "state_get",
  description:
    "Read the exact value you last stored under a key (see state_set). Use this to detect " +
    "change: fetch a source, compare it to the stored value, and only act if they differ. " +
    "If the key has never been set, this says so explicitly — that is a FIRST OBSERVATION, " +
    "so record the value and do NOT notify anyone about it.",
  argsSchema: '{ "key": string }',
  classify: (a): ClassifiedAction => ({
    reversibility: "reversible",
    target: "state",
    summary: `Read state key "${cleanKey(a?.key)}"`,
  }),
  checkPolicy: (p) => always(p),
  run: async (a) => {
    const key = cleanKey(a?.key);
    if (!key) return "ERROR: state_get needs a key.";
    const row = store.kvGet(key);
    if (!row) {
      return (
        `(unset) — "${key}" has no stored value. This is the FIRST observation: store the ` +
        `current value with state_set and do NOT report a change, because there is nothing ` +
        `to compare against yet.`
      );
    }
    // Delimit the value explicitly. Without markers a model reading this back tends to
    // swallow the timestamp line into the value it compares (and then into the "was X,
    // now Y" it reports), which makes every diff look like a change.
    return (
      `stored ${row.updated}. The previous value is exactly the text between the markers:\n` +
      `<<<STATE\n${row.value}\nSTATE>>>`
    );
  },
};

export const stateSet: Tool = {
  name: "state_set",
  description:
    "Store an exact value under a key, overwriting whatever was there. Use it to record " +
    "what a source looked like this time, so the next run can detect a change. Store the " +
    "smallest thing that actually identifies the state — a version number, a title, a date, " +
    "an item count — not an entire page, which changes on every ad rotation and would make " +
    "the watcher fire constantly.",
  argsSchema: '{ "key": string, "value": string }',
  classify: (a): ClassifiedAction => ({
    reversibility: "reversible",
    target: "state",
    summary: `Set state key "${cleanKey(a?.key)}"`,
  }),
  checkPolicy: (p) => always(p),
  run: async (a) => {
    const key = cleanKey(a?.key);
    if (!key) return "ERROR: state_set needs a key.";
    const value = String(a?.value ?? "");
    if (value.length > MAX_VALUE) {
      return (
        `ERROR: value is ${value.length} chars, over the ${MAX_VALUE} limit. Store a short ` +
        `identifying fingerprint (version, title, date, count) rather than the whole source.`
      );
    }
    const prev = store.kvGet(key);
    store.kvSet(key, value);
    return prev ? `updated "${key}" (previous value replaced).` : `stored "${key}" for the first time.`;
  },
};
