# Voice: a wake word in, a spoken reply out

Turn on **Hands-free** on the chat page, say the wake word ("Gianna" by default), and talk. It
answers out loud and keeps listening until you stop talking for a while.

```
off ──▶ idle ──wake word──▶ listening ──you speak──▶ thinking ──reply──▶ speaking
         ▲                    ▲  │                                          │
         │                    │  └─ silence for the timeout ────────────────┤
         └────────────────────┴────────────────────────────────────────────┘
```

- **idle** — hears the room, and asks one question of each stretch of speech: was that my name?
- **listening** — a conversation held open. Everything you say is for the assistant; no wake
  word needed. It closes after the **timeout** with nobody speaking, and the clock starts when
  the assistant *finishes talking*, never when you sent your message, so a slow answer cannot
  use up your turn. A rising chime means it woke, a falling one means it closed.
- **thinking / speaking** — the microphone is deliberately deaf (see "Limits").

Say the wake word and the question together ("Gianna, what's on my calendar?") or apart ("Gianna."
… then the question). "Hey Gianna" works, and so does ending with it ("What's the weather, Gianna?").
A name mentioned mid-sentence ("ask Gianna about it") does not wake it.

## Everything is configurable, per browser

**Settings → Voice**: the wake word, extra spellings, whether words that *sound like* it are
accepted, and how long a conversation stays open (5–300 s, default 20). These live in this
browser's localStorage, like the appearance settings — the wake word is a property of the room, so
the study and the kitchen can answer to different names. `.env` only supplies the defaults a
browser starts from (`VOICE_WAKE_WORD`, `VOICE_WAKE_ALIASES`, `VOICE_WAKE_SOUNDS`,
`VOICE_TIMEOUT_SECONDS`); a saved choice always wins.

## Setup

Listening reuses the Whisper models dictation and meetings already use (`DICTATION_MODEL`, plus
the fast `base.en` for wake-word spotting — `VOICE_WAKE_MODEL`). **Speaking** needs the local
Kokoro service in [services/tts/](services/tts/), one time:

```bash
# 1. The phonemizer. NOT optional on macOS — see "Why espeak-ng from Homebrew" below.
brew install espeak-ng

# 2. A venv. kokoro-onnx needs Python >= 3.10, and the system python3 is 3.9, so let uv fetch one.
pip3 install uv
uv venv --python 3.12 ~/.venvs/tts
VIRTUAL_ENV=~/.venvs/tts uv pip install kokoro-onnx fastapi uvicorn soundfile

# 3. The model (~92 MB) and the voice pack (~28 MB).
mkdir -p ~/.kokoro-models && cd ~/.kokoro-models
B=https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0
curl -L -O $B/kokoro-v1.0.int8.onnx
curl -L -O $B/voices-v1.0.bin
```

Run it by hand to try it:

```bash
cd services/tts && ~/.venvs/tts/bin/uvicorn server:app --host 127.0.0.1 --port 8083
curl localhost:8083/health          # {"ok": true, "loaded": true, ...}
```

Then point the dashboard at it and restart it:

```
# .env
TTS_URL=http://127.0.0.1:8083/v1
```

To keep it running, copy `services/tts/com.local.tts.plist` to `~/Library/LaunchAgents/`, check the
paths in it, and `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.local.tts.plist`.

If `TTS_URL` is unset or the service is down, **the chat page says so** next to the Hands-free
button and in Settings → Voice. Listening still works; replies just appear on screen.

## What was measured

All on a heavily loaded 10-core Apple-silicon Mac (load average ~21), so treat these as pessimistic.

| | |
|---|---|
| Kokoro int8, CPU | ~1.5× realtime — 8 s of speech in ~5 s. CoreML was no faster. |
| Wake word → "Thinking…" | ~5 s from the start of speech: the 0.8 s end-of-speech wait, then two Whisper passes. |
| Wake-word recall | Spellings + aliases: 12/15. Sounds-alike: 15/15. (5 synthetic voices, 3 phrases.) |
| False wakes on other speech | 0 for ordinary speech, silence, noise, "Hanna", "Anna". 9/26 with sounds-alike on — all *real near-homophone names*: Jane, Gina, Joanna. |

The last two rows are why **"Accept words that sound like it"** is a setting. Whisper almost never
writes a name the way you meant — "Gianna" came back as *Jaina*, *Jayana*, *Jayena*, *Jana*, never
once as "Gianna" — so an alias list can only chase what it wrote last time. The sounds-alike match
compares consonant skeletons (J‑N), which catches all of those and also, unavoidably, "Jane". A more
distinctive wake word needs it less. These are synthetic voices in a quiet room; a real room will
differ, and the `heard "…"` text beside the Hands-free button is how you see what Whisper wrote.

### Why not just tell Whisper the word?

It looks like the obvious fix and it is a trap. Putting the wake word in the decoder prompt fixed
the spelling (15/15) and also made Whisper hear "Hanna", "Gina" and "Anna" as "Gianna" (9/26 false
wakes on speech that never contained it). The prompt is a prior and the prior wins. Matching on an
*unprompted* transcript has neither problem.

### Why espeak-ng from Homebrew

Kokoro phonemises with espeak-ng, and `kokoro-onnx` bundles a copy via the `espeakng-loader` wheel.
On macOS that copy has the CI runner's data directory compiled in, ignores the path it is given,
and on first synthesis **exits the process** (not an exception) with `Error processing file
'/Users/runner/work/…/phontab'`. Verified against espeakng-loader 0.2.0–0.2.4. The service prefers
Homebrew's copy and, if there isn't one, returns a 503 saying so instead of reaching the call it
cannot survive.

## Limits

- **Needs a secure context.** The browser only grants microphone access on `localhost` or HTTPS —
  not on a plain-http LAN address. The Hands-free button says so rather than failing on press.
- **The tab has to be open**, and the session belongs to the chat page: leaving the conversation
  turns it off (and the browser's recording indicator with it).
- **You cannot talk over it.** The microphone is deaf while it speaks, because the speakers are in
  the same room and it would otherwise transcribe itself, answer that, and loop. The **Stop**
  button interrupts instead.
- **Only voice-initiated messages are spoken.** Type a message while Hands-free is on and the
  answer stays on screen.
- **Replies are cut at ~900 characters** (`VOICE_MAX_CHARS`), on a sentence boundary. Code blocks
  and tables are replaced by "the code is on screen"; links are read as "link".
- **Idle listening transcribes everything the room says**, with the fast model, to look for the
  wake word. Nothing is kept — audio is decoded to a temp file and deleted — but it does cost CPU,
  and it is the reason the idle model is the small one.
- Wake-word matching can't tell a name from its near-homophones (above), and Whisper hallucinates
  stock phrases ("Thank you.") on noise; those are filtered before they can become a message.

## Files

| | |
|---|---|
| `web/src/hooks/useVoiceSession.ts` | the state machine, microphone, playback |
| `web/src/lib/vad.ts` | cutting a live stream into utterances (tested) |
| `src/senses/speech.ts` | what to say aloud; whether you were addressed (tested) |
| `src/senses/voice.ts`, `/api/voice/*` | status, listen, plan, speak |
| `services/tts/` | the Kokoro service and its LaunchAgent |
