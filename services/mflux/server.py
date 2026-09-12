"""
An OpenAI-shaped image endpoint in front of MFLUX.

## Why this exists

MFLUX ships a CLI and a Python API, no HTTP server. AgentSpine's whole premise is that a
tier is an *endpoint*, not a model name (README.md:150), and src/llm.ts is a registry of
OpenAI clients keyed by baseURL. So there is nothing to point a URL at until something
speaks HTTP. This is that something, and it deliberately speaks the OpenAI images spec —
`POST /v1/images/generations` — so the client side is `clientFor(IMAGE_URL).images
.generate()` rather than a new transport.

## Why it loads lazily and unloads when idle

The host holds ~21GB of MLX language-model weights resident. Those allocations are
pageable, not wired, so a resident image pipeline here does not fail outright — it quietly
pages the LLM out and the next chat request pays the fault-in off SSD. Keeping the
pipeline resident would make every image cost the LLM tier a slow turn afterwards.

Image generation is bursty and latency-tolerant: nothing in AgentSpine needs a sub-second
image. So the trade is to eat a cold-load penalty on the first request after idle and hold
nothing at all between bursts. Same reasoning applies on a 16GB host, where the pipeline
would otherwise be permanently competing with capture and Whisper.

## Placement

Nothing here is host-specific. Run it wherever the RAM is least contended and point
IMAGE_URL at it; the code is identical either way.
"""

from __future__ import annotations

import asyncio
import base64
import gc
import io
import os
import random
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

# --- Configuration -----------------------------------------------------------------
#
# MFLUX_REPO is a *pre-quantized* mflux repo. This matters: passing `--quantize 4` against
# a builtin alias downloads full-precision weights and quantizes on load, which for klein
# 4B is several times the 4.30GB the 4-bit repo actually costs. mflux treats a non-builtin
# --model as a `model_path` and keeps the registry config, which is what we do below.
MFLUX_BASE_MODEL = os.environ.get("MFLUX_BASE_MODEL", "flux2-klein-4b")
MFLUX_REPO = os.environ.get("MFLUX_REPO", "Runpod/FLUX.2-klein-4B-mflux-4bit")
# None when the repo is already quantized. Set only for a full-precision checkpoint.
MFLUX_QUANTIZE = int(os.environ["MFLUX_QUANTIZE"]) if os.environ.get("MFLUX_QUANTIZE") else None

IDLE_SECONDS = float(os.environ.get("MFLUX_IDLE_SECONDS", "300"))
DEFAULT_STEPS = int(os.environ.get("MFLUX_STEPS", "4"))
DEFAULT_SIDE = int(os.environ.get("MFLUX_DEFAULT_SIDE", "512"))
# A hard ceiling so a caller cannot request a size that pages the host into swap. Measured
# peak working set for klein-4b at 4 steps, cache capped:
#   512px -> 6.13GB    768px -> 9.04GB    1024px -> 13.16GB
# 768 is the safe ceiling for a 16GB host carrying capture and Whisper; 1024 needs a 32GB
# host with the language models evicted first. Raise it only after measuring on the machine
# actually running this.
MAX_SIDE = int(os.environ.get("MFLUX_MAX_SIDE", "768"))
MAX_N = int(os.environ.get("MFLUX_MAX_N", "4"))
# VAE decode is the peak-memory phase. Tiling trades a little speed for a lower peak; on a
# contended host that is the right default.
VAE_TILING = os.environ.get("MFLUX_VAE_TILING", "1") not in ("0", "false", "False")
# Cap MLX's buffer cache. Measured on the 32GB host: an unbounded cache reached 11GB at
# 512px and 24.9GB at 1024px, which drove the system to 23GB of swap and paged out the
# language models entirely. The cache is reclaimable, so capping it costs some reallocation
# rather than correctness, and it is what keeps a burst from evicting everything else.
CACHE_LIMIT_GB = float(os.environ.get("MFLUX_CACHE_LIMIT_GB", "4"))

# --- Model lifecycle ---------------------------------------------------------------
#
# One pipeline, one lock. Generation is serialized deliberately: two concurrent MLX
# pipelines on a memory-contended box is the failure mode this service exists to avoid,
# and the lock also keeps the idle reaper from unloading mid-generation.
_model = None
_model_key: tuple | None = None
_lock = threading.Lock()
_last_used = 0.0
_last_render: dict | None = None


def _mlx_clear_cache() -> None:
    """Drop MLX's buffer cache. The accessor moved between mlx versions, so try both."""
    try:
        import mlx.core as mx

        if hasattr(mx, "clear_cache"):
            mx.clear_cache()
        elif hasattr(mx, "metal") and hasattr(mx.metal, "clear_cache"):
            mx.metal.clear_cache()
    except Exception:
        # Never let cache hygiene fail a request or a shutdown.
        pass


def _mlx_mem() -> dict:
    """MLX's own allocator accounting, in GB.

    Process RSS is worthless for sizing this service: MLX allocates through Metal, so a
    fully loaded pipeline still reports near-zero RSS. Peak here is what decides whether
    the service fits on a given host.
    """
    out: dict[str, float | None] = {"active_gb": None, "peak_gb": None, "cache_gb": None}
    try:
        import mlx.core as mx

        src = mx if hasattr(mx, "get_peak_memory") else getattr(mx, "metal", None)
        if src is None:
            return out
        gb = 1073741824
        for key, fn in (
            ("active_gb", "get_active_memory"),
            ("peak_gb", "get_peak_memory"),
            ("cache_gb", "get_cache_memory"),
        ):
            f = getattr(src, fn, None)
            if f:
                out[key] = round(f() / gb, 2)
    except Exception:
        pass
    return out


def _mlx_apply_cache_limit() -> float | None:
    """Bound the MLX buffer cache. Returns the limit actually applied, in GB."""
    if CACHE_LIMIT_GB <= 0:
        return None
    try:
        import mlx.core as mx

        src = mx if hasattr(mx, "set_cache_limit") else getattr(mx, "metal", None)
        f = getattr(src, "set_cache_limit", None) if src else None
        if f:
            f(int(CACHE_LIMIT_GB * 1073741824))
            return CACHE_LIMIT_GB
    except Exception:
        pass
    return None


def _mlx_reset_peak() -> None:
    try:
        import mlx.core as mx

        src = mx if hasattr(mx, "reset_peak_memory") else getattr(mx, "metal", None)
        f = getattr(src, "reset_peak_memory", None) if src else None
        if f:
            f()
    except Exception:
        pass


def _load() -> None:
    """Build the pipeline. Caller must hold _lock."""
    global _model, _model_key
    key = (MFLUX_BASE_MODEL, MFLUX_REPO, MFLUX_QUANTIZE)
    if _model is not None and _model_key == key:
        return

    from mflux.models.common.config.model_config import AVAILABLE_MODELS
    from mflux.models.flux2.variants import Flux2Klein

    # When mflux is handed a repo id rather than a builtin alias it keeps the registry
    # config and loads weights from the path — see ConfigResolution.resolve_restricted.
    model_config = AVAILABLE_MODELS[MFLUX_BASE_MODEL]
    _model = Flux2Klein(
        model_config=model_config,
        quantize=MFLUX_QUANTIZE,
        model_path=MFLUX_REPO,
    )
    _model_key = key


def _unload() -> None:
    """Release the pipeline. Caller must hold _lock."""
    global _model, _model_key
    if _model is None:
        return
    _model = None
    _model_key = None
    gc.collect()
    _mlx_clear_cache()


def _generate_sync(prompt: str, width: int, height: int, steps: int, seed: int) -> bytes:
    """Load-if-needed and render one PNG. Runs on a worker thread under _lock."""
    global _last_used, _last_render
    with _lock:
        was_loaded = _model is not None
        _mlx_reset_peak()
        t0 = time.monotonic()
        _load()
        t_load = time.monotonic() - t0
        image = _model.generate_image(
            seed=seed,
            prompt=prompt,
            width=width,
            height=height,
            # klein is distilled; mflux rejects any other guidance for a distilled
            # checkpoint, so this is fixed rather than exposed.
            guidance=1.0,
            num_inference_steps=steps,
            scheduler="flow_match_euler_discrete",
        )
        _last_used = time.monotonic()
        _last_render = {
            "cold_load": not was_loaded,
            "load_seconds": round(t_load, 2),
            "total_seconds": round(time.monotonic() - t0, 2),
            "width": width,
            "height": height,
            "steps": steps,
            **_mlx_mem(),
        }

    buf = io.BytesIO()
    image.image.save(buf, format="PNG")
    if VAE_TILING:
        # The decode is done; reclaim its scratch buffers before the next request rather
        # than holding a high-water mark between bursts.
        _mlx_clear_cache()
    return buf.getvalue()


async def _idle_reaper() -> None:
    """Unload the pipeline once it has gone unused for IDLE_SECONDS."""
    while True:
        await asyncio.sleep(min(30.0, max(5.0, IDLE_SECONDS / 10)))
        if _model is None:
            continue
        if time.monotonic() - _last_used < IDLE_SECONDS:
            continue
        # Non-blocking: if a generation holds the lock, try again next tick rather than
        # queueing behind it.
        if _lock.acquire(blocking=False):
            try:
                if _model is not None and time.monotonic() - _last_used >= IDLE_SECONDS:
                    _unload()
            finally:
                _lock.release()


@asynccontextmanager
async def lifespan(app: FastAPI):
    applied = _mlx_apply_cache_limit()
    if applied:
        print(f"mlx cache limit set to {applied} GB", flush=True)
    task = asyncio.create_task(_idle_reaper())
    try:
        yield
    finally:
        task.cancel()
        with _lock:
            _unload()


app = FastAPI(title="mflux-image-service", lifespan=lifespan)


# --- API ---------------------------------------------------------------------------


class ImageRequest(BaseModel):
    prompt: str
    model: str | None = None
    n: int = 1
    size: str | None = None
    response_format: str = "b64_json"
    # Not part of the OpenAI spec; accepted so a caller can make a render reproducible.
    seed: int | None = None
    steps: int | None = Field(default=None, ge=1, le=50)


def _parse_size(size: str | None) -> tuple[int, int]:
    if not size:
        return DEFAULT_SIDE, DEFAULT_SIDE
    try:
        w_s, h_s = size.lower().split("x", 1)
        w, h = int(w_s), int(h_s)
    except Exception:
        raise ValueError(f"size must look like '1024x1024', got {size!r}")
    if w <= 0 or h <= 0:
        raise ValueError("size dimensions must be positive")
    if w > MAX_SIDE or h > MAX_SIDE:
        raise ValueError(f"size {w}x{h} exceeds the configured ceiling of {MAX_SIDE}px per side")
    # MFLUX wants multiples of 16; round down so we never silently exceed the ceiling.
    return (w // 16) * 16, (h // 16) * 16


@app.post("/v1/images/generations")
async def generate(req: ImageRequest):
    if req.response_format != "b64_json":
        return JSONResponse(
            status_code=400,
            content={
                "error": {
                    "message": "only response_format='b64_json' is supported; this service "
                    "does not host generated files.",
                    "type": "invalid_request_error",
                }
            },
        )
    if not req.prompt.strip():
        return JSONResponse(
            status_code=400,
            content={"error": {"message": "prompt must not be empty", "type": "invalid_request_error"}},
        )
    n = max(1, min(req.n, MAX_N))
    try:
        width, height = _parse_size(req.size)
    except ValueError as exc:
        return JSONResponse(
            status_code=400,
            content={"error": {"message": str(exc), "type": "invalid_request_error"}},
        )

    steps = req.steps or DEFAULT_STEPS
    data = []
    for i in range(n):
        seed = (req.seed + i) if req.seed is not None else random.randint(0, 2**31 - 1)
        png = await asyncio.to_thread(_generate_sync, req.prompt, width, height, steps, seed)
        data.append({"b64_json": base64.b64encode(png).decode("ascii"), "seed": seed})

    return {"created": int(time.time()), "data": data}


@app.get("/health")
async def health():
    return {
        "loaded": _model is not None,
        "base_model": MFLUX_BASE_MODEL,
        "repo": MFLUX_REPO,
        "quantize": MFLUX_QUANTIZE,
        "idle_seconds": IDLE_SECONDS,
        "idle_for": (time.monotonic() - _last_used) if _last_used else None,
        "max_side": MAX_SIDE,
        "default_steps": DEFAULT_STEPS,
        "cache_limit_gb": CACHE_LIMIT_GB,
        "mlx": _mlx_mem(),
        "last_render": _last_render,
    }


@app.get("/v1/models")
async def models():
    """Present the configured pipeline as a model id, so an OpenAI client can discover it."""
    return {"object": "list", "data": [{"id": MFLUX_BASE_MODEL, "object": "model"}]}
