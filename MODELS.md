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
mlx_lm.server --model mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-DWQ --port 8080 --host 0.0.0.0
```

```bash
mlx_lm.server --model mlx-community/Llama-3.2-3B-Instruct-4bit --port 8081 --host 0.0.0.0
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

Save as `~/Library/LaunchAgents/com.agentspine.mlx-standard.plist` on the model host, and
replace `/opt/homebrew/bin/mlx_lm.server` with `which mlx_lm.server` if it differs:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.agentspine.mlx-standard</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/mlx_lm.server</string>
    <string>--model</string>
    <string>mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit-DWQ</string>
    <string>--port</string><string>8080</string>
    <string>--host</string><string>0.0.0.0</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/mlx-standard.log</string>
  <key>StandardErrorPath</key><string>/tmp/mlx-standard.err</string>
</dict>
</plist>
```

And `~/Library/LaunchAgents/com.agentspine.mlx-fast.plist`, identical but for the label,
model, port (`8081`) and log paths.

```bash
launchctl load -w ~/Library/LaunchAgents/com.agentspine.mlx-standard.plist
launchctl load -w ~/Library/LaunchAgents/com.agentspine.mlx-fast.plist
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
| `Qwen2.5-Coder-14B-Instruct-8bit` | 1.35s | 6.6s | **5.6 tok/s** | **remove** |
| `Qwen3-4B-8bit` | 1.57s | 6.9s | 12.8 tok/s | remove, or keep for non-agent use |
| `Qwen3.5-4B-8bit` | — | — | — | **broken** |

- **`Qwen2.5-Coder-14B-8bit`** is about six times slower than the 30B *and* less capable.
  A dense 14B at 8-bit is ~15GB of weights and memory-bandwidth bound; the 30B MoE only
  activates ~3B parameters per token. There is no task where the 14B is the right answer.
- **`Qwen3-4B-8bit`** is a *thinking* model — it emits `<think>` blocks, which is why its
  tool calls take 6.9s against the 30B's 1.4s. Fine for chat, wrong for a "fast" tier.
- **`Qwen3.5-4B-8bit`** fails with `Model type qwen3_5 not supported`: your `mlx-lm`
  predates that architecture. `pip install -U mlx-lm` to use it, or delete it.

Models live in `~/.cache/huggingface/hub`; remove with
`huggingface-cli delete-cache`, or delete the `models--mlx-community--<name>` directory.

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
