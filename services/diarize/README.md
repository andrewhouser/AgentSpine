# Speaker detection (diarization)

Labels who said what in a meeting's final transcript. Local and CPU-only: sherpa-onnx runs a
pyannote segmentation model and a speaker-embedding model. No accounts, no cloud.

One-time setup, from the repo root:

```bash
python3 -m venv services/diarize/.venv
services/diarize/.venv/bin/pip install sherpa-onnx numpy

mkdir -p ~/.diarize-models && cd ~/.diarize-models
B=https://github.com/k2-fsa/sherpa-onnx/releases/download
curl -SL $B/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2 | tar xj
curl -SLO $B/speaker-recongition-models/nemo_en_titanet_small.onnx
```

(The `recongition` spelling is the release tag's, not a typo here.)

Without this, meetings still get sentence-level transcripts; they just have no speaker labels.

Settings (all optional): `DIARIZE_ENABLED`, `DIARIZE_SPEAKERS` (pin the speaker count when you
know it — the most reliable accuracy lever), `DIARIZE_PYTHON`, `DIARIZE_SCRIPT`,
`DIARIZE_MODEL_DIR`, `MEETING_SENTENCE_GAP_MS`.

Try it on a 16 kHz mono WAV:

```bash
services/diarize/.venv/bin/python services/diarize/diarize.py meeting.wav
```
