<!--
=============================================================================
 profile.example.md — the starting point for your own profile.md.

   cp profile.example.md profile.md

 profile.md is gitignored. That is deliberate: it holds standing facts about you —
 name, family, employer, how you like to be answered — and it is injected verbatim
 as trusted context on every run. Useful to the assistant, nobody else's business.

 This file is the shape without the content. Everything outside these comment
 blocks is injected on every step of every run, so keep it tight — under ~40 lines.
 If it stops fitting, that is a sign the detail belongs in memory instead.
 Comments like this one are stripped before injection, so guidance costs you nothing.

 Nothing automated ever writes here. That is exactly why it can be trusted: reflected
 memories (auto-learned, in spine.db) are model-generated and can be wrong, and this
 file is the ground truth that overrides them.

 Edits take effect on the next run. No restart needed.
 Delete anything that isn't true — this is a starter, not a survey.
=============================================================================
-->

# Profile

## Who

<!--
 Enough for it to address you correctly and get dates and times right. Add the people
 who come up often, so it doesn't have to ask twice.
   - Name: <what you'd like to be called>
   - Timezone: <e.g. America/New_York>
   - <relationship>: <name>, <birthday if it should remember it>
-->

- Prefers concise, direct answers. No filler, no restating the question back.

## Working setup

<!--
 Where things live and what runs where. Saves it guessing at paths and endpoints.
   - Projects live in `~/Developer`, kept out of `~/Desktop`, `~/Documents` and
     `~/Downloads` because macOS TCC restricts those for automated processes.
   - The chat model is an MLX-LM server reached over the LAN, not on this machine.
-->

## Standing preferences

<!--
 How you want it to behave, especially the decisions you do not want relitigated.
 Writing the *reason* down is what stops it being re-argued next month.
-->

- Local-first: prefer the local model and local tools; cloud is a fallback.
- When an action would be irreversible, say so plainly rather than working around it.

## People & projects

<!--
 The recurring ones — who they are to you, and what they'd come up about.
   - <name>: <relationship, and the context they usually appear in>
-->

## Currently

<!--
 Short-lived focus worth knowing for a few weeks. Prune it when it goes stale —
 something false here is worse than nothing, because this file is trusted.
-->
