# Image generation (MFLUX) — implementation steps

Everything below is for **`.85`, the 16 GB Mini that runs AgentSpine**. Nothing here goes on
the model host.

The service itself is already written and measured: [`services/mflux/server.py`](services/mflux/server.py).
It was built and benchmarked on the 32 GB model host on 2026-09-12, and the numbers in this
document are measured on that hardware, not estimated. What remains is deploying it on `.85`
and wiring AgentSpine to it.

## Why this needs a service at all

MFLUX ships a CLI and a Python API. It has **no HTTP server mode**. AgentSpine's premise is
that a tier is an *endpoint*, not a model name, and `src/llm.ts` is a registry of OpenAI
clients keyed by `baseUrl`. So there is nothing to point a URL at until something speaks
HTTP.

`server.py` is that something, and it deliberately implements OpenAI's own image endpoint —
`POST /v1/images/generations` — so the client side is `clientFor(url, key).images.generate()`
rather than a new transport. `openai` is already a dependency at `^4.104.0`, which supports
`images.generate()`.

## Why it runs on `.85` and not on the model host

This is the load-bearing constraint. An image render on the model host pages the language
models out, and the next chat request pays the fault-in off SSD. Measured on :8080:

| | 35B latency |
|---|---|
| warm baseline | **0.21s** |
| immediately after a 512px render | **31.6s** |
| immediately after a 1024px render | **64.4s** |
| the call after that (re-warmed) | 0.21s |

A ~300x penalty on the standard tier per image. MLX's allocations are pageable rather than
wired, so this does not fail loudly — it just makes the LLM slow in a way that looks like
the network. Do not co-locate these.

## Measured footprints — do not re-derive these

FLUX.2 klein 4B at 4-bit (`Runpod/FLUX.2-klein-4B-mflux-4bit`, 4.30 GB on disk), 4 steps,
MLX cache capped at 4 GB:

| Size | Wall time | Peak working set |
|---|---|---|
| 512x512 | 15–20s | 6.13 GB |
| 768x768 | 27.7s | 9.04 GB |
| 1024x1024 | 48.0s | 13.16 GB |

Peak is from MLX's own allocator (`mx.get_peak_memory`). **Process RSS is useless here** — a
fully loaded pipeline reports near-zero RSS, which is the same reason `mlx_lm.server` looks
like 277 MB in `ps`.

On a 16 GB host already carrying capture, Whisper and the dashboard, **768px is the ceiling
and 512px is the default**. 1024px needs 13.16 GB and does not fit. `server.py` ships with
those defaults (`MFLUX_MAX_SIDE=768`, `MFLUX_DEFAULT_SIDE=512`); raise them only after
measuring on `.85` itself.

## Two traps that are already handled in the code

Both are worth understanding before changing anything, because both are easy to reintroduce.

**1. The buffer cache, not the weights, is what wrecks the host.** Left unbounded, MLX's
cache reached 11 GB at 512px and **24.9 GB** at 1024px, which drove the machine to 23 GB of
swap and evicted everything else. `server.py` calls `mx.set_cache_limit` at startup
(`MFLUX_CACHE_LIMIT_GB`, default 4). This changes neither peak working set nor output — it
only stops the cache from growing without bound.

**2. Never pass `--quantize`/`quantize=` against a builtin model alias.** That downloads
full-precision weights and quantizes on load. Pointing `model_path` at a pre-quantized repo
instead is what keeps the download at 4.30 GB. `server.py` does this: `MFLUX_REPO` is the
quantized repo and `MFLUX_QUANTIZE` stays unset.

## Steps

### 1. Preflight on `.85`

These were verified on the model host, **not** on `.85`, so check them there:

```bash
python3 --version                      # need >= 3.10 for mflux
ls /opt/homebrew/bin/python3.1*         # Homebrew 3.12 is sufficient; uv is not required
df -h "$HOME" | tail -1                # need ~6 GB free for weights + venv
sysctl -n hw.memsize | awk '{printf "%.0f GB\n", $1/1073741824}'
```

If the only interpreter is Apple's system Python 3.9.6, install a newer one. Do **not**
upgrade system site-packages.

### 2. Its own venv

```bash
python3.12 -m venv ~/.venvs/mflux
~/.venvs/mflux/bin/pip install mflux fastapi uvicorn
```

This must be a **separate venv**. It pulls `torch` and its own `mlx` build, and must not
share an environment with anything the LLM servers depend on.

### 3. Weights

```bash
HF_HUB_ENABLE_HF_TRANSFER=1 ~/.venvs/mflux/bin/python -c \
  "from huggingface_hub import snapshot_download; print(snapshot_download('Runpod/FLUX.2-klein-4B-mflux-4bit'))"
```

Expect 4.3 GB in `~/.cache/huggingface/hub`.

### 4. Run it and verify

`services/mflux/` inside this repo is the **canonical location** — run it from there, not
from a copy. A second copy elsewhere on disk is the same trap as the stale `~/agentspine`
checkout that served the wrong model for 26 days: the two drift, and nothing tells you which
one is live. Keeping it in the repo also means a fix arrives by `git pull`.

```bash
cd ~/Developer/AgentSpine/services/mflux && ~/.venvs/mflux/bin/uvicorn server:app --host 127.0.0.1 --port 8082
```

Adjust the path if the repo lives elsewhere on this machine.

```bash
curl -s http://127.0.0.1:8082/health
```

`loaded` must be `false` on a fresh start — the pipeline is absent until the first request
and unloads again after `MFLUX_IDLE_SECONDS` (default 300). Verified behaviour: active MLX
memory returns to `0.0 GB` after the reaper fires. That idle-unload is the whole reason this
can share a 16 GB box; do not make it eager.

Then one real render:

```bash
curl -s -X POST http://127.0.0.1:8082/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"a red ceramic teapot on a wooden table","size":"512x512","seed":42}' \
  | python3 -c "import json,sys,base64; d=json.load(sys.stdin); open('/tmp/t.png','wb').write(base64.b64decode(d['data'][0]['b64_json']))"
```

`GET /health` afterwards reports `last_render` with load time, total time and peak memory.
Compare the peak against the table above; if it is materially higher on `.85`, lower
`MFLUX_MAX_SIDE` before going further.

### 5. launchd

A ready plist ships at [`services/mflux/com.local.mflux.plist`](services/mflux/com.local.mflux.plist).
Check the three items called out in its header comment — `WorkingDirectory`, the uvicorn
path, and `MFLUX_MAX_SIDE` — then:

```bash
cp services/mflux/com.local.mflux.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.local.mflux.plist
```

To stop or cycle it:

```bash
launchctl bootout gui/$UID/com.local.mflux
```

**Use `bootout`/`bootstrap`, not `stop`/`start`.** `KeepAlive` is `true`, so `launchctl stop`
is undone by an immediate respawn.

It binds `127.0.0.1`, because there is no auth on this endpoint and AgentSpine is on the same
machine. Only widen to `0.0.0.0` if something off-box genuinely needs it.

Note this plist deliberately differs from the MLX agents on the model host in two ways.
Those use `KeepAlive = { SuccessfulExit = false }`, which makes a clean stop ambiguous, and
`ThrottleInterval = 60`, which can leave a minute-long dead window after a restart. Neither
is wanted here.

### 6. AgentSpine: config

`IMAGE_URL` does not exist anywhere in the codebase yet. Add to `src/config.ts` alongside the
other endpoints:

```typescript
export const IMAGE_BASE_URL = env.IMAGE_URL ?? "";
```

Empty-string default keeps it a no-op when unset, matching how `FAST_BASE_URL` degrades.

### 7. AgentSpine: the tool

New file in `src/tools/`, registered in `src/tools/index.ts` (import it, then add it to the
`tools` array — that array is the only thing that grants the agent a capability).

A `Tool` must supply `name`, `description`, `argsSchema`, `classify`, `checkPolicy`, and
`run`. Use `src/tools/weather.ts` as the shape reference: it is the closest existing analogue
— a keyless call to a known endpoint returning structured data.

Points specific to this tool:

- The call is `clientFor(IMAGE_BASE_URL, "not-needed").images.generate({ prompt, size, response_format: "b64_json" })`.
- `response_format` must be `b64_json`. The service does not host files and returns 400 for
  `"url"`.
- A render takes 15–30s. Whatever timeout wraps it must allow for that plus a possible cold
  load, and the first call after idle pays both.
- Decide where the PNG goes. Returning base64 into the model's context would be enormous;
  write it to disk and return the path.
- `checkPolicy` needs a real decision. The prompt reaching this tool comes from the model,
  and the output is a file written to disk — treat it as such rather than copying weather's
  read-only posture wholesale.

### 8. AgentSpine: `.env` on `.85`

```bash
IMAGE_URL=http://127.0.0.1:8082/v1
```

Loopback, because the service and AgentSpine are on the same machine. Use
`http://192.168.0.85:8082/v1` only if something off-box needs it, and bind the service to
`0.0.0.0` in that case.

> **`.env` is resolved relative to the process working directory.** `src/config.ts` calls
> `process.loadEnvFile()` with no argument. If the launchd job for AgentSpine has no
> `WorkingDirectory` pointing at the repo root, `.env` is silently skipped and *every* value
> falls back to its default — including `LOCAL_LLM_URL`, whose default is the dead
> `192.168.0.145`. That failure mode looks exactly like the model host being down. Confirm
> the job's `WorkingDirectory` before blaming the network.

## One thing to know about failover while testing

`src/router.ts` falls back **downward into local**, and the fallback list is
`["standard", "deep"]` — the chosen tier is skipped when it resolves to the same endpoint. So
if `standard` is what went down, the next stop is the **cloud** tier, not `fast`. The fast
tier is never used as a fallback even when it is up and healthy.

For `sensitivity: "private"` the list is `["standard"]` alone, which means a private request
against a down standard tier **fails outright** rather than degrading.

Nothing about the image service depends on this. It matters because if you test by stopping
:8080, the resulting behaviour is cloud spend or a hard failure — not a quiet downgrade.

## Related

- [MODELS.md](MODELS.md) — the model host, the two pinned servers, and the 14B incident
- `src/tiers.ts` — why a tier is an endpoint
- `src/router.ts` — retry and tier fallback
