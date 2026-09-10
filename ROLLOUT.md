# Rollout — turning the learning loop on, one reversible step at a time

Everything in `LEARNING.md` is built and tested. This is how you *enable* it: as a series of
small, reversible decisions rather than one switch. The ordering is deliberate — each rung is
safe to sit on indefinitely, and you only climb when the rung below has shown its number moving
in the direction `LEARNING.md`'s "How to tell it is working" table predicts.

Two rules that apply to every step:

- **Read the number before the next step.** A learner that cannot show its Phase 0 number is
  indistinguishable from a plausible story. If a step's metric does not move as its row predicts,
  the intended response is to switch it **off**, not to tune it.
- **Restart the dashboard after any `.env` or `policy.json` change.** The scheduler and API run
  inside the `npm run dashboard` process, so it keeps executing the code and config it booted
  with. `Ctrl-C`, then `npm run dashboard`. (`policy.json` is re-read every heartbeat, so policy
  edits alone don't need a restart — but a `.env` change does.)

A note on the two proposer CLIs: npm intercepts a bare `--dry`, so pass it after `--`, e.g.
`npm run propose -- --dry`.

---

## Step 0 — Baseline first (do not skip)

Nothing below is worth enabling without a "before" to compare against. Phase 0's metrics already
compute, so this is discipline, not setup.

```
npm run digest 168      # the last week: denied-call rate, tool-error rate,
                        # steps-per-repeat-task, rejection rate, approval latency
```

- [ ] Recorded the five numbers.
- [ ] Let them accumulate over ~a week of normal use.

> **Approval latency and rejection rate only count confirmations resolved from now on** — the
> migration left older rows null by design, so the clock starts when you begin. Don't expect a
> week-one figure for those two; expect a week-*two* one.

---

## Step 1 — Inference-free learners (Phase 1) — already on; *watch* them

These are the safest things in the system: SQL and regex, nothing a page can argue with. They
ship **on** by default (`DENIAL_PROMPT_MAX=5`, `FRICTION_MEMORY_MAX=5`, `REJECT_PROMOTE_AFTER=3`),
so the decision here is to *read their effect*, not to switch them on.

- [ ] After ~a week, re-run `npm run digest 168`.
- [ ] **Denied-call rate ↓?** (1.1 denial learner is working.) If not: `DENIAL_PROMPT_MAX=0`.
- [ ] **Per-tool error rate ↓?** (1.2 friction is working.) If not: `FRICTION_MEMORY_MAX=0`.
- [ ] Silent-rejection promotions look right in memory (kind `preference`)? If they misfire,
      raise `REJECT_PROMOTE_AFTER` or set it to `0`.

Reversal: set the knob to `0`. Nothing persists that `npm run prune` won't clear.

---

## Step 2 — Learn procedure (Phase 3) — already on; *read* what it learns

`RECIPE_ENABLED=true` and `LESSON_SAMPLE_RATE=0.1` are the defaults, so recipes and sampled
self-critique are already running. Both read traces and inherit `reflect.ts`'s local-only pin —
no trace leaves the box. The job here is to check the output is worth its keep.

- [ ] Inspect stored recipes and lessons (Settings → Memory, or query kinds `recipe` / `lesson`).
- [ ] **Steps-per-repeat-task ↓?** (3.1 recipes working.) If not, delete them: `RECIPE_ENABLED=false`.
- [ ] Lessons specific enough to act on? If they're vague, lower `LESSON_SAMPLE_RATE` toward `0`.

Reversal: `RECIPE_ENABLED=false` / `LESSON_SAMPLE_RATE=0`, then `npm run prune` to clear the kinds.

---

## Step 3 — Review proposals (Phases 2, 4.1, 4.2) — zero risk; *look*, then approve

The proposers **emit suggestions and install nothing**. Enabling them is choosing to look.

```
npm run propose -- --dry     # recurring chat intent it would propose as schedules
npm run digest 168           # "Auto-approval proposals" and "Worth deciding" blocks
```

- [ ] Reviewed proposed schedules. A proposed job is created **disabled** — approving it still
      runs nothing until you enable it, so approving is safe.
- [ ] Reviewed auto-approval proposals (Phase 2). Each is falsifiable: it lists the exact past
      confirmations the rule would have auto-run. Approve one only if that list is all things you
      would have said yes to anyway.

> Approving a Phase 2 proposal is the **first thing that touches the security boundary.** It is
> the narrowest possible change — one `{tool, target}` pair added to `policy.autoApprove` — and it
> is reversible by editing that array in `policy.json`. Nothing else in this rollout writes policy.

Approve/reject from the CLI or the dashboard:

```
npm run confirm list
npm run confirm approve <id>
npm run confirm reject <id> [why]     # the reason is stored and teaches it
```

Reversal: delete the `policy.autoApprove` entry; disable or delete a schedule you approved.

---

## Step 4 — Quiet proactive layers (Phase 4.3–4.6) — the first off-by-default switches; one at a time

Enable these **individually**, watch for a few days, then decide on the next.

### 4a. Horizon brief (Phase 4.3)

```
npm run watcher add horizon
```

A normal watcher that prepares drafts/notes for what's coming up and only pushes for something
time-sensitive. Quiet by default.

- [ ] Ran for a few days; its output is useful, not noise.
- [ ] Reversal ready: `npm run watcher remove <id>`.

### 4b. Interruption budget (Phase 4.5)

Set the **hard rail first** — it needs no model call. In `policy.json`:

```json
"budgets": { "perDay": { "tools": { "notify": 5 } } }
```

Then, only if pushes still feel noisy, add the soft judgment gate (costs a model round-trip per
proactive push):

```
JUDGE_INTERRUPTIONS_PROACTIVE=true
```

- [ ] Hard `notify` per-day cap set low in `policy.json`.
- [ ] (Optional) soft gate enabled after the hard cap proved insufficient.
- [ ] Dismissed notifications are turning into `preference` memories as expected.

Reversal: raise/remove the cap; `JUDGE_INTERRUPTIONS_PROACTIVE=false`.

### 4c. Horizon heartbeat (Phase 4.6) — only once 4a is trusted

```
HEARTBEAT_HORIZON=true
```

The heartbeat stops running the static `goals.md` and instead runs the watcher shape against your
near future — acting on a difference, silent otherwise.

- [ ] Enabled only after the horizon watcher (4a) behaved well.
- [ ] Reversal ready: `HEARTBEAT_HORIZON=false` restores `goals.md` behaviour.

---

## Step 5 — Self-editing task text (Phase 5) — the one with teeth; last

Only after the metrics exist to notice a watcher misbehaving. Look first, touching nothing:

```
npm run rewrite -- --dry     # watchers whose runs cost more than they should
```

- [ ] Reviewed the loose-watcher list. (These are inference-free measurements over the audit log —
      no model call, no proposal yet.)

When ready to let it *propose* rewrites:

```
REWRITE_ENABLED=true
```

Even then it installs nothing: a rewrite lands in the confirmation queue as a **diff** you approve
or reject. This is the injection-persistence surface — a poisoned page reaching a task rewrite
would become a standing instruction — so it ships last and stays diff-gated.

- [ ] Enabled `REWRITE_ENABLED` only after Steps 0–4 were stable.
- [ ] Confirmed rewrite proposals show a **diff**, not just the new text, before approving any.

Reversal: `REWRITE_ENABLED=false`. Reject any queued rewrite you don't want; nothing is applied
without approval.

---

## The through-line

Every rung is a config flag, a `policy.json` edit, or a queue approval. The **only** things that
change behaviour without your click are the inference-free learners in Steps 1–2 — and those touch
*memory*, never *permissions*. Permissions change in exactly one place (`policy.autoApprove`, via a
proposal you approve), and task text an unattended run will follow changes in exactly one place
(a diff you approve). If a step's number doesn't move as `LEARNING.md` predicts, switch it off.
