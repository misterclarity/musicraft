#!/usr/bin/env python3
"""Render Musicraft's instrument samples from a General MIDI soundfont.

Every instrument in the catalog (packages/score-core/src/instruments.ts) plays through one of the
sets below, chosen by its General MIDI program. Each set is a note every three semitones across the
sounding range of the instruments that use it, rendered with FluidSynth, trimmed, levelled, given a
seamless loop (sustaining instruments) and saved as mono MP3, with a manifest the app reads.

    python3 apps/web/scripts/build-samples.py [--soundfont FILE] [--out DIR]

Needs fluidsynth, ffmpeg (with libmp3lame) and numpy. The default soundfont is MuseScore General
(MIT licence): on Debian or Ubuntu, `apt install fluidsynth musescore-general-soundfont-lossless`.
"""

from __future__ import annotations

import argparse
import json
import shutil
import struct
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np

RATE = 44100
STEP = 3
VELOCITY = 96

# name: (General MIDI program, lowest and highest sounding MIDI note to cover, sustains)
SETS: dict[str, tuple[int, int, int, bool]] = {
    "trumpet": (56, 50, 89, True),
    "trombone": (57, 34, 77, True),
    "tuba": (58, 26, 70, True),
    "horn": (60, 35, 77, True),
    "piccolo": (72, 74, 108, True),
    "flute": (73, 60, 96, True),
    "oboe": (68, 58, 93, True),
    "english-horn": (69, 52, 84, True),
    "clarinet": (71, 37, 94, True),
    "bassoon": (70, 34, 75, True),
    "soprano-sax": (64, 56, 88, True),
    "alto-sax": (65, 49, 81, True),
    "tenor-sax": (66, 44, 76, True),
    "baritone-sax": (67, 37, 69, True),
    "violin": (40, 55, 105, True),
    "viola": (41, 48, 88, True),
    "cello": (42, 36, 84, True),
    "double-bass": (43, 28, 67, True),
    "guitar": (24, 40, 83, False),
    "piano": (0, 21, 108, False),
    "organ": (19, 36, 96, True),
    "choir": (52, 38, 84, True),
}

# Sustaining notes are held this long; loops repeat their last part for longer notes.
HOLD = 2.4
# Struck and plucked notes ring for this long, by pitch.
DECAY = ((48, 4.5), (72, 3.5), (128, 2.5))
SLOT = 6.5
LOOP_LENGTH = 0.8
CROSSFADE = 0.12
TARGET_RMS = 0.1


def notes_for(low: int, high: int) -> list[int]:
    """A note every STEP semitones, so that no note is shifted by more than half a step."""
    first = low + STEP // 2
    notes = list(range(first, high + 1, STEP))
    if notes[-1] + STEP // 2 < high:
        notes.append(high)
    return notes


def held(midi: int, sustains: bool) -> float:
    if sustains:
        return HOLD
    return next(length for top, length in DECAY if midi < top)


def vlq(value: int) -> bytes:
    out = [value & 0x7F]
    value >>= 7
    while value:
        out.insert(0, (value & 0x7F) | 0x80)
        value >>= 7
    return bytes(out)


def midi_file(program: int, notes: list[int], sustains: bool) -> bytes:
    """One note after another, SLOT seconds apart (960 ticks a second)."""
    ticks = 960
    events = vlq(0) + bytes([0xFF, 0x51, 0x03]) + (500000).to_bytes(3, "big")
    events += vlq(0) + bytes([0xC0, program])
    now = 0
    for i, midi in enumerate(notes):
        on = round(i * SLOT * ticks)
        off = round((i * SLOT + held(midi, sustains)) * ticks)
        events += vlq(on - now) + bytes([0x90, midi, VELOCITY])
        events += vlq(off - on) + bytes([0x80, midi, 0])
        now = off
    events += vlq(round(SLOT * ticks)) + bytes([0xFF, 0x2F, 0x00])
    track = b"MTrk" + struct.pack(">I", len(events)) + events
    return b"MThd" + struct.pack(">IHHH", 6, 0, 1, 480) + track


def read_float_wav(path: Path) -> np.ndarray:
    """Samples of a 32-bit float WAV file, mixed down to mono."""
    data = path.read_bytes()
    channels, at, samples = 2, 12, None
    while at < len(data) - 8:
        tag, size = data[at : at + 4], struct.unpack("<I", data[at + 4 : at + 8])[0]
        body = data[at + 8 : at + 8 + size]
        if tag == b"fmt ":
            fmt, channels = struct.unpack("<HH", body[:4])
            if fmt not in (3, 0xFFFE):
                raise SystemExit("FluidSynth did not write float samples.")
        elif tag == b"data":
            samples = np.frombuffer(body, dtype="<f4")
        at += 8 + size + (size & 1)
    if samples is None:
        raise SystemExit(f"No audio in {path}.")
    return samples.reshape(-1, channels).mean(axis=1)


def write_float_wav(path: Path, samples: np.ndarray) -> None:
    body = samples.astype("<f4").tobytes()
    fmt = struct.pack("<HHIIHH", 3, 1, RATE, RATE * 4, 4, 32)
    path.write_bytes(
        b"RIFF"
        + struct.pack("<I", 4 + 8 + len(fmt) + 8 + len(body))
        + b"WAVE"
        + b"fmt "
        + struct.pack("<I", len(fmt))
        + fmt
        + b"data"
        + struct.pack("<I", len(body))
        + body
    )


def onset_of(x: np.ndarray) -> int:
    peak = float(np.abs(x[: RATE]).max()) or 1.0
    return int(np.argmax(np.abs(x) > peak * 0.01))


def loop_points(x: np.ndarray, end_target: int) -> tuple[int, int]:
    """A loop of about LOOP_LENGTH ending near end_target, at rising zero crossings whose
    surroundings match best."""
    window = 256

    def crossings(around: int, spread: int) -> np.ndarray:
        lo, hi = max(1, around - spread), min(len(x) - window, around + spread)
        segment = x[lo - 1 : hi]
        rising = np.nonzero((segment[:-1] <= 0) & (segment[1:] > 0))[0] + lo
        return rising if len(rising) else np.array([around])

    ends = crossings(end_target, int(0.03 * RATE))
    starts = crossings(end_target - int(LOOP_LENGTH * RATE), int(0.03 * RATE))
    best, best_cost = (int(starts[0]), int(ends[-1])), float("inf")
    for s in starts:
        for e in ends:
            if e - s < 0.3 * RATE:
                continue
            a = x[s - window // 2 : s + window // 2]
            b = x[e - window // 2 : e + window // 2]
            cost = float(np.mean((a - b) ** 2))
            if cost < best_cost:
                best, best_cost = (int(s), int(e)), cost
    return best


def bake_crossfade(x: np.ndarray, start: int, end: int) -> np.ndarray:
    """Blend the end of the loop into what comes before its start, so the jump back is seamless."""
    n = min(int(CROSSFADE * RATE), start)
    y = x.copy()
    ramp = np.linspace(0.0, 1.0, n, dtype=np.float32)
    y[end - n : end] = x[end - n : end] * (1 - ramp) + x[start - n : start] * ramp
    return y


def build_set(name: str, program: int, low: int, high: int, sustains: bool, soundfont: Path, out: Path, work: Path) -> dict:
    notes = notes_for(low, high)
    midi_path = work / f"{name}.mid"
    wav_path = work / f"{name}.wav"
    midi_path.write_bytes(midi_file(program, notes, sustains))
    subprocess.run(
        ["fluidsynth", "-ni", "-q", "-F", str(wav_path), "-r", str(RATE), "-O", "float", "-R", "0", "-C", "0", "-g", "1.0", str(soundfont), str(midi_path)],
        check=True,
        capture_output=True,
    )
    audio = read_float_wav(wav_path)

    rendered = []
    for i, midi in enumerate(notes):
        begin = int(i * SLOT * RATE)
        length = held(midi, sustains)
        x = audio[begin : begin + int((length + 0.3) * RATE)].astype(np.float32)
        first = max(0, onset_of(x) - int(0.002 * RATE))
        x = x[first : first + int(length * RATE)]
        onset = onset_of(x)
        loudness = x[onset + int(0.1 * RATE) : onset + int((0.8 if sustains else 0.4) * RATE)]
        rendered.append({"midi": midi, "x": x, "onset": onset, "rms": float(np.sqrt(np.mean(loudness**2)))})

    gain = TARGET_RMS / float(np.median([r["rms"] for r in rendered]))
    entries = []
    (out / name).mkdir(parents=True, exist_ok=True)
    for r in rendered:
        x = r["x"] * min(gain, 0.95 / float(np.abs(r["x"]).max()))
        entry = {"midi": r["midi"], "file": f"{name}/{r['midi']}.mp3", "onset": round(r["onset"] / RATE, 4)}
        if sustains:
            start, end = loop_points(x, len(x) - int(0.06 * RATE))
            x = bake_crossfade(x, start, end)[: end + int(0.01 * RATE)]
            entry["loop"] = [round(start / RATE, 5), round(end / RATE, 5)]
        else:
            fade = int(0.05 * RATE)
            x[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)
        note_wav = work / f"{name}-{r['midi']}.wav"
        write_float_wav(note_wav, x)
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(note_wav), "-ac", "1", "-c:a", "libmp3lame", "-q:a", "6", str(out / entry["file"])],
            check=True,
        )
        entries.append(entry)
    print(f"{name}: {len(entries)} notes", file=sys.stderr)
    return {"program": program, "sustains": sustains, "notes": entries}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--soundfont", type=Path, default=Path("/usr/share/sounds/sf2/MuseScore_General_Full.sf2"))
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "public" / "samples")
    parser.add_argument("--only", nargs="*", help="Build only these sets (the manifest keeps the others).")
    args = parser.parse_args()
    for tool in ("fluidsynth", "ffmpeg"):
        if not shutil.which(tool):
            raise SystemExit(f"{tool} is needed.")
    if not args.soundfont.exists():
        raise SystemExit(f"No soundfont at {args.soundfont}.")

    manifest_path = args.out / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if args.only and manifest_path.exists() else {"sets": {}}
    manifest.update({"version": 1, "source": args.soundfont.name})
    with tempfile.TemporaryDirectory() as tmp:
        for name, (program, low, high, sustains) in SETS.items():
            if args.only and name not in args.only:
                continue
            if (args.out / name).exists():
                shutil.rmtree(args.out / name)
            manifest["sets"][name] = build_set(name, program, low, high, sustains, args.soundfont, args.out, Path(tmp))
    manifest["sets"] = {name: manifest["sets"][name] for name in SETS if name in manifest["sets"]}
    manifest_path.write_text(json.dumps(manifest, indent=1) + "\n")


if __name__ == "__main__":
    main()
