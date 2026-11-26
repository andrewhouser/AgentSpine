#!/usr/bin/env node
/**
 * First-run setup for a fresh clone:  npm run setup
 *
 * The repo holds code and starting copies. What makes an install yours (the policy, the
 * heartbeat goals, your profile, your inbox rules and the .env secrets) is never committed,
 * so a fresh clone has none of it. This copies each *.example file into place when the real
 * one is missing and gives .env a dashboard token. It never overwrites a file that exists,
 * so it is safe to run again.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const at = (f) => path.join(root, f);

const COPIES = [
  ["policy.example.json", "policy.json", "what the agent may touch. Deny-by-default: turn on what you want."],
  ["goals.example.md", "goals.md", "what the heartbeat works on. Empty tasks mean it does nothing."],
  ["profile.example.md", "profile.md", "standing facts about you, given to every run. Fill it in."],
  ["inbox-rules.example.md", "inbox-rules.md", "your own rules for the inbox cleanup watcher."],
  ["watch-list.example.md", "watch-list.md", "the pages the weekly niche watch reads. Empty until you list some."],
];

let made = 0;
for (const [from, to, why] of COPIES) {
  if (fs.existsSync(at(to))) {
    console.log(`kept     ${to}`);
    continue;
  }
  fs.copyFileSync(at(from), at(to));
  made++;
  console.log(`created  ${to}  (${why})`);
}

// The dashboard API can run tools, so it refuses LAN clients without a token. Give a fresh
// install one; an existing token is left alone.
const envPath = at(".env");
if (!fs.existsSync(envPath) && fs.existsSync(at(".env.example"))) {
  fs.copyFileSync(at(".env.example"), envPath);
  fs.chmodSync(envPath, 0o600);
  console.log("created  .env  (from .env.example: set LOCAL_LLM_URL and any keys)");
}
const env = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
if (/^DASHBOARD_TOKEN=.+/m.test(env)) {
  console.log("kept     .env DASHBOARD_TOKEN");
} else {
  const token = crypto.randomBytes(24).toString("base64url");
  const sep = env && !env.endsWith("\n") ? "\n" : "";
  fs.writeFileSync(envPath, `${env}${sep}DASHBOARD_TOKEN=${token}\n`, { mode: 0o600 });
  made++;
  console.log("created  .env DASHBOARD_TOKEN  (the apps and other machines sign in with it; it is in .env)");
}

console.log(made ? "\nNext: edit profile.md and policy.json, set LOCAL_LLM_URL in .env to your model server, then npm run dashboard." : "\nNothing to do: this install is already set up.");
