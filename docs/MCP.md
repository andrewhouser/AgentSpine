# MCP client

AgentSpine can call the tools of an **MCP server**: a remote one over Streamable HTTP, or a local program over
stdio (added 2026-11-25, PLAN-open-work section 10 CP1). It is a client only; AgentSpine does not expose itself as
an MCP server.

Code: `src/mcp/client.ts` (HTTP), `src/mcp/stdio.ts` (stdio), `src/mcp/register.ts` (turns server tools into broker
tools). Both clients are hand-written because `src/` keeps two runtime dependencies. They implement `initialize`,
`tools/list` and `tools/call` and nothing else (no resources, prompts or sampling).

## Setup

1. Put the bearer token, if the server needs one, in `.env` (e.g. `MCP_NOTES_TOKEN=...`).
2. Edit the `mcp` block of `policy.json`:

```json
"mcp": {
  "enabled": true,
  "servers": {
    "notes": { "url": "https://example.com/mcp", "tokenEnv": "MCP_NOTES_TOKEN", "tools": ["search", "add_note"] }
  }
}
```

A local server is a `command` instead of a `url`:

```json
"files": { "command": ["npx", "-y", "@modelcontextprotocol/server-filesystem", "/Users/you/Notes"], "tools": ["read_file", "search_files"] }
```

The command is an argument list, run directly and never through a shell. The program gets a minimal environment:
`PATH`, `HOME`, the locale, any plain `env` values in its entry, and the variables named in `envFrom` (for a token
kept in `.env`). Nothing else from AgentSpine's environment reaches it, so it cannot read the cloud key or the
dashboard token. It starts the first time one of its tools is needed, is restarted once if it has died, and is
stopped when tools are re-discovered and when AgentSpine exits. It runs as your user, so add only programs you
would run yourself.

3. Restart the dashboard. Startup logs `mcp: notes: 2 tool(s)`. Tools are re-discovered hourly,
   and `policy.json` is still re-read on every call, so disabling a server denies its tools at once.

Tools appear to the agent as `mcp__<server>__<tool>`.

## How calls are gated

- **Deny by default.** No `mcp` block, `enabled: false`, a missing server entry, or a tool outside
  that server's `tools` list: the call is denied. Only a human editing `policy.json` can add a
  server; no tool can.
- **Reversibility follows the server's `readOnlyHint` annotation.** `true` runs freely. Anything
  else, including a tool with no annotations, is irreversible and goes to the confirmation queue.
  The server vouches for itself, so a server that mislabels a write as read-only would skip the
  queue. Use the `tools` list to expose only tools you have checked.
- **Unattended runs still ask** for non-read-only tools (`confirmWhenUnattended`), so a scheduled
  job that read a hostile page cannot drive a remote write. A reviewed shape can be pre-approved
  with `policy.autoApprove` (`tool` = `mcp__notes__add_note`, `target` = `notes/add_note`).
- **Server text is untrusted.** Descriptions are flattened and clipped to 300 characters before
  they reach the prompt, and results are wrapped with `tagUntrusted` and clipped (the rest stays
  reachable with `read_more`).

## Things to know

- **Privacy.** A remote server is a third party. Tool arguments are written by the model and are
  sent to it, so this is not covered by the `sensitivity: "private"` rule, which only governs the
  cloud model tier. Do not point it at a server you would not give that content to, and do not
  enable it for work on private projects. Arguments to any server go through the outgoing-text check.
- **What a server returns, and the cloud tier.** `privateOutput` in a server's entry says whether its tools'
  results must stay off the cloud tier. It defaults to `true` for a local server (they usually read your files or
  repos) and `false` for a remote one. When it is on, a run that calls one of its tools is pinned to the local
  model for the rest of the run, as a file or calendar read is.
- **Prompt size.** Every exposed tool's description and argument shape is part of the prompt
  prefix, and prefill is the expensive part on the model host. Set `tools` rather than exposing
  a large server whole.
- A server that is down is logged and skipped at discovery; calls to its tools then fail with an
  ordinary error. A dropped session (HTTP 404 with a session id) re-initialises once and retries.

Tests: `test/mcp.test.mjs` (fake HTTP server on loopback; needs local port binding) and `test/mcp-stdio.test.mjs`
(a fake stdio server, `test/fixtures/mcp/stdio-server.mjs`, run as a child process).
