# Model host setup (the M4 Mini at 192.168.0.150)

> **The host is `192.168.0.150`, and that address is now static** (set 2026-09-08). It was
> `.145`, then briefly `.134` on a DHCP lease; each move turned every local call into a
> timeout with nothing in any log to say why, which is the reason it is pinned.
>
> A hostname is not the answer here: the router calls the Mini `Mac.lan` and calls the
> AgentSpine machine at `.85` the same thing, so the IP is what the config carries. If local
> calls ever start timing out again, `arp -n 192.168.0.150` returning `(incomplete)` means
> the host is off or off the network — not that it moved.

Everything here runs on the **model host**, not on the machine running AgentSpine.

## What to run

Two `mlx_lm.server` processes, each pinned to one model. Two, not one, because a single
server holds one model resident and swapping costs more than a smaller model saves — see
"Why two servers" below.

| port | model | size | role |
|---|---|---|---|
| 8080 | `mlx-community/Qwen3.6-35B-A3B-4bit-DWQ` | ~21GB | `standard` — the default |
| 8081 | `mlx-community/Llama-3.2-3B-Instruct-4bit` | ~2GB | `fast` — lookups, `tracker`/`runner`/`inspector` |

~23GB of 32GB, against an `iogpu.wired_limit_mb` of **28672** — set at boot by
`/Library/LaunchDaemons/com.agentspine.wiredlimit.plist`, the only daemon setting it as of
2026-09-12.

**There is less headroom than that arithmetic suggests.** Measured on the host with both
servers warm and nothing else running: 31GB used, under 1GB free, ~2.3GB already in swap.
MLX's allocations are *pageable*, not wired, so anything else wanting a few GB does not fail
— it silently pages the models out, and the next request pays the fault-in off SSD. Measured
on :8080 that costs **31–64s** against 0.21s warm. Treat this host as full; see
[IMAGE_GENERATION.md](IMAGE_GENERATION.md) for why image generation runs on the app host
instead.

## `standard` is a reasoning model now — thinking must be turned off

`Qwen3.6-35B-A3B` replaced `Qwen3-Coder-30B-A3B` on 8080. It is a *reasoning* model: left to
itself it puts a chain of thought in `message.reasoning` and "Reply with exactly: OK" costs
**255 completion tokens** against the 30B's **2**. That is only slow. The failure that bites
is that AgentSpine's short structured calls — classification, titling, sizing — cap
`max_tokens`: the cap is consumed mid-thought and the reply arrives with **no `content` key
at all**. A caller written against the old 30B sees an intermittent *empty* answer, not an
error.

Every request to 8080 must therefore carry:

```json
{ "chat_template_kwargs": { "enable_thinking": false } }
```

AgentSpine sends this from `chat()` in `src/llm.ts` to every local endpoint (not to the
cloud tier — OpenAI 400s on unknown body fields). A chat template with no `enable_thinking`
switch, like Llama's on 8081, ignores the kwarg, so there is no need to send it selectively.
Anything else that talks to 8080 — a script, a curl, another machine — has to send it too.

Measured warm, with thinking off:

| | simple question | tool call | throughput |
|---|---|---|---|
| `Qwen3.6-35B-A3B-4bit-DWQ` (8080) | 0.97s | 1.28s | 28.0 tok/s |
| `Llama-3.2-3B-Instruct-4bit` (8081) | 0.60s | — | 37.0 tok/s |

So the tier argument below survives the swap: the 35B MoE is within ~25% of a dense 3B's
throughput, and `standard` stays the right default.

## Running them by hand (to try it)

```bash
~/.venvs/mlx-lm/bin/mlx_lm.server --model mlx-community/Qwen3.6-35B-A3B-4bit-DWQ --port 8080 --host 0.0.0.0
```

```bash
~/Library/Python/3.9/bin/mlx_lm.server --model mlx-community/Llama-3.2-3B-Instruct-4bit --port 8081 --host 0.0.0.0
```

Then on the AgentSpine machine:

```bash
# .env
LOCAL_LLM_URL=http://192.168.0.150:8080/v1
LOCAL_MODEL=mlx-community/Qwen3.6-35B-A3B-4bit-DWQ
FAST_LLM_URL=http://192.168.0.150:8081/v1
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
    <string>mlx-community/Qwen3.6-35B-A3B-4bit-DWQ</string>
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

`/v1/models` lists the whole HuggingFace cache, not what is resident — all four models show
up on both ports. To find out what is actually loaded, send a one-token completion and read
the `model` field back; a resident model answers in under a second, a swap takes ~8s.

> **A LaunchAgent only runs while someone is logged in.** For a headless always-on Mini,
> either enable auto-login, or move these to `/Library/LaunchDaemons` with a `UserName` key
> — a daemon starts at boot with no session. Auto-login is simpler and, on a machine on your
> own LAN, usually the right trade.

Confirm both are answering:

```bash
curl -s http://192.168.0.150:8080/v1/models && curl -s http://192.168.0.150:8081/v1/models
```

## Models to remove

Measured on this host, warm:

| model | simple question | tool call | throughput | verdict |
|---|---|---|---|---|
| `Llama-3.2-3B-Instruct-4bit` | 0.60s | 1.0s | 39.1 tok/s | **keep** — the fast tier |
| `Qwen3-Coder-30B-A3B-Instruct-4bit-DWQ` | 0.82s | 1.4s | 32.7 tok/s | superseded 2026-09-08 by the 35B; still cached |
| `Qwen2.5-Coder-14B-Instruct-8bit` | 1.35s | 6.6s | **5.6 tok/s** | ~~remove~~ — deleted **2026-09-12**; this doc wrongly claimed 2026-07-31, see below |
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

The two 4B models went on 2026-07-31. **The 14B did not** — this doc said it had, and it was
wrong for six weeks; see "A pinned server is only pinned if every client agrees" below. It was
actually deleted on 2026-09-12, reclaiming 15GB.

The cache now holds exactly three models: `Llama-3.2-3B-Instruct-4bit` (1.7GB),
`Qwen3-Coder-30B-A3B-Instruct-4bit-DWQ` (16GB, the one-line revert), and
`Qwen3.6-35B-A3B-4bit-DWQ` (19GB, the `standard` tier) — 37GB total, verified 2026-09-12.

**`Qwen3.6-35B-A3B-4bit-DWQ` is the `standard` tier as of 2026-09-08.** The reasoning
behaviour that made it look unusable — a `message.reasoning` field, 255 completion tokens to
say "OK", and a missing `content` key when `max_tokens` is small — is switched off at the
chat template with `chat_template_kwargs.enable_thinking: false`, not worked around by
budgeting generously. See "thinking must be turned off" above.

Models live in `~/.cache/huggingface/hub`; remove with
`huggingface-cli delete-cache`, or delete the `models--mlx-community--<name>` directory.

## A pinned server is only pinned if every client agrees

**`--model` is a boot default, not a constraint.** `mlx_lm.server` loads whatever model a
*request* names, evicting the incumbent. So a client naming a different id silently re-points
the tier, and the plist keeps looking correct the whole time.

This is not hypothetical. Between 2026-08-13 and 2026-09-08, :8080 served
`Qwen2.5-Coder-14B-Instruct-8bit` — the 5.6 tok/s model this doc had already declared deleted
— continuously, because a stale second AgentSpine checkout was running on the model host with
a hardcoded `PRIMARY_MODEL` and calling `127.0.0.1:8080` every 15 minutes. The standard tier
ran at roughly a sixth of its throughput for 26 days. Nothing alerted, because the port kept
answering 200.

Two rules follow:

1. **Never hardcode a model id in a client.** Read it from config, so there is one place it
   can be wrong. This applies to anything new pointed at these servers — including the image
   service in [IMAGE_GENERATION.md](IMAGE_GENERATION.md).
2. **Never run AgentSpine on the model host.** That is what put a stale client on loopback.
   The stale `~/agentspine` copy is not a git checkout and is managed by nothing.

To check what a tier is *actually* serving rather than what it was launched with:

```bash
curl -s http://192.168.0.150:8080/v1/chat/completions -H 'Content-Type: application/json' \
  -d '{"model":"mlx-community/Qwen3.6-35B-A3B-4bit-DWQ","messages":[{"role":"user","content":"hi"}],"max_tokens":1,"chat_template_kwargs":{"enable_thinking":false}}' \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('model'))"
```

Note that `GET /v1/models` will **not** tell you this — it lists the whole local HuggingFace
cache, not the resident model, so every port reports every model it could load.

## Two Python stacks

The two servers deliberately run on **different Python installs**, and this is load-bearing:

| port | interpreter | mlx-lm |
|---|---|---|
| 8080 | `~/.venvs/mlx-lm/bin/python` — Homebrew Python 3.12.13 | 0.31.3 (mlx 0.32.0, transformers 5.14.1) |
| 8081 | ~~`~/Library/Python/3.9/bin` — Apple CommandLineTools Python 3.9.6~~ | 0.29.1 → **0.31.3** |

**8081 is no longer on 0.29.1.** As of 2026-09-08 both ports report
`system_fingerprint: 0.31.3-0.32.0`, so 8081 has been moved off Python 3.9 — the split below
is history, not current state. Confirm the plist's interpreter path on the host before
relying on either row.

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
