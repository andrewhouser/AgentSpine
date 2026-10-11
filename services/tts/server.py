"""
An OpenAI-shaped speech endpoint in front of Kokoro.

## Why this exists

Same reason services/mflux/ does: AgentSpine's premise is that a tier is an *endpoint*, and
src/server.ts only knows how to POST to a URL. Kokoro ships a Python API and no HTTP server,
so this is the smallest thing that speaks `POST /v1/audio/speech` — the OpenAI speech spec —
which means swapping Kokoro for another engine later is a change to this file and nothing else.

## Why Kokoro, and why the ONNX build

Kokoro is an 82M-parameter model: small enough to stay resident (the ONNX file is ~310MB, the
int8 one ~90MB) and fast enough on Apple silicon to synthesise several seconds of speech per
second. That is the property that matters here. The image service unloads when idle because a
render pages the language models out; this one is two orders of magnitude smaller, and an idle
unload would put a cold-load pause in front of the first spoken word of every conversation —
exactly the moment latency is most audible.

ONNX rather than MLX is a deliberate trade for fewer moving parts: onnxruntime, numpy and one
small package, no dependency on the MLX version the image service and the language models are
already pinned against.

## Placement

Runs on whichever host the dashboard runs on; TTS_URL says where. Nothing in here is
host-specific. It binds to 127.0.0.1 by default — there is no auth, and a speech endpoint that
anything on the LAN could drive is a free way to make the machine talk.
"""

from __future__ import annotations

import io
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
import soundfile as sf
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

# --- espeak-ng ---------------------------------------------------------------------
#
# Kokoro turns text into phonemes with espeak-ng, and kokoro-onnx ships a bundled copy via the
# `espeakng-loader` wheel. On macOS that bundled library has the CI runner's data directory
# compiled in (/Users/runner/work/...) and ignores the path it is told to use, so the first
# synthesis prints "Error processing file '.../phontab'" and KILLS THE PROCESS — not an
# exception, an exit — which under launchd KeepAlive becomes a restart loop that looks like a
# service that is up and never answers. Verified against espeakng-loader 0.1.x-0.2.4.
#
# Homebrew's espeak-ng (1.52, same engine) has a correct data path, so prefer it when present
# and refuse to synthesise, with a message, when it is not — rather than reach the call that
# cannot be survived.
_SYSTEM_ESPEAK = next(
    (
        p
        for p in (
            os.environ.get("PHONEMIZER_ESPEAK_LIBRARY", ""),
            "/opt/homebrew/lib/libespeak-ng.dylib",
            "/usr/local/lib/libespeak-ng.dylib",
            "/usr/lib/x86_64-linux-gnu/libespeak-ng.so.1",
            "/usr/lib/aarch64-linux-gnu/libespeak-ng.so.1",
        )
        if p and os.path.exists(p)
    ),
    None,
)
if _SYSTEM_ESPEAK:
    os.environ["PHONEMIZER_ESPEAK_LIBRARY"] = _SYSTEM_ESPEAK

# --- Configuration -----------------------------------------------------------------

MODEL_DIR = Path(os.environ.get("TTS_MODEL_DIR", str(Path.home() / ".kokoro-models")))
# int8 is the one this was measured with: ~90MB against ~310MB, with no audible difference on
# speech this short, and no slower on CPU. Point TTS_MODEL_FILE at kokoro-v1.0.onnx for full precision.
MODEL_FILE = os.environ.get("TTS_MODEL_FILE", "kokoro-v1.0.int8.onnx")
VOICES_FILE = os.environ.get("TTS_VOICES_FILE", "voices-v1.0.bin")
DEFAULT_VOICE = os.environ.get("TTS_VOICE", "af_heart")
DEFAULT_LANG = os.environ.get("TTS_LANG", "en-us")
# A reply is capped upstream (VOICE_MAX_CHARS), but this endpoint is a service in its own right
# and should not trust its caller to have done so.
MAX_CHARS = int(os.environ.get("TTS_MAX_CHARS", "4000"))

# --- Model lifecycle ---------------------------------------------------------------
#
# One engine, one lock. onnxruntime sessions are safe to share, but Kokoro's phonemizer is not
# documented as reentrant, and two simultaneous syntheses on the same box only make both
# slower. Requests queue instead, which is also the right behaviour for speech: two replies
# should never talk over each other.
_engine = None
_lock = threading.Lock()
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="tts")
_last: dict | None = None


def _paths() -> tuple[Path, Path]:
    return MODEL_DIR / MODEL_FILE, MODEL_DIR / VOICES_FILE


def _missing() -> list[str]:
    missing = [str(p) for p in _paths() if not p.exists()]
    if sys.platform == "darwin" and not _SYSTEM_ESPEAK:
        missing.append("espeak-ng (run: brew install espeak-ng)")
    return missing


def _load():
    global _engine
    if _engine is None:
        from kokoro_onnx import Kokoro

        model, voices = _paths()
        _engine = Kokoro(str(model), str(voices))
    return _engine


def _synthesise(text: str, voice: str, speed: float, lang: str) -> tuple[np.ndarray, int, float]:
    global _last
    with _lock:
        engine = _load()
        started = time.perf_counter()
        samples, rate = engine.create(text, voice=voice, speed=speed, lang=lang)
        took = time.perf_counter() - started
    seconds = len(samples) / rate
    _last = {
        "chars": len(text),
        "audio_s": round(seconds, 2),
        "took_s": round(took, 2),
        # Above 1 the service synthesises faster than it plays, which is the whole requirement
        # for streaming a reply sentence by sentence.
        "realtime_factor": round(seconds / took, 1) if took else None,
    }
    return samples, rate, seconds


@asynccontextmanager
async def lifespan(_: FastAPI):
    # Load on startup, not on first request: the first request is a person waiting to hear a
    # reply. A missing model file is reported by /health and by the 503 below rather than
    # crashing the service, so launchd's KeepAlive does not turn it into a restart loop.
    if not _missing():
        _executor.submit(_load)
    yield
    _executor.shutdown(wait=False, cancel_futures=True)


app = FastAPI(title="AgentSpine TTS", lifespan=lifespan)


class SpeechRequest(BaseModel):
    # `model` is accepted because the OpenAI spec sends one; it is ignored because this
    # service hosts exactly one engine and reports it via /v1/models.
    model: str | None = None
    input: str = Field(min_length=1)
    voice: str | None = None
    speed: float = Field(default=1.0, ge=0.5, le=2.0)
    response_format: str = "wav"


@app.post("/v1/audio/speech")
async def speech(req: SpeechRequest):
    import asyncio

    if req.response_format != "wav":
        # WAV only, deliberately: the browser decodes it natively, and encoding anything else
        # would add a dependency for no benefit on a loopback hop.
        return JSONResponse({"error": "only response_format=wav is supported"}, status_code=400)
    if missing := _missing():
        return JSONResponse(
            {"error": f"speech service is missing: {', '.join(missing)} — see VOICE.md"},
            status_code=503,
        )
    text = req.input.strip()[:MAX_CHARS]
    voice = req.voice or DEFAULT_VOICE
    loop = asyncio.get_running_loop()
    try:
        samples, rate, _ = await loop.run_in_executor(
            _executor, _synthesise, text, voice, req.speed, DEFAULT_LANG
        )
    except Exception as err:  # unknown voice, phonemizer failure, ...
        return JSONResponse({"error": f"synthesis failed: {err}"}, status_code=400)

    buf = io.BytesIO()
    sf.write(buf, samples, rate, format="WAV", subtype="PCM_16")
    return Response(buf.getvalue(), media_type="audio/wav")


@app.get("/v1/models")
def models():
    return {"object": "list", "data": [{"id": "kokoro", "object": "model"}]}


@app.get("/v1/voices")
def voices():
    if _missing():
        return {"voices": [], "default": DEFAULT_VOICE}
    with _lock:
        names = sorted(_load().get_voices())
    return {"voices": names, "default": DEFAULT_VOICE}


@app.get("/health")
def health():
    missing = _missing()
    return {
        "ok": not missing,
        "loaded": _engine is not None,
        "missing": missing,
        "voice": DEFAULT_VOICE,
        "last": _last,
    }
