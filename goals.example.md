# agentspine goals

Everything below is given to the agent as its goal on EVERY heartbeat (every
HEARTBEAT_MINUTES). So keep it idempotent: if the Tasks list is empty, the agent
should do nothing. Only the "Tasks" section is work to act on.

## Standing instructions

Do a light check-in. First recall anything relevant from long-term memory. Then look at
the Tasks list below:
- If it says "(none)", take NO actions and finish with a one-line summary.
- If it contains real tasks, work through them, using tools as needed. Anything the broker
  QUEUES for confirmation is NOT done — note it and move on.
- Record any durable fact worth keeping with memory_save.

## Tasks

(none)

<!--
Add tasks by replacing "(none)" above. Examples:

  - Search for the latest MLX-LM release notes and save a one-line summary to memory.
  - Read https://example.com and remember its main heading.

Remember: a task left here runs every tick. For recurring light tasks that's fine; for a
one-off, remove it after it runs (or use `npm run tick` once, then clear it).
-->
