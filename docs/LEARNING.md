# Learning and initiative

AgentSpine today learns exactly three things, and they are all facts about **you**:
`reflect.ts` extracts durable statements from a finished trace, a rejection with a reason
becomes a `preference` memory, and `profile.md` holds what you typed by hand. All three
feed one place — `buildContext` in `runner.ts`, which puts the profile and the k most
relevant memories ahead of every goal.

What it does not learn is anything about **itself**. The `actions` table records the
broker's verdict on every call ever made, `confirmations` records every yes and every no,
`runs` records every outcome — and the only code that reads any of it is `digest.ts`,
which describes the past and changes nothing about the future.

This document is the plan for closing that loop, and then for pointing the result at work
you did not ask for. It is ordered so that each phase is useful alone and none of it
depends on a phase that hasn't shipped.

## The invariants none of this may break

Every item below was checked against these first. If a future idea can't satisfy them,
that is the answer, not a thing to design around.

1. **The model never widens its own permissions.** `tools/schedule.ts` already states it:
   "a run that could widen its own permissions would make deny-by-default a suggestion."
   Learners may *propose* a policy change. The write happens in the server, from a human
   click, and never from a tool call.
2. **Nothing derived from UNTRUSTED content becomes standing context without a human
   reading it.** `reflect.ts` gets this right — its prompt treats the trace as hostile and
   its output is constrained to short third-person statements. Every new learner inherits
   the rule. Phase 5 is where it gets hard.
3. **Learning never fails a run.** Reflection swallows every error by design. So does
   everything here. A learner runs after the work is persisted, or not at all.
4. **Private traces stay local.** `sensitivity:"private"` on any pass that reads a trace.
   Escalation is not a back door, and a learner is not an exception.
5. **Every derived memory kind gets its own ceiling.** `REFLECT_MEMORY_MAX` and
   `NOTE_MEMORY_MAX` exist so one weird run cannot flood recall. Three new kinds means
   three new caps, wired into `prune.ts` alongside the others.

---

## Phase 0 — Measure first  ✅ **BUILT, 2026-09-10**

> **Status: done.** All five metrics compute in `buildDigest`, `confirmations.resolved`
> exists, and a real `npm run digest` prints them. What shipped, and where it differs from
> the plan below:
> - The five metrics render under a **"The numbers (<window>)"** block, placed just before
>   "WAITING ON YOU" so the action items stay last. Each line is gated on having data, so an
>   empty window prints nothing rather than a wall of `—`.
> - **New store queries**, all SQL, no model: `confirmationsResolvedSince()` (keyed on
>   `resolved`, not `ts` — a decision made today about yesterday's question belongs to today),
>   `runStepCountsSince()` (each finished run's task + its `messages` count). Clustering stays
>   in `digest.ts`; the DB only supplies the pairs.
> - **Steps per repeat task** clusters on a crude normalized task key (lowercased,
>   whitespace-flattened, trailing punctuation trimmed). A cluster counts as a "repeat task"
>   only at ≥2 runs, and the reported figure is the **median of each cluster's median**, so one
>   chatty recurring job cannot dominate. Anything cleverer than the normalizer would be a
>   similarity model wearing a `GROUP BY`, which is not what a baseline should be.
> - `resolved` is stamped by `setConfirmation` with `COALESCE(resolved, now())`, so **only the
>   first transition out of 'pending' sets it** — a row cannot be "answered twice", and the
>   best-effort `ALTER` leaves every pre-existing row honestly **null** rather than back-dated.
>   Verified: re-running `setConfirmation` does not move the timestamp.
>
> **The honest gap this leaves:** approval latency and rejection rate only produce numbers for
> confirmations **resolved from now on**. Every row that predated the column is null and
> excluded, by design — a back-dated latency would be a fabricated baseline. So the "week of
> numbers before anything else lands" starts accumulating today, not retroactively.
>
> **First real reading (100,000h window, this profile):** denied-call rate 0.9% (2/227 calls);
> steps per repeat task 18.0 median across 7 recurring tasks. Tool-error, rejection and latency
> lines were empty for lack of qualifying rows — which is the metrics correctly saying "no data
> yet", not a bug.

*Original plan, kept for reference:*

**Ship this before any learner.** Without a baseline, "the assistant got better" is a
feeling, and the repo already has a standard for this: the digest's numbers are computed
in SQL precisely because a model's summary of its own performance is the one artifact you
cannot check.

Add to `buildDigest` in `digest.ts`, all from tables that already exist:

| Metric | Query | What it tells you |
|---|---|---|
| Denied-call rate | `actions` where `decision='denied'` ÷ total calls | How much of every run is wasted re-attempting forbidden things |
| Tool error rate | `actions` where `decision='error'`, grouped by `tool` | Which tool the model cannot drive |
| Steps per repeat task | `runs.task` clustered, median `messages` count per cluster | The one number recipes are supposed to move |
| Rejection rate | `confirmations` where `state='rejected'` ÷ resolved | Whether proposals are getting better or worse |
| Approval latency | `confirmations.ts` → `setConfirmation` timestamp minus queue timestamp | Whether the queue is being read or ignored |

Approval latency needs a column. `confirmations` has `ts` and `state` but not a resolved
timestamp — add `resolved TEXT` with the same best-effort migration pattern already used
further down `store.ts`.

**Done when:** `npm run digest` prints all five, and you have a week of them recorded
before anything else lands. — *The first half is done (2026-09-10); the week of recorded
numbers is now just calendar time, and the prerequisite for starting Phase 1.*

---

## Phase 1 — Learn from the ledger (no model calls, no new trust surface)  ✅ **BUILT, 2026-09-10**

> **Status: done — all three.** Everything here is SQL and regex; a grep for a model call in
> `src/learn/` finds nothing, which is the property that let it go first. Modules live in
> `src/learn/` (`denials.ts`, `friction.ts`), deliberately outside `src/tools/` — none of this
> is a capability the model may invoke. What shipped, and where it differs from the plan below:
>
> - **1.1 denial learner.** One SQL query, `store.deniedShapes()`, feeds both outputs.
>   `deniedContext()` injects the known-denied block into standing context from
>   `buildContext` in `runner.ts` (wrapped so a learner can never fail a run);
>   `deniedProposals()` renders a "Worth deciding" block in the digest for any shape denied
>   `DENIAL_PROPOSE_MIN` times. Verified: a shape denied 4× appears in both, the reason is
>   cleaned of its `DENIED:` prefix, and a shape denied once shows in context but not in the
>   proposals.
> - **1.2 tool-friction memory.** `friction` is its own memory kind with a **`tool` column**
>   (added to `memories` in `rag.ts`), so the recall is an exact per-tool SQL match, not a
>   text sniff — and it needs no embedding, which keeps it off the hot path. `classifyError`
>   is a fixed regex table (`recordFriction` in the broker's error path); the correction is
>   appended to the tool's own description by `frictionDocs` in `toolDocs`. Verified:
>   timeout/404/robots classify correctly, an unknown error falls back to a trimmed one-liner,
>   an exact duplicate is not stored twice, and the line reads "2× timeout; blocked". The cap
>   is enforced **per tool at write time** and again by `pruneFriction` — a global
>   `pruneMemories("friction", n)` would have let one noisy tool evict another's, so that is
>   *not* what runs.
> - **1.3 rejection symmetry.** A bare "no" stays free. The reason-less branch of
>   `rejectConfirmation` now calls `noteSilentRejection`, which counts the `(tool, target)`
>   shape in `kv` under `reject:shape:*` (the shape is built from the tool's own `classify`,
>   the same code the broker uses, so it matches what a future proposal will present) and, on
>   the `REJECT_PROMOTE_AFTER`-th silent reject, writes a `preference` memory **in code** and
>   resets the counter. Verified: counter goes 1→2→(promote + clear), and the promoted text is
>   recalled by §1's auto-recall.
>
> **Config knobs** (all in `.env.example`): `DENIAL_PROMPT_MAX=5`, `DENIAL_PROPOSE_MIN=3`,
> `FRICTION_MEMORY_MAX=5` (per tool), `REJECT_PROMOTE_AFTER=3`.
>
> **The measurement that judges this is Phase 0**, which now records the denied-call rate and
> tool-error rate. 1.1 should push the first down and 1.2 the second; if after a week of real
> use they do not move, the plan below already says the answer is to delete the learner, not
> tune it. Typecheck and the full suite (19 files) pass; no new test file was added — flagged
> in the summary as the one gap worth closing next.

*Original plan, kept for reference:*

The cheapest wins in the system. Every one of these is a SQL query and a string, with no
inference anywhere, which means none of them can be talked into anything.

### 1.1 The denial learner

`SELECT tool, target, COUNT(*) FROM actions WHERE decision='denied' GROUP BY tool, target`
is the highest-value untouched query in the database. Each row is the model attempting
something policy forbids, and today it costs a wasted turn *every run, forever* — the
broker denies it, the model reads DENIED, and nothing anywhere remembers.

Two outputs from that one query:

**A known-denied block in standing context.** New module `src/learn/denials.ts`, called
from `buildContext` in `runner.ts` alongside the profile and recall. Cap it at the top
handful by count, phrase it flatly:

```
Calls the broker has already refused, with how many times you have tried:
- mac_control on com.apple.Notes (14) — not allowlisted
Do not attempt these. If the goal needs one, say so in your summary instead.
```

It is a system message, and legitimately so: it is derived from your own audit log by SQL,
with no outside content in it.

**A weekly proposal.** Anything denied more than N times becomes a line in the digest:
"you've denied `mac_control` on `com.apple.Notes` 14 times — allowlist it, or should I
stop proposing it?" That is a question with two useful answers and no bad one.

**Cost:** one indexed query per run, zero tokens beyond a few lines of prompt. It should
*reduce* total tokens by killing repeat attempts — Phase 0's denied-call rate is how you
confirm that rather than assume it.

### 1.2 Tool-friction memory

When a call comes back `decision='error'`, store `(tool, error class, the call that
preceded it)` as memory kind `friction`. The clever part is where it is recalled: not into
the goal, but into **the tool's own description**, appended by `toolDocs` in `agent.ts` at
prompt-assembly time.

```
web_read — fetch and read a URL.
  Recent failures with this tool: 3× timeout on PDF URLs; 1× blocked by robots.
```

Small models fail the same way repeatedly. Putting the correction next to the tool it
concerns is worth more than putting it in a memory the model has to think to recall.

Error class must be *derived in code* from the error string — a small regex table, not a
model call — because the error text can contain fetched page content.

**Cap:** `FRICTION_MEMORY_MAX`, and scope it per tool so one broken integration cannot
crowd out the rest.

### 1.3 Rejection symmetry

`rejectConfirmation` deliberately makes a bare "no" cheap, and that should not change —
the doc comment is right that requiring a reason taxes exactly the case you want free.
But a bare reject currently teaches nothing at all.

Fix it without touching the UX: on a reason-less reject, record a structured negative
against the **shape** — `(tool, target)` — in `kv`, not a prose memory. On the third
silent rejection of the same shape, promote it to a `preference` memory written by code:

```
The user has rejected "draft an email to <person>" three times without giving a reason.
Do not propose this again without new justification.
```

Three silent noes are a preference even when nobody typed one.

---

## Phase 2 — Learn from approvals  ✅ **BUILT, 2026-09-10**

> **Status: done.** `src/learn/promote.ts`, read-only, emits proposals the agent cannot see;
> the server applies one on a click and that is the only path that writes policy. What
> shipped, and where it differs from the plan below:
> - The narrowing primitive is a new optional policy surface, `policy.autoApprove`: a list of
>   `{tool, target}` shapes that may auto-execute despite being irreversible. Absent = none,
>   like every other optional surface. This is the narrowest grant the model supports — one
>   `(tool, target)` pair, checked against the tool's own `classify().target`, never a whole
>   tool or domain. The broker consults it in the reversibility gate.
> - `promotionProposals()` groups resolved confirmations by that shape and proposes one when
>   it has ≥ `PROMOTE_MIN_APPROVALS` approvals, **zero** rejections (a single no disqualifies
>   the shape outright), spanning ≥ `PROMOTE_MIN_DAYS`. Each proposal carries the falsifiable
>   claim — the exact confirmation ids the rule would have auto-run.
> - `applyProposal(tool, target)` is the **only** function that writes an autoApprove entry.
>   It is called from `POST /api/proposals` (behind the dashboard token) and from nowhere a
>   tool can reach — invariant 1 holds. Idempotent; preserves any hand-edit to policy.json.
> - Surfaced in the digest ("Auto-approval proposals") and at `GET /api/proposals`.
>
> **A finding worth carrying:** the `draft` tool classifies *every* draft kind under one
> target, `"drafts"`, so auto-approving it approves all drafts, not one kind. The promoter
> works at whatever granularity a tool's `classify` provides — coarse targets grant coarsely.
> Verified end to end (`test/learn-promote.test.mjs`): threshold, the rejection veto, the
> single-entry write, idempotency, and the broker then auto-running the shape while a
> different irreversible shape still queues.

*Original plan, kept for reference:*

Rejections teach; approvals teach nothing. That asymmetry is backwards, because an action
shape approved twenty times with zero rejections is the **strongest safety signal in the
system**, and it currently evaporates.

**The mechanism:** count `confirmations` grouped by `tool` and a normalized args shape
(structure and target, never values — "email to andrew@…" not "email saying X"). When a
shape crosses a threshold — say 10 approvals, 0 rejections, spanning 14 days — generate a
**narrowed policy proposal**: the minimum rule that would let *that shape* auto-execute,
never a whole tool or a whole domain.

**Where it must live, and why it matters:** in `src/learn/promote.ts`, read-only, emitting
a proposal row. The dashboard renders it in Settings → Policy with the exact diff to
`policy.json`. The server applies it on a click. **No tool in `registry` can reach any of
this.** That is invariant 1, and this is the feature most likely to erode it if you build
it as "a tool that suggests policy," so build it as a report the agent cannot see.

**Nice property:** the proposal is falsifiable before you accept it. It says "this rule
would have auto-executed these 10 past actions and nothing else," and you can read the
list. A policy change you can check against history is a very different thing from one you
have to reason about.

---

## Phase 3 — Learn procedure, not just facts  ✅ **BUILT, 2026-09-10**

> **Status: done — both halves.**
> - **3.1 Recipes.** `reflect.ts` gained a second output field, asked for in the same call
>   via `buildSystem(allowRecipe)` — no extra round trip. `renderRecipe` requires a `when`
>   line and ≥2 steps and drops anything secret-shaped; the result is stored as kind `recipe`
>   and recalled by task similarity in `buildContext` under its own heading. **Eligibility is
>   the whole design:** `runner.ts` passes `allowRecipe` only when `store.runIsClean(runId)` —
>   the run finished with no errored calls and nothing rejected, read from its own audit rows.
>   A run that went badly cannot teach its method.
> - **3.2 Sampled self-critique.** `src/learn/critique.ts` runs on roughly `LESSON_SAMPLE_RATE`
>   of **chat** runs (never scheduled/watcher — nobody was reading those), asks `judge()`
>   whether the run did the job without waste, and turns a "no" into a `lesson` memory recalled
>   before similar work. Pinned `sensitivity:"private"` when the trace touched mail, files,
>   calendar, or a page — decided from the audit log, not guessed. Never throws.
> - Kind-scoped recall (`recallOfKind`) keeps recipes and lessons out of the general fact
>   budget and lets each be capped independently (`RECIPE_MEMORY_MAX`, `LESSON_MEMORY_MAX`,
>   both pruned in `prune.ts`).
>
> **This is the phase Phase 0 judges.** If median steps-per-repeat-task doesn't fall, recipes
> aren't working and should be deleted rather than tuned. Deterministic parts verified in
> `test/learn-recipe.test.mjs` (eligibility gate, kind-scoped recall, the sampling gate, the
> sensitive-tool detection); the model-dependent extraction/critique are exercised live.

*Original plan, kept for reference:*

`reflect.ts` extracts facts about the user. It never extracts *method*, which is why the
second time you ask for something it costs exactly what the first time did.

### 3.1 Recipes

Add a second field to the reflection pass — same call, same local pin, no extra round trip:

```json
{"facts": ["..."], "recipe": {"when": "...", "steps": ["..."]}}
```

Stored as kind `recipe`, recalled by task similarity in `buildContext`, injected as:

```
You have done something like this before. Your own notes on how:
  when: checking whether the LAN model host is healthy
  1. web_read http://192.168.0.145:8080/v1/models
  2. if it returns a model list, it is up; the tier is the endpoint, not the name
```

**Eligibility is the whole design.** A recipe is derived only from a run that finished
`ok`, made no `error` calls, and had nothing rejected. A run that went badly must not
teach its method. That filter is code, in `runner.ts`, reading the run's own audit rows
before it calls `reflect`.

Recipes stay plain text and visible under Settings → Memory, because a recipe is closer to
an instruction than a fact and you should be able to read what the thing has decided its
own procedure is.

**This is the phase Phase 0 exists to judge.** If median steps-per-repeat-task doesn't
fall, recipes aren't working and should be deleted rather than tuned indefinitely.

### 3.2 Sampled self-critique

`judge()` already exists, already prefers cloud, already treats its context as untrusted,
and already returns a bare yes/no plus a reason — which is exactly the small surface you
want for this. Use it on roughly one in ten *chat* runs (never scheduled or watcher runs,
which nobody was reading anyway):

> Did this run accomplish what was asked without wasted effort?

A `no` with its reason becomes a `lesson` memory. Sampling is the cost control; a
`LESSON_SAMPLE_RATE` of 0.1 makes this a rounding error against the runs themselves.

Keep `sensitivity:"private"` if the trace touched mail, files, or calendar — which means
the sampling decision has to look at the run's audit rows first. When in doubt, local.

---

## Phase 4 — Anticipation  ✅ **BUILT, 2026-09-10**

> **Status: done — all six.** Everything reuses the machinery that already exists end to end;
> nothing here is a new actuator.
> - **4.1 Mine the ledger** — `src/learn/propose.ts`: `recurringIntent()` clusters finished
>   `kind='chat'` tasks by a normalized key, and a shape seen ≥ `PROPOSE_MIN_RECURRENCE` times
>   (and not already a schedule) is queued as a `schedule_create` confirmation — **created
>   disabled**, task text verbatim, deduped against the pending queue. `npm run propose --dry`
>   shows candidates. It is queued, not installed: `schedule_create` is already irreversible,
>   so the rails were built.
> - **4.2 Standing intent** — `reflect.ts` gained a `standing` field; a caught "keep an eye on
>   X" becomes the same proposal via `queueStandingIntent`, chat runs only.
> - **4.3 Look forward** — `src/learn/horizon.ts` builds the watcher-shaped horizon task; a
>   `horizon` starter is in the watcher catalog (`npm run watcher add horizon`).
> - **4.4 Act quietly** — proposals land in the confirmation queue, not a push; the horizon
>   task is quiet-by-default and only interrupts for something time-sensitive.
> - **4.5 The interruption budget** — the hard rail is `policy.budgets.perDay.tools.notify`
>   (already enforced by the broker); the soft gate and learning path are `src/learn/interrupt.ts`
>   — `notifyProactive()` runs a `judge()` check when `JUDGE_INTERRUPTIONS_PROACTIVE` is on, and
>   `recordDismissal()` turns a dismissed push into a `preference`, same as a rejected proposal.
> - **4.6 Retire goals.md** — `HEARTBEAT_HORIZON` switches the heartbeat from reading a static
>   goal to running the watcher shape against your own near future. Off by default.
>
> Verified in `test/learn-propose.test.mjs`: clustering + threshold, dedupe against schedules
> and the pending queue, the disabled/verbatim proposal shape, standing intent, the dismissal
> preference, and the quiet horizon task text.

*Original plan, kept for reference:*

The scheduler and watchers already *are* the initiative mechanism. Nothing here needs a
new actuator. What is missing is anything that decides what to point them at.

And note the safety property that makes this whole phase cheap: `schedule_create` is
already classified irreversible, so every proposal below lands in the confirmation queue
with its exact task text in front of you before it can ever run. The rails are built.

### 4.1 Mine the ledger for recurring intent

A weekly `proposer` schedule reads `runs.task` for `kind='chat'`, embeds them (the
embedder is already loaded for recall), and clusters. A shape that recurs three or more
times becomes a proposed schedule or watcher **with the task text pre-written**, following
the `WATCHERS.md` template if the shape is a change-check.

You read it, you approve it, it installs. This is the shortest honest path from directed
to anticipating, because it reuses machinery that already exists end to end.

### 4.2 Catch standing intent in conversation

"Keep an eye on X." "Let me know when Y ships." Those are watchers stated in English, and
today they evaporate when the turn ends — the agent does the thing once and reports.

Detect intent-to-persist in the reflection pass (a third output field, `standing`), and
turn it into the same proposal as 4.1. High signal, no new model call, and it addresses
the most common way the current system quietly disappoints: you asked for something
ongoing and got something once.

### 4.3 Look forward, not only for change

A watcher compares the present against the past. Anticipation is usually just *earlier*.

A `horizon` schedule that runs a few times a day: read the calendar forward two hours,
check the projects store for anyone or anything on it, and prepare the brief **before** the
meeting rather than when asked. Calendar, gmail, and projects tools all exist; the missing
piece is a job whose question is "what is about to happen" rather than "what changed."

### 4.4 Act quietly by default

The distinction that decides whether any of this is tolerable: **doing** is not
**announcing**.

Most anticipated work should land as a queued draft or a stash entry you find when you
look. The dashboard already has Approvals and Activity, which are exactly the right place
for "I got this ready in case." Push notification is a higher bar, crossed rarely.

### 4.5 The interruption budget is code, not judgment

An agent that anticipates is only bearable if it is quiet, and quiet cannot be a thing you
ask the model to be.

- **A hard rail:** `policy.budgets.perDay.tools.notify`. The mechanism is already in
  `overBudget` in `broker.ts` and needs nothing but a number in `policy.json`. Set it low.
- **A soft gate:** `judge()` on "is this worth interrupting for?" — the exact example its
  own doc comment cites — before any `notify` that originated from a proactive job rather
  than from something you asked for.
- **A learning path:** a dismissed notification must feed `preference` memory, same as a
  rejected confirmation. "Don't tell me about this again" has to be learnable, or the
  feature dies of irritation inside a week and you turn the whole thing off.

### 4.6 Retire `goals.md` as a static file

Its honest default is `(none)`, and the file's own comment admits the awkwardness: a task
left there runs every tick. The endpoint of this phase is that the heartbeat stops reading
a goal and starts running **the watcher shape against your life instead of a web page** —
pull the horizon (calendar, pending confirmations, stale watchers, open proposals),
compare against `kv` state, act only on a difference, stay silent otherwise.

That is the same three-line contract `WATCHERS.md` already argues for, and it is silent by
default for the same reason.

---

## Phase 5 — Self-editing task text (the one with teeth)  ✅ **BUILT, 2026-09-10**

> **Status: done, and off by default** (`REWRITE_ENABLED=false`) — the injection-persistence
> surface here is the sharpest in the plan, so it is the last thing turned on. `src/learn/rewrite.ts`:
> - The **decision** is inference-free: `looseWatchers()` flags a watcher (a schedule whose
>   task reads `state_get`) when ≥ `REWRITE_MIN_OVER_BUDGET` of its recent runs cost more than
>   `WATCHER_CALL_BUDGET` tool calls, measured by `store.scheduleRunCosts` over the audit log.
>   A single expensive run is not a pattern.
> - The **rewrite** is a model call — pinned local, the current task treated as UNTRUSTED
>   evidence, and required to still be a watcher afterward (a "tightening" that dropped the
>   state check would change what the job is). It lands in the confirmation queue as a
>   `schedule_update` whose summary is a **line diff, not the new text** (`diffLines`) — the
>   one addition the plan insists on, because approving a rewrite you can't compare is the
>   rubber stamp the project refuses elsewhere. Same queue, same rule as `tools/schedule.ts`.
> - `npm run rewrite --dry` lists candidates without a model call; `runRewriter` dedupes
>   against the pending queue.
>
> Verified in `test/learn-rewrite.test.mjs`: the over-budget detection and its run-count floor,
> the exclusion of non-watcher schedules, and the diff rendering. The rewrite itself is
> exercised live.

*Original plan, kept for reference:*

The genuinely self-improving version: a watcher that fires on noise proposes a rewrite of
**its own task string** — bucket the fingerprint, add the cleared-branch, tighten the
wording that let the model wander.

The signal is already there. A watcher whose runs consistently cost more than the three
calls `WATCHERS.md` budgets for is one whose task text is too loose, and that is
measurable in `actions` without asking anyone's opinion.

**Why this is last.** Every other phase produces either a number or a proposal about a
*discrete* thing. This one edits the prompt that an unattended future run will be handed —
which is the single place where something picked up from an UNTRUSTED page could become a
standing instruction that outlives the conversation that introduced it. `tools/schedule.ts`
already identified this exact risk and routed every schedule write through the confirmation
queue for it.

So: same queue, same rule, and one addition — the confirmation shows a **diff**, not the
new text. Approving a rewrite you can't compare against the original is the rubber stamp
the README already refuses to build elsewhere.

---

## New surfaces this introduces

**Memory kinds** — existing: `note`, `reflection`, `preference`.

| Kind | Written by | Recalled where | Cap |
|---|---|---|---|
| `friction` | Phase 1.2, in code from error strings | appended to tool descriptions in `toolDocs` | `FRICTION_MEMORY_MAX`, per tool |
| `recipe` | Phase 3.1, reflection pass | `buildContext`, by task similarity | `RECIPE_MEMORY_MAX` |
| `lesson` | Phase 3.2, sampled `judge()` | `buildContext` | `LESSON_MEMORY_MAX` |

Each needs a line in `prune.ts` next to the existing `pruneMemories("note", …)` call.

*As built, `recipe` also carries the `standing` intent field on the same reflection call
(Phase 4.2), which is not stored as a memory — it is returned and turned into a queued
proposal, so a job the user never approves leaves no trace.*

**Config knobs** — as built, per phase (all documented in `.env.example` with reasoning):
`DENIAL_PROMPT_MAX`, `DENIAL_PROPOSE_MIN`, `FRICTION_MEMORY_MAX`, `REJECT_PROMOTE_AFTER`
(Phase 1); `PROMOTE_MIN_APPROVALS`, `PROMOTE_MIN_DAYS` (Phase 2); `RECIPE_ENABLED`,
`RECIPE_MEMORY_MAX`, `LESSON_SAMPLE_RATE`, `LESSON_MEMORY_MAX` (Phase 3);
`PROPOSE_MIN_RECURRENCE`, `HORIZON_HOURS`, `JUDGE_INTERRUPTIONS_PROACTIVE`,
`HEARTBEAT_HORIZON` (Phase 4); `WATCHER_CALL_BUDGET`, `REWRITE_MIN_OVER_BUDGET`,
`REWRITE_ENABLED` (Phase 5).

**Schema / policy** — `confirmations.resolved TEXT` (Phase 0); `memories.tool TEXT` for the
per-tool friction lookup (Phase 1.2); a new optional policy surface `policy.autoApprove`
(Phase 2), deny-by-default like every other. `kv` prefixes `reject:shape:*` (Phase 1.3) and
`watch:horizon` (Phase 4.3). No new tables: `kv` and `stash` are already the right substrate.

**Modules** — `src/learn/denials.ts`, `friction.ts`, `promote.ts`, `critique.ts`, `propose.ts`,
`horizon.ts`, `interrupt.ts`, `rewrite.ts`. Kept out of `src/tools/` on purpose: none of them
is a capability the model gets to invoke. `applyProposal` (Phase 2) is the only code anywhere
that writes `policy.json`, and it runs from an authenticated server route, never a tool.

**CLIs** — `npm run propose [--dry]` (Phase 4.1) and `npm run rewrite [--dry]` (Phase 5),
alongside the existing `digest` / `watcher` / `prune`.

## How to tell it is working, and what to delete

> **All phases are built and tested as of 2026-09-10** (Phase 0's metrics, Phase 1's three
> learners, Phase 2's approval promotion, Phase 3's recipes and lessons, Phase 4's six
> anticipation parts, and Phase 5's guarded self-rewrite). What is *not* yet done is the only
> thing code cannot do: **run it against real use and read the numbers below.** Each learner
> was built to be deletable, and the table is the standard by which to delete it. The
> defaults are deliberately cautious — Phase 3.2's critique samples at 0.1, and Phases 4.5,
> 4.6, and all of 5 are off until explicitly enabled — so turning the loop on is a series of
> small, reversible decisions, not one switch.

Every phase names a number in Phase 0 that it is supposed to move.

| Phase | Should move | If it doesn't |
|---|---|---|
| 1.1 denials | denied-call rate ↓ | delete it; the model wasn't retrying as much as assumed |
| 1.2 friction | tool error rate ↓ per tool | the failures were environmental, not model error |
| 2 promotion | approval latency ↓, queue volume ↓ | the shapes aren't stable enough to narrow — stop |
| 3.1 recipes | steps per repeat task ↓ | delete. Do not tune this indefinitely |
| 3.2 lessons | rejection rate ↓ | the critique isn't specific enough to act on |
| 4 anticipation | proposals accepted ÷ proposed | it's guessing; tighten the recurrence threshold |

The measurement culture already in this repo is the reason to state that up front: the
`DICTATION_PROMPT` finding and the `MEETING_CORRECTIONS` non-finding are both in the
README, including the one that didn't work. A learning feature that cannot show its number
is indistinguishable from a plausible story, and this is the subject where a plausible
story is worth the least.

## Security notes

- **Phase 1 is inference-free.** SQL and regex, all of it derived from your own audit log.
  Nothing in it can be argued with, which is why it goes first.
- **Phases 3 and 4 read traces.** Same rules as `reflect.ts`, without exception: local pin
  on private content, trace treated as evidence and never as instructions, output shape
  constrained tightly enough that a smuggled instruction has nowhere to land.
- **Phase 2 never writes policy.** It emits a proposal the agent cannot read and the server
  applies on a click.
- **Phase 5 is the injection-persistence surface.** A poisoned page that reaches a task
  rewrite becomes a standing instruction. The queue plus a visible diff is the mitigation,
  and it is the reason this phase ships last, after the metrics exist to notice a watcher
  behaving oddly in the first place.
