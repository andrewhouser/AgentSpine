#!/usr/bin/env python3
"""Speaker diarization for a meeting recording: who spoke when.

Usage: diarize.py <16kHz-mono.wav> [--models DIR] [--speakers N]

Prints JSON on stdout: {"turns": [{"start": 0.0, "end": 4.2, "speaker": 0}, ...]}
`speaker` is a 0-based index, numbered in order of first appearance. Everything is local:
sherpa-onnx runs a pyannote segmentation model plus a speaker-embedding model on the CPU.
Set up once with services/diarize/README.md.
"""
import argparse
import json
import os
import sys
import wave

import numpy as np
import sherpa_onnx


def read_wav(path):
    with wave.open(path, "rb") as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2:
            sys.exit("expected 16-bit mono PCM")
        rate = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    return rate, pcm.astype(np.float32) / 32768.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("wav")
    ap.add_argument("--models", default=os.path.expanduser("~/.diarize-models"))
    ap.add_argument("--speakers", type=int, default=0, help="known speaker count; 0 = detect")
    ap.add_argument("--threshold", type=float, default=0.5, help="clustering threshold when detecting")
    ap.add_argument("--threads", type=int, default=4)
    args = ap.parse_args()

    seg = os.path.join(args.models, "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx")
    emb = os.path.join(args.models, "nemo_en_titanet_small.onnx")
    for p in (seg, emb):
        if not os.path.exists(p):
            sys.exit(f"missing model: {p}")

    config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
        segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
            pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=seg),
            num_threads=args.threads,
        ),
        embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=emb, num_threads=args.threads),
        clustering=sherpa_onnx.FastClusteringConfig(
            num_clusters=args.speakers if args.speakers > 0 else -1, threshold=args.threshold
        ),
        min_duration_on=0.3,
        min_duration_off=0.5,
    )
    if not config.validate():
        sys.exit("invalid diarization config")
    sd = sherpa_onnx.OfflineSpeakerDiarization(config)

    rate, samples = read_wav(args.wav)
    if rate != sd.sample_rate:
        sys.exit(f"wav is {rate}Hz, model needs {sd.sample_rate}Hz")

    result = sd.process(samples).sort_by_start_time()
    # Renumber by first appearance so "Speaker 1" is whoever talks first, every time.
    order = {}
    turns = []
    for r in result:
        order.setdefault(r.speaker, len(order))
        turns.append({"start": round(r.start, 3), "end": round(r.end, 3), "speaker": order[r.speaker]})
    json.dump({"turns": turns, "speakers": len(order)}, sys.stdout)


if __name__ == "__main__":
    main()
