/**
 * Legacy single-goal heartbeat. `once` runs one cycle against goals.md; `loop` repeats
 * every HEARTBEAT_MINUTES. Superseded by the dashboard's scheduler (`npm run dashboard`),
 * which runs many named jobs — but kept for a quick goals.md run without the server.
 *
 * Uses the shared runTask, so its runs get the serial queue + trace persistence and show
 * up in the dashboard alongside scheduled and one-off jobs.
 */
import fs from "node:fs";
import { HEARTBEAT_MS, GOALS_PATH } from "./config.ts";
import { runTask } from "./runner.ts";
import * as store from "./memory/store.ts";

const DEFAULT_GOAL =
  "Do a light check-in: recall anything relevant from memory, and if there is nothing " +
  "useful to do right now, finish with a short summary. Take only low-risk reversible actions.";

const readGoal = (): string => {
  try {
    const g = fs.readFileSync(GOALS_PATH, "utf8").trim();
    return g || DEFAULT_GOAL;
  } catch {
    return DEFAULT_GOAL;
  }
};

export const tick = async (): Promise<void> => {
  const goal = readGoal();
  const stamp = new Date().toLocaleTimeString();
  console.log(`\n[${stamp}] heartbeat: running agent...`);
  try {
    const { summary, steps } = await runTask(goal, { kind: "heartbeat" });
    console.log(`[${stamp}] done in ${steps} step(s): ${summary}`);
    const pending = store.listConfirmations("pending");
    if (pending.length) {
      console.log(`  ${pending.length} action(s) awaiting confirmation — run: npm run confirm list`);
    }
  } catch (err) {
    console.error(`[${stamp}] cycle failed: ${err instanceof Error ? err.message : String(err)}`);
  }
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const loop = async (): Promise<void> => {
  console.log(`agentspine loop started. Heartbeat every ${HEARTBEAT_MS / 60_000} min. Ctrl-C to stop.`);
  while (true) {
    await tick();
    await sleep(HEARTBEAT_MS);
  }
};

const mode = process.argv[2] ?? "once";
if (import.meta.filename === process.argv[1]) {
  if (mode === "loop") await loop();
  else await tick();
}
