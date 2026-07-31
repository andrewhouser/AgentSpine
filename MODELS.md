# Model host setup (the M4 Mini at 192.168.0.145)

Everything here runs on the **model host**, not on the machine running AgentSpine.

## What to run

Two `mlx_lm.server` processes, each pinned to one model. Two, not one, because a single
server holds one model resident and swapping costs more than a smaller model saves — see
"Why two servers" below.

| port | model | size | role |
|---|---|---|---|
| 8080 | `mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-DWQ` | ~17GB | `standard` — the default |
| 8081 | `mlx-community/Llama-3.2-3B-Instruct-4bit` | ~2GB | `fast` — lookups, `tracker`/`runner`/`inspector` |

~19GB of 32GB, leaving comfortable headroom.

## Running them by hand (to try it)

```bash
~/.venvs/mlx-lm/bin/mlx_lm.server --model mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-DWQ --port 8080 --host 0.0.0.0
```

```bash
~/Library/Python/3.9/bin/mlx_lm.server --model mlx-community/Llama-3.2-3B-Instruct-4bit --port 8081 --host 0.0.0.0
```

Then on the AgentSpine machine:

```bash
# .env
FAST_LLM_URL=http://192.168.0.145:8081/v1
FAST_MODEL=mlx-community/Llama-3.2-3B-Instruct-4bit
```

`npm run dashboard` prints the live tiers on boot, so what's actually running is never a
guess.

## Keeping them up (launchd)

These already exist on the model host as two user LaunchAgents. **The labels are `com.local.*`,
not `com.agentspine.*`.** An earlier draft of this doc prescribed the latter and they were never
created — so any `launchctl` command naming `com.agentspine.mlx-standard` fails with
`Unload failed: 5: Input/output error`, which only ever means *that plist path does not exist*.

| port | label | plist |
|---|---|---|
| 8080 | `com.local.mlx-server` | `~/Library/LaunchAgents/com.local.mlx-server.plist` |
| 8081 | `com.local.mlx-server-llama` | `~/Library/LaunchAgents/com.local.mlx-server-llama.plist` |

The 8080 job runs `mlx_lm.server` from a dedicated Python 3.12 venv, *not* Homebrew or the
system Python — see "Two Python stacks" below for why.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.local.mlx-server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/andrewhouser/.venvs/mlx-lm/bin/mlx_lm.server</string>
    <string>--model</string>
    <string>mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-DWQ</string>
    <string>--host</string><string>0.0.0.0</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>60</integer>
  <key>StandardOutPath</key><string>/Users/andrewhouser/Library/Logs/mlx-server.log</string>
  <key>StandardErrorPath</key><string>/Users/andrewhouser/Library/Logs/mlx-server-error.log</string>
</dict>
</plist>
```

8080 omits `--port` and takes the default; `com.local.mlx-server-llama.plist` is the same
shape with its own label, model, `--port 8081`, and log paths.

`KeepAlive{SuccessfulExit=false}` plus `ThrottleInterval` 60 means a model that *fails* to
load retries every 60 seconds forever rather than stopping. A bad edit here looks like
silence, not an error — always read the log after changing one.

To load or reload — `launchctl load -w` is the legacy form, and `kickstart -k` does **not**
pick up plist edits, because launchd caches the job definition in memory. Editing a plist
and kickstarting silently keeps running the old config. Use the full cycle:

```bash
launchctl bootout gui/$(id -u)/com.local.mlx-server
```

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.local.mlx-server.plist
```

```bash
tail -20 ~/Library/Logs/mlx-server-error.log
```

> **A LaunchAgent only runs while someone is logged in.** For a headless always-on Mini,
> either enable auto-login, or move these to `/Library/LaunchDaemons` with a `UserName` key
> — a daemon starts at boot with no session. Auto-login is simpler and, on a machine on your
> own LAN, usually the right trade.

Confirm both are answering:

```bash
curl -s http://192.168.0.145:8080/v1/models && curl -s http://192.168.0.145:8081/v1/models
```

## Models to remove

Measured on this host, warm:

| model | simple question | tool call | throughput | verdict |
|---|---|---|---|---|
| `Llama-3.2-3B-Instruct-4bit` | 0.60s | 1.0s | 39.1 tok/s | **keep** — the fast tier |
| `Qwen3-Coder-30B-A3B-Instruct-4bit-DWQ` | 0.82s | 1.4s | 32.7 tok/s | **keep** — the default |
| `Qwen2.5-Coder-14B-Instruct-8bit` | 1.35s | 6.6s | **5.6 tok/s** | ~~remove~~ — deleted 2026-07-31 |
| `Qwen3-4B-8bit` | 1.57s | 6.9s | 12.8 tok/s | ~~remove~~ — deleted 2026-07-31 |
| `Qwen3.5-4B-8bit` | — | — | — | ~~broken~~ — deleted 2026-07-31 |

- **`Qwen2.5-Coder-14B-8bit`** is about six times slower than the 30B *and* less capable.
  A dense 14B at 8-bit is ~15GB of weights and memory-bandwidth bound; the 30B MoE only
  activates ~3B parameters per token. There is no task where the 14B is the right answer.
- **`Qwen3-4B-8bit`** is a *thinking* model — it emits `<think>` blocks, which is why its
  tool calls take 6.9s against the 30B's 1.4s. Fine for chat, wrong for a "fast" tier.
- **`Qwen3.5-4B-8bit`** failed with `Model type qwen3_5 not supported` — the `mlx-lm` on the
  system Python predated that architecture. That is now fixed by the 3.12 venv below, but the
  model was deleted rather than kept.

All three are gone as of 2026-07-31. The cache holds `Llama-3.2-3B-Instruct-4bit`,
`Qwen3-Coder-30B-A3B-Instruct-4bit-DWQ`, and `Qwen3.6-35B-A3B-4bit-DWQ`.

**`Qwen3.6-35B-A3B-4bit-DWQ` is downloaded but not wired in.** It loads and runs (36 tok/s,
20.8GB peak), but it is a *reasoning* model: it puts its chain-of-thought in a separate
`message.reasoning` field and spends heavily on it. "Reply with exactly: OK" costs **255
completion tokens** against the 30B's **2**. Worse, with a small `max_tokens` the budget is
consumed mid-reasoning and the response comes back with **no `content` key at all** rather
than a short answer. Anything pointed at it must budget generously and tolerate a missing
`content`. It is a candidate for a future judgment tier, not a drop-in for `standard`.

Models live in `~/.cache/huggingface/hub`; remove with
`huggingface-cli delete-cache`, or delete the `models--mlx-community--<name>` directory.

## Two Python stacks

The two servers deliberately run on **different Python installs**, and this is load-bearing:

| port | interpreter | mlx-lm |
|---|---|---|
| 8080 | `~/.venvs/mlx-lm/bin/python` — Homebrew Python 3.12.13 | 0.31.3 (mlx 0.32.0, transformers 5.14.1) |
| 8081 | `~/Library/Python/3.9/bin` — Apple CommandLineTools Python 3.9.6 | 0.29.1 |

Python 3.9 is a **hard dead-end for modern Qwen architectures**, and the failure is not
obvious. `Qwen3.6-35B-A3B` needs arch `qwen3_5_moe`, which first appears in mlx-lm 0.30.7;
every mlx-lm ≥ 0.30 requires `transformers>=5.0.0`; and transformers 5.x requires Python
≥ 3.10. So on 3.9, `pip install -U mlx-lm` silently resolves back to 0.29.1 and you are left
staring at `Model type qwen3_5_moe not supported` with an "up to date" install.

Do not upgrade the 3.9 site-packages to fix this — add models to the 3.12 venv instead, and
migrate 8081 to the same venv if it ever needs a post-3.9 architecture.

## Why two servers

```
alternating between two models on one server .... 1.7s to reach the 3B, 7.9s to reach the 30B
staying on one model ........................... 0.6s
```

`mlx_lm.server` keeps one model resident. Routing a simple question to the small model
saves ~0.2s of generation and then pays ~8s to switch back — on one server, tier routing is
*worse than not routing*. Two pinned servers never swap.

And this is why sizing in `src/dispatch.ts` is a regex rather than a model call:

```
answer on standard, direct ..... 873ms
answer on fast, direct ......... 684ms
classifier round-trip .......... ~800ms
```

A classifier costs four times what the cheaper model saves. Automatic routing earns its
keep *escalating* to the cloud tier for genuine judgment calls — a quality decision worth
its latency — not economising on speed.

## If you skip all of this

Leave `FAST_LLM_URL` empty. The fast tier resolves to standard, sizing becomes a no-op, and
everything works exactly as it does today. Nothing here has to be switched on.
