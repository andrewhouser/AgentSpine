<!--
=============================================================================
 profile.md — standing facts about you, injected as trusted context on EVERY run.

 This is the one place the assistant's picture of you is under your direct control;
 nothing automated ever writes here. Reflected memories (auto-learned, in spine.db)
 are model-generated and can be wrong — this file is the ground truth that overrides
 them, and the thing you fix by hand when it gets you wrong.

 Everything outside these comment blocks is injected verbatim on every step of every
 run, so keep it tight — under ~40 lines. If it stops fitting, that's a sign the
 detail belongs in memory instead. Comments like this one are stripped before
 injection, so guidance costs you nothing.

 Edits take effect on the next run. No restart needed.
 Delete anything that isn't true — this is a starter, not a survey.
=============================================================================
-->

# Profile

## Who

- Name: Andrew.
- Timezone: America/New_York.
- Prefers concise, direct answers. No filler, no restating the question back.

## Working setup

- Projects live in `~/Developer`, deliberately kept out of `~/Desktop`, `~/Documents`,
  and `~/Downloads` because macOS TCC restricts those for automated processes.
- The chat model is an MLX-LM server reached over the LAN, not on this machine.
- Embeddings run locally through Ollama (`nomic-embed-text`).

## Standing preferences

- Local-first: prefer the local model and local tools; cloud is a fallback.
- Never widen the read-only Google scopes. Decided 2026-07-25, on the record: AgentSpine
  takes SPEC §5's draft-not-send path. It composes replies and event proposals; I review
  and send them myself. Adding a Gmail send or Calendar write scope would need a new,
  explicit decision — do not treat "it would be more convenient" as one.
- When an action would be irreversible, say so plainly rather than working around it.

## People & projects

- AgentSpine: this project. A local-first agent loop with a reversibility-tiered broker.

<!--
 Add the other recurring ones — who they are to you, and what they'd come up about:
   - <name>: <relationship, and the context they usually appear in>
-->

## Currently

<!--
 Short-lived focus worth knowing for a few weeks. Prune it when it goes stale —
 something false here is worse than nothing, because this file is trusted.
-->
