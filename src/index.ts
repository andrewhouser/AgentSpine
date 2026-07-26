/**
 * Default entry point. Starts the heartbeat loop. For a single cycle use
 * `npm run tick`; to review queued actions use `npm run confirm`.
 */
import { LOCAL_BASE_URL, CLOUD_ENABLED, CLOUD_MODEL } from "./config.ts";

console.log("agentspine — local-first agentic loop");
console.log(`  local model : ${LOCAL_BASE_URL}`);
console.log(`  cloud fallback: ${CLOUD_ENABLED ? `enabled (${CLOUD_MODEL})` : "disabled"}`);
console.log("");

await import("./spine.ts").then((m) => m.tick());
console.log("\nRun `npm run loop` to keep it running on a heartbeat.");
