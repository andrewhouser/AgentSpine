# Personal-assistant upgrade — plan

Written 2026-11-08. Goal: turn AgentSpine from "a chat that asks permission for everything"
into a personal-admin assistant that remembers, captures, files, follows up and briefs —
without giving up the guarantees that make it safe to leave running (read-only Google token,
deny-by-default scopes, every action audited).

## Principles for loosening approval

1. **Make things undoable instead of gated.** Overwriting a file keeps a backup, so it no
   longer needs a human; that is strictly better than a prompt nobody reads.
2. **Trust the person at the keyboard, not the text the model read.** In a live chat turn,
   named tools in `policy.trust.chatAutoTools` run their irreversible calls without a queue.
   Scheduled runs, watchers and subagents still queue — they have no one typing.
3. **Keep the real brakes.** Sends to recipients the user did not name, browser
   submit/buy/delete clicks, and anything outside the allowlists still queue.

## Phases

| # | Phase | Delivers |
|---|-------|----------|
| 1 | Trust | `policy.trust.chatAutoTools`; write_file overwrite is backed up and auto-runs |
| 2 | Tasks & follow-ups | `tasks` table; task_add/list/update/done tools; due sweep that notifies; API |
| 3 | Files | append / edit_file / move_file / make_dir; read docx/rtf/html/pdf; Files API; "save this reply" |
| 4 | Memory & search | find_past_output tool; /api/search; "context used this turn"; starred messages; idle-thread summaries on |
| 5 | Briefing & research | seeded 07:30 morning brief; fetched pages kept as citable sources; researcher unit |
| 6 | Clients & time | `clients`, `time_entries`; tools; API |
| 7 | Web UI | Tasks, Files, Clients views; sidebar search; star; context-used; save-to-file |
| 8 | iOS | Tasks, Files, Search, Clients tabs/screens; star; approvals unchanged |
| 9 | Ship | tests, typecheck, web build, README, push to main, restart the Mac mini service |

## Out of scope (deliberately)

- Widening the Google OAuth scope. Mail is sent through Mail.app (`mac_control.send_mail`,
  already auto-runs when you name the recipient in chat); the token stays read-only.
- Auto-running irreversible actions in unattended runs.
