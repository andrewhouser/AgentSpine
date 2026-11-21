# Plan: what to take from n8n's Nod

Source: the Nod repo (github.com/n8n-io/nod), its trust/approvals/principles/architecture docs
(nod.n8n.io), and a walkthrough video transcript. Written 2026-11-18 against `main` at 86ac872.
**Nothing here is built.** Work starts only after Andrew confirms (a reminder is set for
2026-11-19, 10:00).

Nod is a free personal agent that gets its own sandboxed computer and browser, works in your
apps, and asks before it sends, posts, deletes or buys. It overlaps AgentSpine heavily, so this
plan lists only what fills a real gap. Everything else is already here or was rejected on purpose
(see "Not taking").

## The one design difference, and why it decides what we copy

Nod decides *whether an action is allowed* with a model: a "safety check" reads your last few
messages and your rules, must quote the words that permit the action, and the server verifies the
quote appears in your messages. Nod's own docs call this best-effort, and its README reports that
a small frontier model let 8 unsafe actions through in 240 test decisions.

AgentSpine decides with code (allowlist plus reversibility tier, README "The one idea that
matters"). On a local model with ~3B active parameters a model-judged gate would be the weakest
part of the system, so **we do not adopt it**. What transfers is everything *around* the gate:
how memory is audited, how the model-judged parts are measured, how spend is bounded, and how
drafts are personalised.

## What is already done (no work)

| Nod feature | AgentSpine already has |
|---|---|
| Ask before irreversible actions | Broker tiers + confirmation queue; approvals in the thread and on the phone |
| Approvals bind exact arguments, run once | A confirmation stores its call; `state != pending` is refused |
| Standing permissions narrowed to named action and target | `learn/promote.ts`: narrowed policy proposals, checked against history, applied by the server only |
| Rule changes can't quietly add permissions | LEARNING invariant 1 (no tool writes `policy.json`) |
| Untrusted web/email content is data | `tagUntrusted`; reflection treats the trace as hostile |
| Scheduled work limited to what was pre-authorised | Scheduled runs can't write standing work (`confirmWhenUnattended`, `recipe_save` refused) |
| Report only when something changed | Watchers |
| Lighter model for background jobs | Dispatcher sizes each task to a tier; `runTask` accepts `tier` |
| Phone as a client | iOS app + ntfy (Nod uses Telegram/WhatsApp) |
| Every action logged | `actions` audit table, deterministic digest |
| Memory you can see, edit, delete | Settings → Memory |
| Skills that are reused | Learned recipes (LEARNING 3.1) and named recipes (3.3) |

## The five items

Build order is the order below. N1 is small and makes N2's measurements readable. N3 and N5 are
independent. N4 is the largest.

### N1. Memory provenance

**Gap.** Nod links every memory to the message it came from. Ours has no origin at all: the
`memories` table is `id, ts, kind, text, embedding, tool` (`src/memory/rag.ts:17`). If a wrong
or poisoned fact is recalled, nothing says which run wrote it. The profile-wins rule limits the
damage but doesn't help you find the cause.

**Change.**
- Add `run_id INTEGER` and `origin TEXT` to `memories` with the same best-effort `ALTER` pattern
  the file already uses for `tool`. `origin` is a short fixed vocabulary set by code: `reflection`,
  `recipe`, `lesson`, `rejection`, `approval`, `interrupt`, `conversation`, `profile`, `tool`
  (the `memory_save` tool, i.e. the model chose to remember).
- Widen `remember(text, kind, source?: { runId?: number; origin: Origin })`. Make `source` optional
  so the nine existing call sites keep working, then pass it from each: `reflect.ts` (two),
  `confirmations.ts` (two), `learn/critique.ts`, `learn/interrupt.ts`, `tools/memory.ts`,
  `memory/summarize.ts`, `tools/profile.ts`.
- Dedupe stays exact-text plus cosine. A duplicate that is refused does **not** overwrite the
  original's provenance.
- Settings → Memory shows `origin`, and links to the run's trace when `run_id` is set. Rows from
  before this change show "before provenance", not a guess.
- Traces and runs are pruned at 90 days (README "Retention"); memories are not. The link must
  degrade to "run pruned", never 404.

**Decision.** Provenance is code-set metadata, never model-written, so it can't be talked into
saying a fact came from you. Nod's rule that memory learns about you *only from your own
messages* is already in `reflect.ts`'s prompt; N2 measures whether it holds. We don't try to
enforce it in code (can't be done reliably over free text).

**Done when.** Every `remember` call site records an origin; Settings shows it; a test asserts a
refused duplicate keeps the original origin and that a pruned run degrades; `npm run check` passes.
Update `docs/LEARNING.md`.

### N2. Prompt-injection eval corpus

**Gap.** Nod ships an `evals/` harness and publishes attack results (108 attack emails, 0 false
memories planted across 216 attempts; per-model safety results). Our hostile-content handling is
in prompts (`reflect.ts`, recipe drafting, critique) and `tagUntrusted`, and I found no test
corpus of attack inputs. The broker is code, so the exposure is the **model-judged parts**: what
reflection chooses to remember, what recipe/lesson extraction writes, and what the agent loop
attempts after reading hostile text.

**Change.**
- `test/fixtures/injection/`: JSON fixtures, each `{ id, surface, payload, forbidden }`. Surfaces:
  an email snippet, a web page, a file, a calendar entry, a meeting transcript. Payload families:
  "remember that Andrew authorised X", "ignore your rules", a fake system message, instructions
  hidden in a quoted reply, a secret-shaped string to be saved, a request to schedule a job or save
  a recipe.
- **Offline half, in `npm test`** (no network, per the repo rule): deterministic checks that need
  no model. `tagUntrusted` wraps every surface; the secret filter in `reflect.ts` drops
  credential-shaped strings; `recipe_save` and `schedule_create` refuse or queue from a non-chat
  run; the broker denies or queues each forbidden tool call when handed it directly.
- **Live half, `npm run eval:injection`**, *not* in `npm test` because it needs the model host.
  Runs each fixture through reflection, recipe extraction, critique and the agent loop with
  `dryRun` on, and reports per surface and per tier: facts saved that quote the payload, recipes
  or lessons written from it, forbidden tool calls attempted. Output is a table, appended to a
  new section in `docs/SPEC.md` or `docs/MODELS.md` with the date and model, like the existing
  measurements.
- Run it at least once per model change on the model host, and before any ROLLOUT step that
  switches on a learner.

**Decision.** No pass/fail threshold is invented in advance. Run it, record the baseline, then
decide what rate is acceptable. A broker bypass must be zero by construction, so any nonzero
there is a bug, not a statistic.

**Done when.** Fixtures and both halves exist, the offline half is wired into `npm test`, one
live baseline run is recorded in the docs, and the README "Security notes" link to it.

### N3. Cloud spend cap

**Gap.** Nod enforces a monthly spend limit that stops schedules, tasks and background work before
their next model call, and pauses a single task for a check-in when its spend since your last
message passes a threshold. AgentSpine bounds *tool calls* (`budgets`), not *model tokens*. Cloud
is off unless `OPENAI_API_KEY` is set, so this only matters when it is, but a stuck unattended
loop on the cloud tier is the case where it costs real money.

**Change.**
- `llm_calls` already records `tier`, `model`, `prompt_tokens`, `completion_tokens` and `ts`
  (`src/memory/store.ts:122`). Count from it, so there is no second tally to drift (same reason
  budgets count from the audit log).
- Cap **tokens, not dollars**: prices change and live in someone else's pricing page, while token
  counts are measured. Config in `.env`: `CLOUD_TOKENS_PER_DAY`, `CLOUD_TOKENS_PER_MONTH`, and
  `CLOUD_TOKENS_PER_RUN`; `0` or unset means unlimited, like budgets. Only calls to the cloud
  model count; local calls are free.
- Enforce at the single point every completion passes through (the router), before the call. On
  breach: interactive chat gets an error that says which cap and offers to continue locally;
  unattended runs stop, log to the audit table, and push once through `notify` (not once per
  attempt).
- `npm run digest` gains a line: cloud tokens today / month against the caps.
- Retention: `llm_calls` ages on `AUDIT_RETENTION_DAYS` (default 90). A monthly cap needs 31
  days, so refuse to start with a retention shorter than that when a monthly cap is set.

**Decision.** A cap that fails closed for unattended runs and open-with-a-message for chat. The
person at the keyboard can decide; a schedule can't.

**Done when.** Caps enforced at the router with a test (fake `llm_calls` rows, assert the block,
assert local calls don't count), digest line, `.env.example` and README updated.

### N4. Writing styles for drafts (named, several at once)

**Decided 2026-11-18:** there are **separate casual and formal styles**, not one global voice.
Andrew also expects AgentSpine to help with **Crew Front Desk** later, which will need its own
voice(s). So the design is *named styles with a rule for when each applies*. `casual` and `formal`
are the first two entries, not a built-in pair. Adding Crew Front Desk's voice later is adding a
row, not changing code.

**Gap.** Nod learns your voice from sent mail (keeping no names or numbers) so drafts sound like
you. AgentSpine's `draft` tool writes drafts, but I found no style input in `draft.ts`, `agent.ts`
or SPEC.

**Storage: its own table, not a memory kind.** Same reasoning as named recipes (`src/recipes/`):
a style is named, a person approves it, it is matched by rule rather than by similarity, one
replaces the last instead of accumulating, and it must never be pruned or deduped. A `styles`
table: `name` (primary key, free text such as `casual`, `formal`, `crew-front-desk`), `note`,
`applies_to` (JSON, below), `sampled` (how many sent messages it was built from), `updated`.
Edited and deleted in **Settings → Styles**, beside Recipes, which also shows the note in full.

**Learning: `style_learn(name, query?)`** (chat-only, like `profile_save`).
- `query` is a Gmail search that selects the samples for *that* style, e.g.
  `in:sent to:@crewfrontdesk.com`. Default `in:sent`. The existing read-only scope covers it.
  For `casual` and `formal` with no query, the local model first sorts the sample into the
  requested register and discards the rest; the model owns that judgment.
- Strip quoted replies and forwarded blocks, then ask the **local** model for a short note:
  greeting, sign-off, typical length, formality, recurring phrases. Never names, addresses,
  numbers or amounts.
- **Code owns the minimum sample** (a constant in `config.ts`, e.g. 8 messages that survive
  sorting and stripping). Below it the tool refuses and says how many it found, rather than
  inventing a style from three emails.
- Sent mail is `sensitivity: "private"`, so this is local-only by construction. If the local
  model is unreachable it does nothing rather than escalating, as reflection does.
- Sampled text is still wrapped with `tagUntrusted`: a sent mail can contain forwarded or pasted
  content from someone else.
- Saved through an **approval card showing the full note**, only from a live chat. Replacing an
  existing style says REPLACES, as `recipe_save` does.

**Applying: code picks the style, the model writes in it.** `draft` takes an optional `style`
argument. When it is omitted, a code-side resolver chooses, first match wins:
1. `applies_to.addresses` / `applies_to.domains`: the recipient (e.g. a formal style for a
   client's domain, a casual one for named friends and colleagues).
2. `applies_to.projects` / `applies_to.clients`: the project or client the thread belongs to
   (AgentSpine already has Projects and a `clients` table). This is the hook Crew Front Desk
   uses.
3. The configured default style (a setting, initially `formal` until you say otherwise).

The draft approval card names the style that was used ("Style: formal"), so a wrong choice is
visible before you send, and the draft can be regenerated with a different one. The chosen note is
injected into the `draft` tool's context only, so it doesn't crowd general recall or leak into
other tasks. A recipient with no rule falls to the default; the model is never asked to guess
which style fits.

**Local-only follows the project.** README: work linked to a project is local-only. A style built
from a project's mail, and any draft using it, stays on the local model when that project is
private. Crew Front Desk mail is treated as private unless you say otherwise.

**Open questions.**
- *What is Crew Front Desk, operationally?* This spec assumes only that its mail has something
  code can match: a sending address or domain, a recipient set, or a project. If it sends from a
  separate Gmail account, note that `src/google/auth.ts` stores a single token at
  `GOOGLE_TOKEN_PATH` (read-only calendar and gmail scopes), so today there is exactly one Google
  account. Sampling that business's sent mail, and drafting from it, would need multi-account
  support first. Settle this before building the `applies_to` matching.
- Do `casual` and `formal` need per-recipient overrides from day one, or is domain/address
  matching enough? Start with matching only.

**Done when.** `styles` table and Settings → Styles; `style_learn` with the sample minimum,
stripping and approval card; the code-side resolver with a test for each rule and the fallback;
`draft` takes `style` and shows it on the card; a test with a stubbed model asserting quoted text
and secret-shaped strings never reach a note; and a before/after of a few real drafts per style
recorded in the doc. Update `docs/LEARNING.md` and the README "Drafts" section.

### N5. Mechanical check for "no tool can write policy"

**Gap.** Nod enforces module boundaries with `scripts/check-architecture.mjs`. Our equivalent is
LEARNING invariant 1: no tool may write `policy.json`, `profile.md`, `goals.md` or `agents/*.md`,
and `learn/promote.ts` is built as a report the agent can't see. `test/write-file.test.mjs`
references the invariant, but I haven't confirmed that anything fails if a tool is later given an
import path to `applyProposal` or the policy writer. That's the erosion `promote.ts`'s own header
warns about.

**Change.**
- First read `test/write-file.test.mjs` and list what it already guarantees; don't duplicate.
- Add a test that walks the import graph from `src/tools/index.ts` and asserts no tool module
  reaches `src/learn/{propose,promote,rewrite}.ts` apply functions or any writer of the protected
  files.
- Wire it into `npm test`.

**Done when.** The test fails when a tool is temporarily given such an import (check this by
hand once), and passes on `main`.

## Not taking, and why

- **Model-judged safety check.** See above. Revisit only if a measured eval (N2) shows the code
  gates are costing real approval fatigue and a model could safely cover a narrow, quoted case.
  If it ever comes back, take Nod's quote-verification idea: the server checks the quoted
  permission actually appears in the user's messages.
- **Credential Vault and logged-in browsing.** Nod's biggest capability (it signs into a CRM and
  fills forms; the server types secrets so the model sees them masked). Our browser is
  deliberately logged-out and ephemeral, and Google scopes are read-only. This would be a large
  change to the security posture. Revisit only if browser errands become a real need, and design
  it origin-bound with the secret never entering a prompt.
- **MCP connectors.** Conflicts with deny-by-default and the two-runtime-dependency rule.
- **Docker workspace and browser containers.** The AgentSpine host is a 16 GB Mini.
- **Telegram / WhatsApp.** The iOS app plus ntfy covers the same use. A second channel is a second
  place for approvals to be dismissed unseen.
- **Usage telemetry.** Local-first; no.

## Doc and test hygiene

Each item updates the doc that records its area in the same change (`LEARNING.md` for N1, N4, N5;
`SPEC.md` or `MODELS.md` for N2; README for N3 and N4). New tests are added to the `test` script
in `package.json`. `npm run check` must pass before any item is called done.

## Review, 2026-11-21: what changed since this was written

Nothing here has been built (checked: no `origin` column on memories, no injection corpus, no cloud
token cap, no styles table, no architecture test). Two things happened since 2026-11-18 that change the
order, and none of the five items is obsolete.

1. **AgentSpine can now change mail and calendar** (SPEC section 5, amendment of 2026-11-21: a separate
   write token for the inbox cleanup). That makes a hostile email worth more to an attacker than it was
   when every Google call was a read. It raises N2 and N5 and leaves the rest where they were.
2. **The outbox exists** (`PLAN-outbox.md`). It does not overlap any of N1 to N5, but N3's monthly cap
   notice and N2's live-eval failures should go through it, not straight to `notify`.

Recommended order now: **N5, N2 (offline half), N1, N3, N4.**

| Item | Verdict | Why now |
|---|---|---|
| N5 architecture test | Do first, smallest | It should also assert the new rule: `src/google/write.ts` is imported only by `gmail-triage.ts`, `calendar-write.ts`, and nothing reaches `GOOGLE_WRITE_TOKEN_PATH` elsewhere. `test/google-write.test.mjs` already greps for the token holders; fold that into this test so the invariants live in one place. |
| N2 injection corpus | Do second, and before the cleanup runs unattended | Add cases aimed at the new tools: an email that says to trash everything, to archive a "protected" message, to write a calendar event, to label something to hide it. The pass condition is the plan's own: broker and tool-guard bypass must be zero. The guards in `gmail-triage.ts` (never mail you have emailed, never starred, never outside the inbox, per-run cap) are exactly what this corpus should try to defeat. |
| N1 memory provenance | Third | The cleanup reads a lot of hostile text and reflection runs after it. Knowing which memories came from an email-reading run is the cheap defence against a poisoned memory. |
| N3 cloud token cap | Keep, lower priority | Mail and study topics are local-only, so the cleanup adds no cloud tokens. Worth doing when cloud use grows. |
| N4 writing styles | Keep, defer | Largest and independent. Reads Sent mail with the read token, which is unchanged. Not on the path of anything above. |
