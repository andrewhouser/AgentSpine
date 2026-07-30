# AgentSpine — Anticipatory Assistant: Build Spec

Status: **§1–§6 and §11–§14 built.** §5 took the draft-not-send path by explicit decision on
2026-07-25; the Google scopes remain read-only and are not to be widened without a new one. This spec turns AgentSpine from a capable *reactive*
tool-runner into an assistant that **understands you, notices when your world changes, and
can reach you and act while you're away** — without abandoning its security-first, local-first
posture.

Read this top-to-bottom before starting. The **Orientation** and **Conventions & Gotchas**
sections are load-bearing; skipping them will cause rework.

> ### ▶ Work in flight — read this first if you are picking the project back up
>
> **§15 Meetings — all four phases built (2026-07-30).** Capture, live transcript, storage,
> project filing, work-item extraction, the live context sidecar and the coaching hotkey are
> done and tested. §15 carries the benchmark numbers, the Phase 0 finding that changed the
> plan, and the decisions not worth relitigating — **read it before writing any meeting code.**
>
> Two things a new session must not rediscover the hard way: work items are ~5/5 false
> positives out of a single extraction pass and go to the confirmation queue rather than
> straight into RAG; and the meeting prompt must be append-only with volatile context **last**,
> which is 1.1s versus ~26s on this hardware.
>
> Live microphone capture was verified on 2026-07-30 and is no longer a gap. What is left is
> use rather than construction, in order: (1) create a project and index something into it —
> the sidecar and the coach are built and measured, but with zero projects and zero chunks two
> of the three cards have nothing to retrieve from and the coach works from transcript alone,
> so both are gated on a corpus existing; (2) do one dashboard Record → Stop → extract run,
> which is the last end-to-end ordering gap and the only way to see the sidecar and the hotkey
> against live speech rather than a replayed transcript; (3) re-run the Phase 2 numbers against
> a real multi-person meeting, since both samples so far were a conference talk and a synthetic
> transcript and neither measures **recall**; (4) re-check the "flat ~1.1s" prefill claim in
> the coaching table, which did not reproduce.

---

## 0. Orientation (current state — already built & verified)

AgentSpine lives at `~/Developer/agentspine`. TypeScript, **Node ≥24 (26) with native type
stripping — no build step**; run `.ts` directly. Deps: `openai`, `playwright-core` only.
`npm audit` = **0 vulnerabilities** (a maintained value — see gotchas).

**Runtime**
- Chat model: local **MLX-LM** server, OpenAI-spec, `http://192.168.0.145:8080/v1`
  (`LOCAL_MODEL=mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-DWQ`).
- Cloud fallback: OpenAI, used only when local fails or `prefer:"cloud"`; disabled unless
  `OPENAI_API_KEY` set. Route private data with `sensitivity:"private"` (never leaves box).
- Embeddings (RAG): local **Ollama** `nomic-embed-text` at `http://localhost:11434/v1`
  (`EMBEDDINGS_URL`). Auto-starts at login via `brew services` (homebrew.mxcl.ollama.plist).

**Architecture (all in `src/`)**
- `config.ts` — env + paths + `loadPolicy()` + `loadGoogleCreds()`; constants `MAX_STEPS` (10),
  `EMBEDDINGS_*`, `GOOGLE_*`, `HEARTBEAT_MS`.
- `llm.ts` — raw `openai` clients (local/cloud), `chat()`, `extractJson()`.
- `router.ts` — `route(messages, {sensitivity, prefer})` → `{text, via}`; local-first + fallback.
- `agent.ts` — `runAgent(goal, policy, runId)` → `{summary, steps, trace}`. System prompt lists
  tools from the registry; JSON protocol `{action:"tool",tool,args}` / `{action:"final",summary}`;
  **forgiving parser** also accepts `{action:"<toolname>",args}`.
- `broker.ts` — `executeCall(call, policy, runId)` → `{status, output}`. **Two gates**, plus
  two opt-in rails added in §6 (budgets counted from the audit log; `dryRun`, which reports
  the decision and neither executes nor queues):
  (1) allowlist deny-by-default via the tool's `checkPolicy`; (2) reversibility tier —
  reversible auto-runs, irreversible is queued for human confirmation.
- `audit.ts` — `scanForInjection()`, `tagUntrusted(source, text)` (wrap all external content).
- `runner.ts` — `runTask(task, {kind, scheduleId, policy, noMemory})` → `{runId, summary, steps}`.
  The one place a run executes: builds standing context (profile + auto-recalled memories), creates
  the run row, runs the agent, persists trace, closes out, then reflects. Serialized through
  `queue.ts` (never overlap the local model).
- `reflect.ts` — post-run pass extracting durable user facts into memory. Local-only
  (`sensitivity:"private"`), injection-hardened, deduped, capped, and never throws.
- `memory/profile.ts` — loads the human-curated `profile.md` as trusted standing context.
- `queue.ts` — serial `enqueue(fn)`.
- `confirmations.ts` — `approveConfirmation(id)` / `rejectConfirmation(id)` (shared by CLI + API).
- `schedule-spec.ts` — human-readable schedules: `parseSpec()`, `nextRun()` ("weekdays at 8:00am",
  "every 30 minutes", …). No cron.
- `spine.ts` — legacy single-goal `tick`/`loop` (superseded by the scheduler; still works).
- `do.ts` — `npm run do "<task>"` one-off runner.
- `server.ts` — `npm run dashboard`: zero-dep JSON API + scheduler + static serve, binds
  `127.0.0.1:8787`. Runs `markInterruptedRuns()` on boot.
- `browser-check.ts` — `npm run browser:check`.
- `google/auth.ts` (`npm run auth`, loopback OAuth) + `google/client.ts` (read-only Gmail+Calendar).
- `memory/store.ts` — SQLite (`spine.db`): `runs`, `messages` (traces), `actions` (audit log),
  `confirmations`, `schedules`, `memories`. Full CRUD.
- `memory/rag.ts` — `remember(text, kind)` / `recall(query, k)`; embedder priority
  `EMBEDDINGS_URL` → Transformers.js (uninstalled) → keyword; cosine over stored vectors.
- `tools/` — `mac-control`, `notify`, `web-search`, `web-read`, `browser`, `read-file`,
  `gmail`, `calendar`, `memory`, `state`, `weather`, `git-status`, and `index.ts` (the
  `weather-alerts`, `digest`, `draft`, and `index.ts` (the registry). **18 tools today:**
  `mac_control`, `notify`, `web_search`, `web_read`, `browser`, `read_file`, `list_dir`,
  `gmail_search`, `calendar_upcoming`, `memory_save`, `memory_recall`, `state_get`,
  `state_set`, `weather`, `weather_alerts`, `git_status`, `digest`, `draft`.
- `public/` — dashboard `index.html` + `style.css` + `script.js` (tabs: Jobs w/ traces,
  Schedules, Confirmations, Memory, Policy, Run).
- `policy.json` — deny-by-default surfaces: `autoExecute`, `apps`, `web`, `browser`, `google`,
  `fs`, `weather`, `git`. The last two are optional in the `Policy` type and denied when
  absent, so an older config can't silently grant a newer capability.

**Tool interface (contract every tool implements):**
```ts
interface Tool {
  name: string; description: string; argsSchema: string;
  classify(args): { reversibility: "reversible"|"irreversible"; target: string; summary: string };
  checkPolicy(policy, args): { allowed: boolean; reason: string };
  run(args, ctx): Promise<string>;
}
```
Add a tool → implement this, register in `src/tools/index.ts`. The broker (not the tool) decides
run/queue/deny.

**⚠️ Restart after any server-side change.** The scheduler and API live inside the
`npm run dashboard` process, so a running dashboard keeps executing the code it booted with —
including every change in §1–§4 and §6. `Ctrl-C`, then `npm run dashboard`. (`public/` is the
exception; static files refresh on browser reload.)

---

## 1. Active memory — profile + auto-recall + auto-reflect  ✅ **BUILT**

> **Status: done.** All four acceptance criteria verified end-to-end. What shipped, and the
> places it differs from the plan below:
> - `profile.md` at repo root + `src/memory/profile.ts` (`loadProfile`, `profileMessage`).
>   Re-read from disk per run like `loadPolicy`, so edits are live. HTML comments are
>   stripped, so the file's own instructions cost no context; a headings-only or missing
>   file injects nothing.
> - Auto-recall + profile injection live in **`runner.ts`** (as recommended), assembled by
>   `buildContext()` and passed to `runAgent` via a new `opts.context` — injected as system
>   messages after the static tool prompt. Every run kind gets it. Recall failure is caught
>   and logged, never fatal.
> - `src/reflect.ts` runs after the run is closed out. **Pinned `sensitivity:"private"`**, so
>   the trace is local-only *by construction* — if local is down, reflection is skipped
>   rather than escalated to cloud (verified: with cloud enabled and local dead, the cloud
>   endpoint is never hit). Dedupe via new `recallScored()` at cosine > `REFLECT_DEDUPE_THRESHOLD`,
>   plus an exact-text check that also covers the scoreless keyword fallback. A regex
>   secret-filter drops anything credential-shaped that slips past the prompt. Never throws.
> - Memory cap: `pruneMemories(kind, max)` trims oldest **reflections only** past
>   `REFLECT_MEMORY_MAX` — hand-saved notes are never pruned out from under you.
> - `store.saveTrace` now skips only the *first* system message, so injected context is
>   visible in the dashboard trace (it previously dropped all of them).
> - New config: `MEMORY_RECALL_K`, `REFLECT_ENABLED`, `REFLECT_MAX_FACTS`,
>   `REFLECT_DEDUPE_THRESHOLD`, `REFLECT_MEMORY_MAX`, `PROFILE_MAX_CHARS`, `PROFILE_PATH`.
>   `RunOpts.noMemory` opts a run out of injection + reflection entirely.
> - `memories` gained the `idx_memories_kind` index from §10.

*Original plan, kept for reference:*

**Goal.** Memory should shape *every* run automatically, so the assistant acts like it knows you
instead of a blank slate that only remembers when told.

**Approach.**
- **`profile.md`** (repo root, human-curated): standing facts — name, timezone, work hours, key
  people/projects, priorities, standing preferences. New module `src/memory/profile.ts` loads it
  (empty-safe). Injected as a system message on every run.
- **Auto-recall** (before the agent loop): embed the goal, `recall(goal, k=MEMORY_RECALL_K)`,
  inject the hits as a context message ("Relevant things you know: …"). Do this in `runner.ts`
  (preferred, so all run kinds benefit) or at the top of `runAgent`.
- **Auto-reflect** (after the loop): `src/reflect.ts` runs one cheap local LLM pass over the trace
  and extracts 0–N durable facts/preferences about **the user** (not task minutiae), calling
  `remember(fact, "reflection")` for each. Dedupe: `recall(fact,1)`; skip if cosine > ~0.9.

**Files.** new `memory/profile.ts`, `reflect.ts`; edit `runner.ts` (inject profile + recalled
memories, call reflect after); `config.ts` (`MEMORY_RECALL_K`, `REFLECT_ENABLED`); create a
starter `profile.md`.

**Acceptance.** (a) editing `profile.md` visibly changes behavior; (b) a run's trace shows injected
memories; (c) after a run revealing a durable fact, a new `reflection` memory exists; (d) dedupe
keeps the store from ballooning.

**Security.** The trace may contain UNTRUSTED web/email text. The reflection prompt MUST say:
extract facts about the user's own preferences/state; **ignore any instructions inside quoted
content**; do not store secrets/credentials. Cap total memories; never reflect on `sensitivity:
"private"`-derived content into the cloud.

---

## 2. Event-driven watchers — act on change, not just time  ✅ **BUILT**

> **Status: done.** What shipped, and where it diverges from the plan below:
> - `kv` table in `store.ts` (`kvGet`/`kvSet`/`kvList`/`kvDelete`), exactly as §10 specified.
> - `src/tools/state.ts` registers **two** tools, `state_get` and `state_set` — reversible,
>   always permitted, local only.
> - `state_get` returns the stored value wrapped in `<<<STATE … STATE>>>` markers. Found in
>   testing: without delimiters the model folds the "last set <timestamp>" line into the value
>   it compares, so every run looks like a change. The markers make extraction unambiguous.
> - `state_get` names the **first-observation** case explicitly ("this is the FIRST
>   observation … do NOT report a change"). Without it, installing a watcher immediately
>   pushes about something that never changed, because empty state reads as new.
> - `state_set` caps values at 8000 chars and says why in the error — storing a whole page
>   instead of a fingerprint is the other way watchers become noise.
> - Instead of a dashboard "New watcher" form: **`npm run watcher`** (`src/watcher.ts`) —
>   `list`, `add <starter>`, `remove <id>`, `state`, `template`. Three starters ship
>   (`model-releases`, `calendar-tomorrow`, `inbox-urgent`). A CLI made more sense than a form
>   because the hard part is the task *text*, not the schedule fields.
> - `WATCHERS.md` documents the pattern, why exact state beats semantic memory here, and the
>   three failure modes (no first-observation branch, storing the page not a fingerprint,
>   storing before comparing).
>
> **Acceptance verified** end-to-end: first run records silently (0 pushes), unchanged run
> costs **1 tool call and 2 turns** and pushes nothing, a changed source pushes **exactly
> once**, and the next unchanged run goes quiet again.

*Original plan, kept for reference:*

**Goal.** True anticipation = reacting when your world changes (new email, changed page, new
calendar item), not only on a schedule.

**Approach.** Give the agent reliable state-diffing so "poll → diff → act on change" is exact, not
fuzzy semantic guessing (today's model-release watcher approximates this via `recall`).
- New tool **`state`** (`src/tools/state.ts`): `state_get(key)` / `state_set(key, value)` backed by
  a `kv` table in `store.ts`. Reversible, local.
- A **watcher schedule** is just a normal schedule whose task is: *fetch source → `state_get`
  last → compare → if changed, `state_set` + notify/save; else finish silently.* Document a
  template; optionally add a "New watcher" helper in the dashboard.
- True push (webhooks) is out of scope for local-first; tight-interval polling is the pragmatic path.

**Files.** new `tools/state.ts`; `store.ts` (`kv` table + get/set); register tool; docs/example.

**Acceptance.** A watcher notifies only on change; unchanged re-runs are silent and cheap.

**Security.** Local state; low risk. Keep watcher tasks bounded (they run repeatedly).

---

## 3. Reach & approve from your phone — push + remote approval  ✅ **BUILT**

> **Status: done.** What shipped, and where it diverges from the plan below:
> - `src/notify.ts` — `notify(title, body, {priority, tags, actions})`. Publishes to any
>   ntfy server (`NTFY_URL` defaults to ntfy.sh; self-hosting is one env var), falls back to
>   a Mac banner when push isn't configured **or when a configured push fails**. Never throws.
> - `notify` **tool** (`src/tools/notify.ts`) — reversible, always allowed. The agent decides
>   when to interrupt you. This is also how a brief reaches your phone while a watcher stays
>   silent, which is why per-schedule push flags weren't needed.
> - Auto-triggers: confirmation queued (in `broker.ts`, priority 4 + buttons) and unattended
>   run failure (in `runner.ts` — `do` runs don't push, their failure is already on your
>   terminal). `NOTIFY_ON_SCHEDULE` exists but defaults **off** for the reason above.
> - **Remote approval uses single-purpose tokens, not the dashboard token.** A push traverses
>   an ntfy server you may not control, so embedding the dashboard bearer token would hand
>   anyone with the topic name the ability to run the agent and read your mail. Instead each
>   confirmation gets a 24-byte token (`confirmations.token`) that approves or rejects *that
>   one pending action, once* — burned by `setConfirmation`, so replay is inert. Checked with
>   `timingSafeEqual`; `listConfirmations` selects explicit columns so it never reaches a UI.
> - **Rate limiting** in `server.ts`: 240 req/min per IP generally, 20/min on approval-token
>   attempts — the latter is what makes brute-forcing a token hopeless.
> - New config: `NTFY_URL`, `NTFY_TOPIC`, `NTFY_TOKEN`, `DASHBOARD_PUBLIC_URL`,
>   `NOTIFY_ON_CONFIRMATION`, `NOTIFY_ON_FAILURE`, `NOTIFY_ON_SCHEDULE`.
> - Still on you: the transport. `DASHBOARD_PUBLIC_URL` must be a Tailscale/LAN address.
>   Do not port-forward 8787.

*Original plan, kept for reference:*

**Goal.** Briefs/alerts reach you anywhere, and you can approve queued irreversible actions
remotely. This is what makes "it acted while I was away" real.

**Approach.**
- **Push** via self-hosted **ntfy** (privacy-preserving; Pushover as alt). New `src/notify.ts`
  abstraction: `notify(title, body, {actions?})`. Routes to ntfy when `NTFY_URL`/`NTFY_TOPIC` set,
  else falls back to the Mac banner (`mac_control notify`). Scheduler + tools use it.
- **Remote approval.** ntfy action buttons hit `POST /api/confirmations/:id/{approve,reject}`. This
  requires the dashboard to be reachable from the phone — **use Tailscale/LAN, never the public
  internet.**

**Files.** new `notify.ts`; wire scheduler/confirmations to emit push on new confirmations;
`server.ts` auth (see security); ntfy action payloads.

**Acceptance.** A new confirmation sends a phone push with Approve/Reject; tapping approves via the
API; scheduled briefs arrive on the phone.

**Security — REQUIRED before any remote reach.** The API currently binds `127.0.0.1` with **no
auth**. Exposing it beyond localhost demands: (a) a bearer/token check on all mutating routes
(`POST/PATCH/DELETE`), (b) transport over Tailscale/VPN (not a public port), (c) basic rate
limiting. Do **not** expose the dashboard without all three. Approval tokens must be single-purpose
and revocable.

---

## 4. More read-only senses — cheap context to anticipate with  ✅ **BUILT**

> **Status: done.** What shipped, and where it diverges from the plan below:
> - **`weather`** (`src/tools/weather.ts`) — Open-Meteo, keyless, geocode then forecast.
>   `DEFAULT_LOCATION` in `.env` supplies the default so the agent needn't restate it (and
>   it stays out of the audit log's tool args on every call); an explicit `location` still
>   wins, for a located calendar event. WMO codes mapped to plain words, days clamped 1–7.
> - **`git_status`** (`src/tools/git-status.ts`) — branch, upstream ahead/behind,
>   uncommitted files, recent commits. `execFile` with `git -C`, never a shell; the
>   read-only subcommands are fixed in code, so the model picks a repo, not a command.
>   Output is `tagUntrusted` — commit messages and branch names are written by anyone who
>   can push.
> - **Both are gated**, and both new policy sections are **optional in the type and denied
>   when absent**, so a `policy.json` written before they existed can't silently grant a
>   capability that didn't exist when it was written. `policy.weather.enabled` (default
>   false) and `policy.git.repoDirs` (default empty) were added to `policy.json`.
> - Weather is gated even though the endpoint is keyless and read-only: the exposure isn't
>   the response, it's that a daily lookup of your home town tells a third party where you
>   live. That's a decision for the user, not a default.
> - **Reminders reader: not built.** It can't be verified without macOS, and SPEC's own
>   alternative — `read_file` on a markdown todo file — already covers the same ground with
>   no new AppleScript surface.
> - No morning-brief infrastructure was invented; a brief is just a schedule, and a
>   ready-to-paste task for one is in the README.
>
> **Verified:** weather parses real Open-Meteo response shapes and handles unknown place /
> no location / API-down cleanly; `git_status` reports a real repo, and denies a
> non-allowlisted path, a `../` traversal, and a **symlink pointing out of an allowed
> directory**.

*Original plan, kept for reference:*

**Goal.** It can only anticipate as well as it can perceive. Add safe, read-only signals.

**Approach.** Small gated tools:
- **`weather`** via **Open-Meteo** (keyless) — `src/tools/weather.ts`, geocode + forecast. Use it in
  the morning brief and before located calendar events.
- **`git_status`** over allowlisted repo dirs (recent commits / dirty state) — read-only.
- Todos/notes: reuse `read_file` on a markdown file, or a read-only Reminders reader via AppleScript.

**Files.** `tools/weather.ts` (+ others as desired); register; policy gates as needed.

**Acceptance.** `weather` returns a forecast and appears in the brief; `git_status` reports an
allowlisted repo.

**Security.** Read-only, low risk. Open-Meteo needs no key.

---

## 5. The write frontier — draft-not-send  ✅ **BUILT (preferred path)**

> ### Recorded decision — 2026-07-25
>
> **Andrew chose the preferred path: draft-not-send. No OAuth scope was added, and none is
> to be added without a new, explicit decision.** "It would be more convenient" does not
> count as one. `GOOGLE_SCOPES` remains exactly `calendar.readonly` + `gmail.readonly`;
> the token still *physically cannot* send mail or change a calendar. Also recorded in
> `profile.md`, so it's standing context on every run.
>
> **What shipped.**
> - `src/tools/draft.ts` — one `draft` tool, four kinds: `email_reply`, `email`, `event`,
>   `text`. It composes text and nothing else. The file imports `node:fs`, `node:path`, and
>   config — there is no Google client, no `fetch`, no URL anywhere in it, so the "it can't
>   send" claim is a property of the code rather than a promise about the prompt.
> - Classified **irreversible**, which routes it to the confirmation queue. The tier is
>   being used for *review*, not danger: a draft's whole purpose is to reach a human before
>   anything happens, and the queue is already that mechanism.
> - `classify().summary` carries the **entire rendered draft**, because that summary is what
>   you read before deciding. A one-line summary would make approval a rubber stamp.
> - Approving writes a timestamped file to `policy.drafts.dir` and returns the path. That is
>   the only side effect. Still no Google call — approve means "put this where I can send
>   it", never "send it".
> - The filename is built from model-supplied text, so it's containment-checked against the
>   drafts dir; `../` in a subject cannot escape.
> - Rejecting with a reason feeds §6's preference memory, so a draft you didn't want is one
>   it learns not to write. `npm run confirm` indents multi-line drafts as a block, and the
>   dashboard renders the summary `pre-wrap` (it previously collapsed newlines) with a
>   reason prompt on Reject.
> - `policy.drafts` is denied when absent; `drafts/` is gitignored — approved drafts are
>   unsent correspondence.
>
> **Verified:** denied by default; queues rather than executes and writes nothing until
> approved; the full text is reviewable in the CLI; approval writes exactly one file in the
> drafts dir; three `../` traversal attempts all landed inside it; empty bodies rejected;
> a rejection reason is stored and recalled against a later similar draft.

*Original plan, kept for reference:*

**Goal.** Eventually act in the world (reply to mail, create events) — the highest-value, highest-
risk capability.

**Approach & the hard tradeoff.** Today's **strongest guarantee is that the Google token is
read-only by construction** — it *physically cannot* send or modify anything. Real Gmail drafts or
calendar writes need a **write scope**, which destroys that guarantee (a single crafted email
becomes an exploit surface). Two paths:
- **Preferred (keeps read-only):** "drafting" = the agent *generates proposed content* (a reply, an
  event) surfaced to you via the confirm queue / push; **you** send it. No new scopes.
- **Full write (gated):** add a *separate* narrowly-scoped token, behind remote approval (#3), API
  auth, budgets, and an explicit decision recorded in memory. Not before #1–#3 and the trust
  mechanisms exist.

**Acceptance.** Proposed drafts appear as reviewable text in the confirm queue; no write scope is
added without a recorded sign-off.

**Security.** Highest in the system. Read-only Google scope is the crown jewel — the spec's default
is to keep it.

---

## 6. Cross-cutting — earn trust as it acts more  ✅ **BUILT**

> **Status: done — all four bullets.**
> - **Daily digest** — `src/digest.ts`: `npm run digest [hours] [--push]`, plus a `digest`
>   tool. Every figure is a SQL count over `actions` / `confirmations` / `runs` / `memories`.
>   The model is deliberately not involved in producing them: a model summarizing its own
>   behavior is the one report that can't be checked, on the subject where being wrong costs
>   the most. Push priority rises to 4 when something is actually waiting on you.
> - **Learn from rejections** — `rejectConfirmation(id, reason?)` is now async and stores a
>   `preference` memory when a reason is given; §1's auto-recall then surfaces it before
>   similar work. Wired through the `confirm` CLI (`reject <id> [why]`, unquoted) and the API
>   (`{ reason }`). Optional by design — the quick no stays cheap, and the phone's Reject
>   button has nowhere to type.
> - **Budgets + dry-run** — `policy.budgets.perRun` / `perDay`, `default` with per-`tools`
>   overrides, counted from the audit log so no second tally can drift. Only `executed` and
>   `queued` count; a denial must not consume the allowance a legitimate call needs. Absent
>   or `0` = unlimited. `policy.autoExecute.dryRun` reports the decision that *would* have
>   been made and **neither executes nor queues** — a dry run that filled the confirm queue
>   would defeat its own purpose. New `BrokerStatus` value `"dry-run"` so the audit log never
>   implies something happened.
> - **Cloud escalation** — `src/judge.ts`: `judge(question, context, {sensitivity, fallback})`
>   routes with `prefer:"cloud"`, honours `sensitivity:"private"` as a hard local pin, treats
>   its context as untrusted evidence, and never throws (returns `via:"fallback"`). Wired to
>   one real decision: with `JUDGE_INTERRUPTIONS=true`, a priority 4-5 notification must
>   justify overriding Do Not Disturb or it's downgraded to 3. Off by default.
>
> **Verified:** budget denies exactly at the cap and denials don't consume allowance;
> `default`/`0`/absent behave correctly; dry-run writes no kv value and queues nothing;
> a rejection reason is stored and **recalled** by a later semantic lookup; the digest's
> counts match hand-built audit rows, including the empty-window case; `judge` reaches cloud
> normally, local under `private`, and falls back cleanly with both models down.

*Original plan, kept for reference:*

- **Daily "what I did / plan to do" digest** — a scheduled job summarizing `actions` (audit log) +
  pending `confirmations` over 24h, pushed to you. Best single trust-builder.
- **Learn from rejections** — on `rejectConfirmation`, optionally capture a reason and
  `remember(..., "preference")` ("don't auto-do X"); auto-recall (#1) then suppresses similar
  proposals. Wire in `confirmations.ts` + reflection.
- **Budgets / dry-run / rate limits** — per-tool call caps per run/day; a broker `dryRun` mode that
  logs would-run without executing. Extend `broker.ts` + `policy.json`.
- **Cloud escalation for judgment** — route "is this urgent enough to interrupt?" decisions with
  `prefer:"cloud"`; keep everyday tool-driving on local.

---

## 7. Recommended build sequence

1. ~~**Active memory** (#1)~~ — ✅ done.
2. **Push notifications** (#3 push half) — read-only, high value, reach anywhere. **← next**
3. **API auth + remote approval** (#3 rest) — API auth is ✅ done (`DASHBOARD_TOKEN`, enforced by
   a refusal to bind non-localhost without it; see MIGRATION §7). Remaining: ntfy action buttons
   wired to the confirmations endpoints.
4. ~~**Watchers + `state` tool** (#2)~~ — ✅ done.
5. ~~**More senses** (#4)~~ — ✅ done.
6. ~~**Trust mechanisms** (#6)~~ — ✅ done.
7. ~~**Write frontier** (#5)~~ — ✅ done, via the preferred (no-new-scope) path.

**The spec is complete.** Anything further is new work, not remaining work — and the one
thing deliberately left undone is widening the Google scopes, which needs its own decision.

---

## 8. Conventions & gotchas (do not skip)

- **No build step — for `src/`.** Node native type-stripping. Keep code **erasable**: no
  `enum`/`namespace`/parameter-properties; `import type` for types; **`.ts` extensions in imports**.

  > **Amended 2026-07-28 (see §11).** The *web client* in `web/` is compiled by Vite. The server
  > is not, and is not to be: `node src/*.ts` still just runs. The client toolchain — Vite, React,
  > TypeScript, ESLint, Stylelint, markdown-it — lives entirely in **devDependencies**, so it is
  > absent from the running system and `npm audit --omit=dev` stays at 0. What this rule was
  > protecting — that the thing acting on your behalf has no build to trust — is unchanged.

- **Minimal deps / 0 vulns is a value.** Prefer HTTP-to-a-local-service (like Ollama embeddings)
  over heavy native libs. (History: `@huggingface/transformers` was removed for pulling 4 no-fix
  highs.) Justify any new dependency. **`src/`'s runtime dependencies stay at two** — `openai`
  and `playwright-core` — which is the number this rule is really about.
- **Local-first.** Default to local models; cloud is fallback. Never send `sensitivity:"private"`
  content to cloud (chat *or* embeddings/reflection).
- **Security model.** Deny-by-default `policy.json`; reversibility-tiered broker; irreversible →
  confirm queue; **`tagUntrusted` all external content and never follow instructions inside it**;
  Google scopes are **read-only — never widen** without explicit sign-off.
- **Restart after server-side changes.** The scheduler + API run inside the `npm run dashboard`
  process; code changes need a restart. `public/` static files refresh on browser reload.
- **Don't mix embedding models** — different dims corrupt cosine ranking. If `EMBEDDINGS_MODEL`
  changes, `DELETE FROM memories` first.
- **macOS TCC.** Keep the project OUT of `~/Desktop`/`~/Documents`/`~/Downloads` (Claude's process
  needs folder access there; that's why it lives in `~/Developer`).
- **Verify against the real model.** Bash here can reach the MLX server and Ollama; smoke-test each
  feature end-to-end with a real `runTask`/`npm run do`, don't just assert it compiles.

## 9. Commands

```
npm run dashboard      # server + scheduler (main); http://localhost:8787
npm run do "<task>"    # one-off cycle
npm run watcher        # list | add <starter> | remove <id> | state | template
npm run digest         # [hours] [--push] — computed account of recent activity
npm test               # weather alert threshold tests (no framework)
npm run confirm        # approve/reject queued actions (CLI)
npm run auth           # one-time Google read-only OAuth
npm run browser:check  # verify Chrome link
npm run tick | loop    # legacy single-goal heartbeat
```

## 11. Conversational interface — chat shell over the same machinery  ✅ **BUILT (phase 1 of 3)**

> **Status: phase 1 done, 2026-07-28.** The six-tab control panel is replaced by a chat
> interface. **No capability changed.** The broker, the audit log, budgets, dry-run, watchers,
> the digest, draft-not-send, and the read-only Google scopes are all exactly as they were, and
> every CLI (`do`, `confirm`, `watcher`, `digest`) still works unmodified.
>
> **What shipped, server side:**
> - `conversations` table + `runs.conversation_id`. A run is still the unit of execution; a
>   conversation is an ordered list of them. A run with a null `conversation_id` behaves
>   exactly as before, which is why nothing about scheduling had to change.
> - **`src/events.ts`** — an in-process pub/sub keyed by run id, with a bounded replay buffer.
>   `broker.ts` publishes `tool_call` / `tool_result` / `confirmation` beside its existing
>   `logAction` calls; `agent.ts` publishes steps and the final summary; `runner.ts` publishes
>   run start/end and queue waits. Publishing never throws into a run: these events are a *view*
>   of work whose real record is the `actions` log, so a dropped one costs a redraw, never a fact.
> - **`GET /api/runs/:id/stream`** (SSE). Subscribes before replaying the backlog so an event
>   published in between can't be lost, and takes `?after=` so a browser reloading mid-run
>   resumes rather than restarting. Authenticates via `?token=` because `EventSource` cannot set
>   headers — the same localhost hop either way.
> - **`startTask()`** in `runner.ts` returns `{ runId, done }` synchronously, so
>   `POST /api/conversations/:id/messages` answers in milliseconds instead of holding a socket
>   for the length of a cycle. The run row is created *before* the queue, in a new **`queued`**
>   status; `beginRun()` flips it to `running` when the queue reaches it, so the UI can say
>   "waiting for a scheduled job" rather than showing a spinner identical to a hang.
>   `markInterruptedRuns()` now resolves `queued` rows too — the queue is in memory, so a run
>   waiting its turn when the process died is never coming back.
> - **Multi-turn history**, built in `runner.ts` and injected via a new `runAgent` `opts.history`.
>   Deliberately **not** the stored trace: replaying prior tool results would exhaust a local
>   model's context in about three turns. Each past turn contributes what was asked and what was
>   concluded, capped by `CHAT_HISTORY_TURNS` / `CHAT_HISTORY_MAX_CHARS`, oldest dropped first.
>   The full trace of every run stays in `messages` for the Activity view.
> - **Auto-titling** a conversation from its first exchange, pinned `sensitivity:"private"` for
>   the same reason `reflect.ts` is — the first thing you ask may be about your mail.
> - `pendingConfirmationsForRun()`, so a turn's approval prompts survive a reload. Found in
>   testing: without it the inline card vanished the instant the run finished, which is exactly
>   when you want to act on it.
> - Two latent bugs fixed on the way. `llm.ts` now strips chat-template control tokens
>   (`<|im_end|>`) that MLX-LM returns inside `content` — the agent loop never noticed because
>   `extractJson` reads between the braces, but a conversation titled *"Multiplication of 17 and
>   4<|im_end|>"* does. And `weather-alerts.ts` had `export type Thresholds = typeof T` referring
>   to a name that doesn't exist; it survived because types are stripped at runtime.
>
> **What shipped, client side:** `web/` — Vite + React + TypeScript + CSS Modules, one component
> per file, built to `public/` (now gitignored; the old vanilla dashboard is in
> `_archive/public-vanilla/`). Live tool-call cards carrying the broker's decision badge,
> **inline approval cards** with reject-and-say-why, a conversation sidebar, and the former tabs
> as Activity / Automations / Approvals / Settings. Markdown renders through markdown-it with
> `html: false` — assistant text quotes UNTRUSTED web and mail, so raw HTML is never emitted and
> there is no sanitizer to misconfigure. ESLint (with Perfectionist) and Stylelint enforce
> alphabetical ordering; `npm run check` runs typecheck + both linters + the tests.
>
> **Verified end to end** against the real MLX model: live tool cards during a cycle; multi-turn
> continuity ("now double that number" → 136); a queued draft approved inline writing exactly one
> file; a rejection with a reason becoming a recallable `preference` memory; thread rehydration
> after reload with approvals intact; deep links via the SPA fallback; light and dark.

---

## 12. Cost-tiered routing, projects, subagents  ✅ **BUILT, 2026-07-28**

> Phases 2 and 3 of §11, plus the model tiering they hang off. Modelled on the Dispatch
> Claude Code skill: size each task, send the smallest unit that can close it.
>
> ### The measurement that shaped it — read this before "improving" the routing
>
> The obvious design (one model server, a `model` field per request, a cheap classifier
> choosing) is **worse than not routing at all** on this hardware. Measured against the M4
> Mini at 192.168.0.145:
>
> ```
> model swap on one server ....... 1.7s to reach a 3B, 7.9s to get back to the 30B
> staying on one model ........... 0.6s
> answer on standard, direct ..... 873ms
> answer on fast, direct ......... 684ms
> classifier round-trip .......... ~800ms
> ```
>
> Two conclusions, both load-bearing:
>
> 1. **A tier is a separate always-warm ENDPOINT, not a model name.** `mlx_lm.server` holds
>    one model resident. Two pinned servers never swap; one server pays 1.7–7.9s per switch
>    to save 0.2s of generation.
> 2. **Sizing must be free.** A classifier costs 4× what the smaller model saves, because
>    Qwen3-Coder-30B-A3B is a MoE with ~3B active parameters and already runs at 32.7 tok/s
>    against a dense 3B's 39.1. So `dispatch.ts` is regex-first, and a model is consulted
>    only for *escalation* to the cloud tier — a quality decision, worth its latency. Auto
>    -routing earns its keep escalating, never economising.
>
> Also measured, and worth acting on: `Qwen2.5-Coder-14B-8bit` runs at **5.6 tok/s** (~6×
> slower than the 30B, and less capable) and has no role; `Qwen3-4B-8bit` is a *thinking*
> model whose `<think>` blocks make tool calls 5× slower; `Qwen3.5-4B-8bit` does not load
> at all (`Model type qwen3_5 not supported` — mlx-lm is too old).
>
> ### What shipped
>
> - `src/tiers.ts` — `fast` / `standard` / `deep`, each a `{baseUrl, model, apiKey}`.
>   `FAST_LLM_URL` unset resolves fast→standard, so none of this has to be switched on.
>   `resolveTier` is the single place `sensitivity:"private"` is enforced as a hard local
>   pin, so it can be got wrong in exactly one place rather than at every call site.
> - `src/router.ts` rewritten around tiers, with fallback that only ever moves *downward
>   into local* — a tier being unreachable must never quietly upgrade a private request.
> - `src/dispatch.ts` — `sizeTask()`. Regex de-escalation (free), model escalation (gated on
>   deliberative language). 20 assertions in `test/dispatch.test.mjs`, including the
>   regression that matters: *"Is it worth switching to a monorepo?"* parses as a yes/no
>   lookup and must not be demoted to the smallest model. Deliberative language is checked
>   **before** the lookup rule for exactly that reason.
> - `src/projects/` — `store.ts`, `ingest.ts`, `recall.ts`, `narrow-policy.ts`.
>   `chunks` is a separate table from `memories` on purpose: a memory is a trusted
>   conclusion about the user, a chunk is verbatim file text, and sharing a table would put
>   them one query away from sharing an injection path. **Instructions inject as SYSTEM,
>   document excerpts as an UNTRUSTED USER message** — hence `AgentOpts.knowledge`
>   alongside `context`. `narrowPolicy()` is intersect-only with 23 assertions, because a
>   project row is writable through an API the agent can reach.
> - `src/fs-scope.ts` — the containment check extracted from `read-file.ts` so the indexer
>   and the tool cannot drift. Re-checked **per file** during a directory walk; verified a
>   symlink planted inside an indexed folder cannot pull secrets in.
> - `src/agents.ts` + `src/tools/subagent.ts` + `agents/*.md` — the five Dispatch units.
>   Tools are an intersection, budgets bill the root run, the child's summary returns
>   UNTRUSTED, depth is capped, and the tool calls `runAgent` **directly** because
>   `runTask` would re-enter the serial queue the caller is already holding.
>
> ### Four bugs found by building this
>
> - **The forgiving parser didn't accept inlined arguments.** Local models most often emit
>   `{"action":"weather","location":"Boston"}` for multi-argument tools, not
>   `{"action":"weather","args":{…}}`. Two-argument tools like `subagent` were therefore
>   effectively uncallable — every attempt arrived with empty args and was denied.
> - **The shorthand path resolved against `registry`, not the visible tool set**, which
>   would have let a restricted subagent reach any tool by naming it as the action.
> - **A circular import** (`subagent → agent → tools/index → subagent`) that only fails on
>   certain entry orders. Broken with a call-time import plus dropping a redundant registry
>   check in `agents.ts`.
> - **`Object.entries` order made the deliberative check unreachable** for question-shaped
>   trade-offs; see the dispatch test above.
>
> **Verified end to end** against the real MLX server: delegation with no deadlock (parent
> standard → tracker on fast → `git_status` → UNTRUSTED summary back); budgets exhausted by
> a parent correctly deny the child, and the old billing would have reset them; project
> documents answered a question nothing else in the model knew; `/etc` and a symlink escape
> both refused; tier badges and nested delegation cards render in the thread.

---

## 13. Interface polish and document handling  ✅ **BUILT, 2026-07-28**

> - **Palette.** Moved off the warm terracotta/cream scheme, which read as Anthropic's, to
>   cool slate neutrals with an indigo accent. Two constraints drove the choice: the accent
>   must not read as any of the *semantic* colours — green/amber/red are the broker's verdict
>   on every tool call, so an accent near them makes a badge look like a button, which rules
>   out teal and orange — and every tint is now a variable (`--*-soft`, `--*-line`,
>   `--on-accent`) so retheming is one file and no component knows a literal colour.
>   `--on-accent` exists because the accent inverts between modes: white on mid-indigo in
>   light, near-black on pale indigo in dark, and `#fff` would fail contrast in one of them.
>
> - **Narrow viewports.** Below 820px the sidebar becomes a drawer with a scrim, a top bar
>   carrying the current view's name, and Escape-to-close; below 640px view padding shrinks
>   and the run table drops its timestamp column. Two real bugs surfaced only by testing at
>   375px: `main` let the whole shell scroll sideways, which dragged the off-screen drawer
>   into view; and `.page` had `margin: 0 auto` inside a flex column, which makes an item
>   shrink to fit-content and *clip* rather than fill. Wide content now scrolls inside its
>   own container and the shell never scrolls horizontally.
>
> - **Document formats** — `src/projects/extract.ts`. `textutil` (macOS built-in) for
>   rtf/doc/docx/odt/html, and optional `pdftotext` for PDF. **No npm dependencies**: a
>   document parser is a large attack surface pointed straight at untrusted input, and this
>   project already removed `@huggingface/transformers` over exactly that trade. `execFile`,
>   never `exec` — no shell, so a filename containing `;` or `$()` is an argument and cannot
>   be anything else — with a timeout and an output ceiling per invocation. A format with no
>   converter is skipped with a status naming the command that fixes it, rather than failing
>   silently and leaving you wondering why a document you clearly added is unsearchable.
>
> - **Incremental indexing.** A size+mtime fingerprint per file; only changed files are
>   re-extracted and re-embedded, and files that vanished have their chunks dropped. The
>   deletion half is the one that matters: an index that keeps answering from a document you
>   removed is worse than no index, because nothing in the answer reveals it is stale.
>   `force` rebuilds everything, for when the *embedding model* changed rather than the
>   files — a timestamp cannot see that. 14 assertions in `test/ingest.test.mjs`.
>
> - **Tier override.** `conversations.tier` was a column nothing read. Now settable through
>   `PATCH /api/conversations/:id`, applied in `POST /messages`, with an Auto/Fast/Local/Cloud
>   picker beside the composer — so "use the good model for this whole thread" is sayable,
>   which matters because a regex sizer cannot know that *this particular* question is hard.

---

---

## 14. Ledger retention  ✅ **BUILT, 2026-07-28**

> The ledger only ever grew. Measured on a real profile: ~16KB per run, about 22MB a year at
> four scheduled jobs a day. SQLite is untroubled by that, but the Activity list and the
> digest both scan it, so the failure mode is gradual degradation rather than a clear break —
> the kind you notice a year late.
>
> Default retention is **90 days**, split three ways because the parts are not the same size:
> conversation traces are ~61% of the bytes, the audit log ~36%, and the run rows themselves
> only **~3%**. That last figure is the useful one: `RUN_RETENTION_DAYS=0` keeps the whole
> Activity index for almost nothing while still discarding the bulk. `RETENTION_DAYS` sets
> all three; `0` anywhere means keep forever.
>
> `store.pruneLedger()` runs on dashboard boot and daily, plus `npm run prune [--dry]
> [--vacuum]`. Two things it refuses to remove at any age, and both are correctness rather
> than policy:
>
>   1. **A run holding a pending confirmation.** Deleting it orphans a question still waiting
>      on the user — the confirmation would point at a run that no longer exists, and the
>      Approve button in a phone push would answer into a hole.
>   2. **A run that hasn't finished.** A row stuck open is a bug to investigate, not garbage
>      to collect, whatever its timestamp says.
>
> Conversations left with no runs are removed as well: a thread that opens onto nothing reads
> as data loss rather than as retention. Deleting does not shrink the file — SQLite reuses
> freed pages — so `VACUUM` is separate and opt-in rather than a surprise rewrite of the
> database on a schedule.
>
> **This changes a documented promise.** `store.ts` and the README both said the audit log was
> kept "forever"; both now say what is actually true, with the variable that restores the old
> behaviour. A doc that disagrees with the code is worse than either.
>
> 21 assertions in `test/prune.test.mjs`, weighted toward the two refusals.

---

## 15. Meetings — listen, transcribe, extract  🟡 **PHASES 1–2 BUILT, 2026-07-30**

> **Goal.** Sit a Mac in the room where a meeting is happening, transcribe it locally, show
> the words live, pull work items out afterwards, and answer questions about it a few seconds
> later. The work laptop is locked down and cannot run any of this; a second Mac hears the
> room acoustically, which means **no meeting bot, no system-audio driver, no software on the
> work machine at all** — and also means the work laptop's speakers must be on. Headphones
> and the whole thing captures only one side.
>
> ### The measurements, taken 2026-07-30 — these drove every decision below
>
> **Transcription** (M3 Pro, 18 GB, whisper.cpp 1.9.1, against a real 27-minute recording):
>
> | | Model | Result |
> |---|---|---|
> | Full recording | `large-v3-turbo` | 2m28s — **11x realtime** |
> | 5s chunk | `large-v3-turbo` | 1.72s |
> | 5s chunk | `base.en` | **0.35s** |
> | 30s chunk | `base.en` | 1.03s |
>
> Whisper always processes a 30-second window internally, so a 5s chunk costs nearly what a
> 30s chunk does. That is a floor, not something a smaller chunk size buys back — hence
> `MEETING_CHUNK_SECONDS` defaulting to 5 rather than 1.
>
> **The LLM** (Mac Mini M4, 32 GB, `Qwen3-Coder-30B-A3B-4bit-DWQ`):
>
> | | |
> |---|---|
> | Generation | 35 tok/s |
> | Prefill, cold | ~340 tok/s |
> | Prefill, append-only prefix | **flat ~1.1s regardless of length** |
> | Model swap | 7.8s |
> | 3B fast tier | 42 tok/s, 0.5s round trip |
>
> **Retrieval** (M3 Pro): embed one query 63ms; cosine over 50,000 chunks 101ms. ~165ms end
> to end, so the always-on lane costs nothing worth measuring.
>
> ### The finding that shapes the coaching feature
>
> Same model, same information, only the **order** of the prompt changed:
>
> | Transcript | Volatile context at the FRONT | Volatile context at the END |
> |---|---|---|
> | 900 tok | 2.7s | 2.6s |
> | 1,700 tok | 4.4s | **1.1s** |
> | ~9,000 tok (45-min meeting) | ~26s | **~1.1s** |
>
> A stable, append-only prefix lets MLX-LM reuse its KV cache and prefill only the delta.
> Freshly-recalled memories inserted at the front — which is exactly what `agent.ts:136` does
> today, correctly, for the general agent loop — invalidate everything after them.
>
> **So the meeting path must invert the normal layout**: stable prefix first (system prompt,
> tools, transcript-so-far), volatile retrieved context last, immediately before the query.
> Do not "fix" `agent.ts` to match; front-loading trusted context is right for ordinary runs.
>
> ### Phase 0 result — run before building, and it changed the plan
>
> Extraction over the real transcript: summary, topics and decisions were **good**, with
> every quote verified as real and correctly located; it even caught a `Java`→`Jira`
> transcription error unprompted.
>
> Work items were **5 out of 5 false positives**, every one stamped `confidence: high`. Each
> quote was real; each described something already *finished* — "we **came up with**
> guidelines", "we **went** git native", "we **created** templates". The model converts past
> accomplishments into future tasks and is completely confident doing it. **Its self-reported
> confidence carries no information** and must not be surfaced as if it does.
>
> A strict second pass — re-read the surrounding passage, ask "future commitment or already
> done?" — correctly rejected **3 of the 5** at ~2.3s each. Better, not sufficient.
>
> **Therefore work items must land in the confirmation queue, never straight into RAG.**
> Extraction proposes; the human disposes. Summary, topics and decisions may auto-save.
>
> Caveat on the sample: the test recording is a *conference talk*, so the correct answer was
> near-zero work items. It measures over-extraction well and says nothing about recall.
> **Re-run Phase 0 against a real multi-person meeting before building Phase 2.**
>
> ### Machine split
>
> The 30B MoE needs ~17 GB resident, so a 16 GB Mini cannot host it and neither can the
> 18 GB MacBook. Transcription and inference must also not share a GPU or they stutter
> together at the worst moment.
>
> - **Mac Mini 16 GB — the ears.** Capture, Whisper, embeddings, dashboard. ~4 GB.
> - **Mac Mini 32 GB — the brain.** Unchanged.
> - **MacBook Pro 18 GB — the viewer.**
>
> ### Phase 1, built
>
> `src/senses/listen.ts` (ffmpeg avfoundation → chunked Whisper → segment events),
> `src/meetings/store.ts`, `src/meetings/session.ts`, `/api/meetings/*` including an SSE
> stream, a `MeetingsView`, `npm run listen`, and 34 assertions in `test/meetings.test.mjs`.
>
> Decisions worth not relitigating:
>
> 1. **`policy.audio` inverts the allowlist convention.** `devices: []` means **no**
>    microphone, not any. An empty allowlist is a fine default for reading public web pages
>    and a bad one for a microphone, where the cost of being wrong lands on people who never
>    agreed to be recorded. `announce` speaks a line on start for the same reason.
> 2. **The UI click is the consent; the tool call is not.** Starting capture from the
>    dashboard runs directly — a human pressing Record has already given the only consent the
>    queue collects, and routing it through an approval they must then go and grant is
>    theatre. A `meeting_start` *tool* has no human in it and must be queued.
> 3. **One microphone, one session.** `active` is a module-level singleton, so a second
>    concurrent capture is impossible in the data model rather than merely discouraged. This
>    is why meetings are a top-level section and not a Record button inside each project.
> 4. **Both transcription passes are kept.** Overwriting the live rows would be tidier and
>    would mean a failed final pass leaves *no* transcript. A rough transcript beats a clean
>    error.
> 5. **Filing is separate from capture, and happens after.** A finished meeting becomes a
>    `project_sources` row of kind `meeting` — a column that existed since projects were
>    built and had never had a second value. Its chunks go in the same `chunks` table, so
>    project recall picks it up with no second retrieval path. Verified: 33 chunks in 2.8s,
>    and a query about traceability returned the right passage.
> 6. **Name corrections are substitution, not a decoder prompt.** Measured: a glossary prompt
>    fixed `chat GPT`→`ChatGPT` and still produced **"PLOD"** for *Claude* in both passes.
> 7. **Audio is never *retained*.** Held in memory, bounded by `MEETING_MAX_MINUTES`; each
>    chunk touches disk only as a temp WAV unlinked in a `finally`, because `whisper-cli` has
>    no stdin mode. Point `TMPDIR` at a RAM disk if that distinction matters to you.
> 8. **Transcripts prune on their own 30-day window** while meeting rows outlive them.
>
> Also fixed here: `indexSource` would have walked `meeting:12` as a relative path, failed the
> allowlist, and overwritten a good status with a denial. It now skips non-`path` kinds.
>
> ### Verified live, 2026-07-30
>
> **Live microphone capture runs.** The ffmpeg-to-avfoundation path was the one link never
> exercised — everything downstream was proven against the real recording, but the microphone
> itself was left untested rather than record the room unprompted. `npm run listen record`
> closed it, with `policy.audio.enabled` true and `MacBook Pro Microphone` allowlisted.
>
> Note what that smoke test does and does not cover. It exercises ffmpeg → chunking → the
> live Whisper pass → segment events. It does **not** touch the meeting row lifecycle, the
> final pass, the SSE stream, or extraction — those are proven against the file-based path
> instead. A dashboard Record → Stop → extract run is the one remaining end-to-end gap, and
> it is now a small one: every piece in it has been exercised, just not in that order.
>
> ### Phase 2, built
>
> `src/meetings/extract.ts`, two new tables (`meeting_extractions`, `meeting_work_items`),
> `POST /api/meetings/:id/extract`, the extraction panel in `MeetingsView`, and 60 assertions
> in `test/meeting-extract.test.mjs`. Extraction runs detached after the final pass so it
> never holds the retained audio, and carries its own status: a meeting whose extraction fails
> is still `done`, because the words are the part that cannot be recovered.
>
> **Three gates, cheapest first.** Anchoring (free) rejects a quote that is not in the
> transcript — the model writing its own evidence — and runs before the expensive gate so a
> fabrication costs no inference. The strict second pass (~2.3s) asks the one question the
> first pass gets wrong. A human is the last gate, not the fallback.
>
> **Measured after building, both directions:**
>
> | Sample | Correct answer | Result |
> |---|---|---|
> | The 27-min conference talk | ≈ zero work items | **4 of 4 rejected**, each citing the deciding words |
> | Synthetic sprint review, 2 real commitments + 3 accomplishments | 2 | **2 of 2 queued** with owners; the accomplishments were never proposed |
>
> 1,978 words extracted in 53s — comfortably inside the ~1 minute per half hour estimate.
> Neither sample measures **recall**; that still needs a real multi-person meeting.
>
> Decisions worth not relitigating:
>
> 1. **Anchoring is loose on purpose, and asymmetrically so.** A model retyping a line drops
>    filler and repunctuates, so matching is on words alone, and a quote missing an exact
>    match still anchors if **eight consecutive words** of it appear. Eight is far more than
>    invention lands by accident and far less than a faithful retype needs.
> 2. **An unreadable verdict means rejection.** `parseVerdict` defaults to `neither`, never
>    `commitment`. A garbled reply is not permission to spend a human's attention.
> 3. **Unverified candidates are not queued.** If the strict pass could not run — the call
>    failed, or the per-meeting cap hit — the item is stored and shown, not proposed. Given a
>    measured 5-in-5 false-positive rate, an item nobody checked is noise with a timestamp.
> 4. **Rejected candidates stay on screen, greyed, with the reason.** Showing only survivors
>    would be tidier and would hide the number that justifies this whole design. It is also
>    the fastest way to notice the verifier starting to reject real work.
> 5. **Quotes prune with the transcript; everything else outlives it.** A summary describes a
>    meeting, a quote is a copy of it. Keeping quotes past the 30-day window would leave the
>    sharpest sentences on disk precisely because a model found them notable.
> 6. **Windows do not overlap.** An item split across a boundary is worth less than the same
>    item proposed twice with two different quotes; the merge dedupes either way.
> 7. **Decisions and work items are told apart in the prompt.** Without that line the model
>    listed every assignment as both. Auto-saving a decision is fine; auto-saving a task
>    wearing a decision's hat is the rule being routed around.
>
> Still worth trying: plain `Qwen3-30B-A3B-Instruct` via `MEETING_EXTRACT_BASE_URL`. The
> current `LOCAL_MODEL` is a *Coder* fine-tune doing conversation analysis — the wrong tool at
> identical cost, and the knob to compare them is now in place. All the numbers above are the
> Coder tune's, so that comparison has a baseline.
>
> ### Phase 3, built
>
> `src/meetings/context.ts`, a `context` event on the meeting stream, a sidecar beside the
> live transcript, `GET /api/meetings/:id/context`, and 18 assertions in
> `test/meeting-context.test.mjs`. Refreshes on a timer while capture runs; measured **22ms**
> end to end against a 15-chunk corpus, so the ~165ms budget holds with room to spare.
>
> Verified: a live meeting saying *"how do we link a requirement to the test cases that cover
> it"* surfaced, from an earlier meeting filed under the same project, the passage *"We managed
> many-to-many traceability. So one requirement can have many test cases."* That is the feature
> working.
>
> Decisions worth not relitigating:
>
> 1. **One embed, three cards.** `scoreChunks` and `recallScored` both take an optional
>    pre-computed vector. Embedding is 63ms and a cosine sweep is 101ms, so ranking three
>    corpora against one question pays for the embed once. A fourth card costs a sweep.
> 2. **Past meetings and project documents are one retrieval, partitioned after.** A filed
>    meeting is a `project_sources` row of kind `meeting` in the same `chunks` table. Slicing
>    to a top-k before partitioning would let a run of strong document hits starve the meetings
>    card of a transcript sitting just below the cut. `chunksForProject` joins `kind` in rather
>    than sniffing the `meeting:12` prefix, which would misfile a directory named `meeting:`.
> 3. **Two thresholds, because one does not work.** Measured noise floor with
>    `nomic-embed-text`: off-topic 0.41–0.45, generic software chatter 0.55, on-topic
>    0.60–0.74 — hence an absolute floor of **0.58**. That floor cannot separate same-domain
>    also-rans: a passage about screenshots scored **0.618** against a traceability question
>    purely for being in the same talk, against **0.708** for the right one. So a **relative
>    gap** (0.9 × best) runs as well. Both numbers belong to the embedding model, not the idea.
> 4. **An empty card renders as nothing.** No placeholder, no padding to k. A ranking always
>    returns something, so a card that always has content teaches you to stop reading it.
> 5. **No embedder means no cards at all.** The keyword fallback returns word-overlap *counts*,
>    not cosine similarities — an overlap of 3 sails past a threshold meant for [0,1]. Rather
>    than teach the filters two scales, the panel stays dark.
> 6. **Context events do not accumulate in the replay buffer.** Cards are current state, not a
>    log; a three-hour meeting refreshing every 15s would push 720 of them through a 500-event
>    buffer and evict the transcript a reconnecting browser needs.
> 7. **Retrieval only, and this is a hardware fact.** 165ms can run behind a live transcript;
>    35 tok/s cannot. The moment a "just summarise the cards" call lands here the feature stops
>    being always-on and becomes a queue of stale summaries.
>
> Caught by the tests, worth knowing: `Math.max` of anything and NaN is NaN, so one unscored
> hit made the relative gap NaN and silently emptied a card that also held a good one.
>
> ### Phase 4, built
>
> `src/meetings/coach.ts`, `POST /api/meetings/:id/coach`, a `coach` event, a ⌘/ hotkey and an
> answer panel at the top of the sidecar, and 20 assertions in `test/meeting-coach.test.mjs`.
> Prompt order is **system → transcript-so-far → retrieved context → the question**, per the
> finding above, and the tests assert that order directly because a tidy-up that "fixed" it to
> match `agent.ts` would break nothing any other test can see.
>
> **Re-measured 2026-07-30, and the original table needs qualifying.**
>
> The first attempt showed *no* difference between the orders. That run was wrong: it held the
> retrieved context constant between presses, which makes **both** orders append-only. In real
> use retrieval runs again on every press and the context text differs — which is the entire
> point, because a changed block at the front invalidates the transcript behind it.
>
> With the context varying per press, at ~2,631 tokens of transcript, averaging presses 2–3:
>
> | | Prefill (`max_tokens=8`) | End to end (`max_tokens=220`) |
> |---|---|---|
> | Context LAST (built) | **3,608ms** | 5,910ms |
> | Context FIRST | 9,238ms | 4,679ms |
>
> Two corrections to carry forward:
>
> 1. **The effect is real and large — 2.6× — but it lives in *prefill*.** End-to-end is noisy
>    because generation length varies per answer and swamps the difference at this transcript
>    size. Measure prefill when testing this, not wall clock. The prefill saving grows with
>    the transcript while generation does not, so on a 45-minute meeting the ordering becomes
>    the dominant term — which is what the original table was showing.
> 2. **"Flat ~1.1s regardless of length" did not reproduce.** Context-last measured 3.6s at
>    2,631 tokens, not 1.1s. The *ratio* holds; the absolute floor is higher than recorded.
>    Treat the 1.1s figure as unverified until someone re-runs it.
>
> Decisions worth not relitigating:
>
> 1. **The transcript is trimmed in blocks, never by a sliding window.** A sliding cap moves
>    the first byte of the prompt every few seconds and destroys exactly the property this is
>    built on. Blocks mean one expensive re-prefill per `MEETING_COACH_BLOCK` segments instead
>    of one per keypress, and the tests assert the prefix holds still between jumps.
> 2. **Single-flight.** Three presses in five seconds produce one answer, not three queued
>    ones arriving after the moment has passed. The second press is told the first is working.
> 3. **The previous answer stays on screen while the next generates.** Blanking it would clear
>    the panel for exactly the five seconds you are most likely to be reading it.
> 4. **Notes, not a script.** The prompt asks for 2–4 bullets leading with a number, a name or
>    a decision already made, and explicitly permits "nothing on this". Five seconds is a long
>    silence and reading off a second screen is visible on camera; the useful artefact is the
>    card you would have written beforehand, not a sentence to recite.
> 5. **The answer shows the question it answered.** The transcript is rough, and an answer to
>    a misheard question should be obvious at a glance rather than merely puzzling.
>
> ### Standing constraint
>
> Meeting work is **local-only**. `CLOUD_ENABLED` plus `JUDGE_ESCALATION` means a
> deliberative-looking task can escalate to `gpt-4o`, and the temptation to allow it arrives
> exactly when you are mid-meeting and impatient. Pin it with a project policy overlay
> (`narrow-policy.ts`) before that moment, not after. Recording other people is also the one
> capability here whose risk lands on someone who is not the operator; consent law varies by
> state and employer policy is a separate question from the law.

---

**Original phase 2/3 sketch, kept for reference:**
- **Projects** — per-project instructions plus documents indexed from allowlisted paths into
  scoped chunks. Two trust tiers, and they must not enter the prompt the same way: instructions
  are human-written and go in as a **system** message like `profile.md`; document chunks are file
  contents and go in `tagUntrusted`-wrapped as a **user** message, never system. Optional
  per-project policy *narrowing* — intersection only, never widening.
- **Subagents** — `agents/*.md` definitions and a `subagent` tool. Five constraints: it calls
  `runAgent` directly, never `runTask` (the parent already holds the serial queue, so that
  self-deadlocks); the child's tool set is an *intersection*, never a grant; child calls go
  through the same broker and policy; `executeCall` must take a root `budgetRunId` so per-run
  budgets count across the tree rather than resetting per child; and the child's summary comes
  back `tagUntrusted`.

---

## 10. Data model additions this spec introduces

- `conversations` table (§11): `id, project_id, title, created, updated, archived`; `runs` gains
  `conversation_id` (indexed) and a `queued` status.
- `kv` table (state watchers): `key TEXT PRIMARY KEY, value TEXT, updated TEXT`.
- `meetings` + `meeting_segments` tables (§15): a capture session and its transcript, the
  latter carrying a `pass` (`live` | `final`) so both survive. `project_sources.kind` gains
  its first non-`path` value, `meeting`.
- `meeting_extractions` + `meeting_work_items` (§15 Phase 2): what was made of a transcript.
  Work items keep their `verdict` — including the refusals — so the extraction's
  false-positive rate stays visible rather than being edited out of the record. A queued item
  holds the `confirmation_id` it raised; approving that confirmation is what runs
  `memory_save`, and is the only path from a meeting into long-term memory.
- `memories` gains heavier use (kinds: `reflection`, `preference`, `profile`); consider an index on
  `kind`.
- No schema change needed for push/auth/digest (use existing `actions`/`confirmations`).
