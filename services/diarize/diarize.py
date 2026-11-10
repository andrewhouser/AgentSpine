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
    ap.add_argument("--threshold", type=float, default=0.75, help="clustering threshold when detecting; higher = fewer speakers")
    ap.add_argument("--max-speakers", type=int, default=8, help="never report more than this many")
    ap.add_argument("--min-share", type=float, default=0.03, help="a speaker with less than this share of the talking is folded into a neighbour")
    ap.add_argument("--min-seconds", type=float, default=10.0, help="...or with less than this many seconds")
    ap.add_argument("--threads", type=int, default=4)
    args = ap.parse_args()

    seg = os.path.join(args.models, "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx")
    emb = os.path.join(args.models, "nemo_en_titanet_small.onnx")
    for p in (seg, emb):
        if not os.path.exists(p):
            sys.exit(f"missing model: {p}")

    def build(clusters):
        config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(model=seg),
                num_threads=args.threads,
            ),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=emb, num_threads=args.threads),
            clustering=sherpa_onnx.FastClusteringConfig(num_clusters=clusters, threshold=args.threshold),
            min_duration_on=0.3,
            min_duration_off=0.5,
        )
        if not config.validate():
            sys.exit("invalid diarization config")
        return sherpa_onnx.OfflineSpeakerDiarization(config)

    rate, samples = read_wav(args.wav)
    sd = build(args.speakers if args.speakers > 0 else -1)
    if rate != sd.sample_rate:
        sys.exit(f"wav is {rate}Hz, model needs {sd.sample_rate}Hz")

    def run(sd):
        return [(r.start, r.end, r.speaker) for r in sd.process(samples).sort_by_start_time()]

    raw = run(sd)

    if args.speakers <= 0:
        raw = fold_small(raw, args.min_share, args.min_seconds)
        # Still more voices than any room holds: cluster again with the count pinned.
        if len({s for _, _, s in raw}) > args.max_speakers:
            raw = fold_small(run(build(args.max_speakers)), args.min_share, args.min_seconds)

    # Renumber by first appearance so "Speaker 1" is whoever talks first, every time.
    order = {}
    turns = []
    for start, end, spk in raw:
        order.setdefault(spk, len(order))
        turns.append({"start": round(start, 3), "end": round(end, 3), "speaker": order[spk]})
    json.dump({"turns": turns, "speakers": len(order)}, sys.stdout)


def fold_small(turns, min_share, min_seconds):
    """Real recordings over-split: one person becomes several clusters, and a cough or a
    chair squeak becomes its own "speaker". Fold any speaker with a trivial share of the
    talking into whoever was speaking beside them."""
    total = sum(e - s for s, e, _ in turns) or 1.0
    talk = {}
    for s, e, spk in turns:
        talk[spk] = talk.get(spk, 0.0) + (e - s)
    # The absolute floor only means something in a recording long enough to have real speakers
    # with real talk time; in a short clip a person can legitimately say ten seconds in all.
    long_recording = total >= 12 * min_seconds
    small = {spk for spk, t in talk.items() if t / total < min_share or (long_recording and t < min_seconds)}
    big = [spk for spk in talk if spk not in small]
    if not big:  # everyone is small (a very short clip): keep the loudest talker only
        big = [max(talk, key=talk.get)]
        small = set(talk) - set(big)
    out = []
    for i, (s, e, spk) in enumerate(turns):
        if spk in small:
            neighbour = next((turns[j][2] for j in range(i - 1, -1, -1) if turns[j][2] not in small), None)
            if neighbour is None:
                neighbour = next((turns[j][2] for j in range(i + 1, len(turns)) if turns[j][2] not in small), big[0])
            spk = neighbour
        out.append((s, e, spk))
    return out


if __name__ == "__main__":
    main()
