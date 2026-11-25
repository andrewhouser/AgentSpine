/**
 * Point a suite at the committed `policy.example.json` instead of the machine's own `policy.json`.
 *
 * Import it first, before anything that loads src/config.ts. Without it, a suite that reaches `loadPolicy` crashed on
 * a fresh clone (no `policy.json` until `npm run setup`), and on a set-up machine it read the owner's real policy, so
 * whether it passed depended on their settings. Found 2026-11-25: 11 suites crashed on a machine with no policy.
 *
 * A POLICY_PATH set from outside wins, so a suite can still be run against a particular policy on purpose.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.POLICY_PATH ??= path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "policy.example.json");
