#!/usr/bin/env python3
"""Build Musicraft's instrument samples: real recordings where a free library has the instrument,
soundfont notes for the rest.

The recordings come from two public-domain (CC0) libraries by Versilian Studios: VSCO 2 Community
Edition (orchestral brass, woodwinds, strings and a pipe organ) and the Versilian Community Sample
Library (saxophones and a Steinway B grand piano). Instruments neither has (guitar, choir, cor
anglais), and notes a recorded instrument doesn't reach within three semitones, are rendered from
the MuseScore General soundfont (MIT) with FluidSynth.

Each set is one instrument's notes for a General MIDI program, in up to two dynamic layers (soft
and loud): mono MP3, trimmed, levelled, tuned, and with a seamless loop for sustained notes, plus a
manifest the app reads (public/samples/manifest.json).

    python3 apps/web/scripts/build-samples.py --vsco DIR --vcsl DIR [--soundfont FILE] [--out DIR] [--only NAME ...]

Getting the libraries, with only the folders used below:

    git clone --filter=blob:none --no-checkout https://github.com/sgossner/VSCO-2-CE vsco
    git -C vsco sparse-checkout set --no-cone <the VSCO folders in SETS> && git -C vsco checkout
    git clone --filter=blob:none --no-checkout https://github.com/sgossner/VCSL vcsl
    git -C vcsl sparse-checkout set --no-cone <the VCSL folders in SETS> && git -C vcsl checkout

Needs fluidsynth, ffmpeg (with libmp3lame) and numpy; on Debian or Ubuntu
`apt install fluidsynth ffmpeg musescore-general-soundfont-lossless`.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import struct
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

import numpy as np

RATE = 44100
# A recording may be shifted this many semitones; further from any, a soundfont note fills in.
STRETCH = 3
# Soundfont notes: every three semitones, at this velocity.
STEP = 3
VELOCITY = 96
# The velocities the soft and loud recordings stand for: up to mf the soft one, from f the loud.
SOFT, LOUD, SINGLE = 60, 105, 80
# Sustained notes are kept this long and loop their last part; struck notes ring by register.
HOLD = 2.6
DECAY = ((48, 4.0), (72, 3.0), (128, 2.0))
LOOP_LENGTH = 0.8
CROSSFADE = 0.12
TARGET_RMS = 0.1
SLOT = 6.5

VSCO = "vsco"
VCSL = "vcsl"
SAX = "Aerophones/Reed Aerophones/Tenor Saxophone/Non-Vibrato"


@dataclass(frozen=True)
class Set:
    program: int
    # The sounding MIDI notes the catalog's instruments with this program can play.
    low: int
    high: int
    sustains: bool
    # Where the recordings are: (library, folder), or None for soundfont notes only.
    recordings: tuple[str, str] | None = None
    # For recordings numbered by key instead of named: the MIDI note of key 1 of each keyboard.
    keys: tuple[tuple[str, int], ...] = ()


SETS: dict[str, Set] = {
    "trumpet": Set(56, 50, 89, True, (VSCO, "Brass/Trumpet/sus")),
    "trombone": Set(57, 34, 77, True, (VSCO, "Brass/Tenor Trombone/sus")),
    "tuba": Set(58, 26, 70, True, (VSCO, "Brass/Tuba/sus")),
    "horn": Set(60, 35, 77, True, (VSCO, "Brass/F Horn/sus")),
    "piccolo": Set(72, 74, 108, True, (VSCO, "Woodwinds/Piccolo/Sus")),
    "flute": Set(73, 60, 96, True, (VSCO, "Woodwinds/Flute/susvib")),
    "oboe": Set(68, 58, 93, True, (VSCO, "Woodwinds/Oboe/Vib")),
    "english-horn": Set(69, 52, 84, True),
    "clarinet": Set(71, 37, 94, True, (VSCO, "Woodwinds/Clarinet/susLong")),
    "bassoon": Set(70, 34, 75, True, (VSCO, "Woodwinds/Bassoon/sus")),
    "soprano-sax": Set(64, 56, 88, True, (VCSL, "Aerophones/Reed Aerophones/Saxello/Non-Vibrato")),
    "tenor-sax": Set(66, 44, 76, True, (VCSL, SAX)),
    "alto-sax": Set(65, 49, 81, True, (VCSL, SAX)),
    "baritone-sax": Set(67, 37, 69, True, (VCSL, SAX)),
    "violin": Set(40, 55, 105, True, (VSCO, "Strings/Solo Violin/Arco Vib")),
    "viola": Set(41, 48, 88, True, (VSCO, "Strings/Viola Section/susvib")),
    "cello": Set(42, 36, 84, True, (VSCO, "Strings/Cello Section/susvib")),
    "double-bass": Set(43, 28, 67, True, (VSCO, "Strings/Solo Contrabass/SusVib")),
    "guitar": Set(24, 40, 83, False),
    "piano": Set(0, 21, 108, False, (VCSL, "Chordophones/Zithers/Grand Piano, Steinway B/NoSus")),
    # Organ keyboards start on C: the manual's key 1 is C2, the pedalboard's C1.
    "organ": Set(19, 36, 96, True, (VSCO, "Keys/Organ/Loud"), (("Rode_Man3Open", 36), ("Rode_Pedal", 24))),
    "choir": Set(52, 38, 84, True),
}

CREDITS = {
    VSCO: "VSCO 2 Community Edition (CC0)",
    VCSL: "Versilian Community Sample Library (CC0)",
    "soundfont": "MuseScore General soundfont (MIT)",
}

# ---------------------------------------------------------------------------------------------
# Audio


def decode(path: Path) -> np.ndarray:
    """Any audio file as mono float samples at RATE."""
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(RATE), "-f", "f32le", "-"],
        check=True,
        capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype="<f4").copy()


def write_float_wav(path: Path, samples: np.ndarray) -> None:
    body = samples.astype("<f4").tobytes()
    fmt = struct.pack("<HHIIHH", 3, 1, RATE, RATE * 4, 4, 32)
    header = b"RIFF" + struct.pack("<I", 4 + 8 + len(fmt) + 8 + len(body)) + b"WAVE"
    path.write_bytes(header + b"fmt " + struct.pack("<I", len(fmt)) + fmt + b"data" + struct.pack("<I", len(body)) + body)


def encode(samples: np.ndarray, target: Path, work: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    wav = work / "note.wav"
    write_float_wav(wav, samples)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(wav), "-ac", "1", "-c:a", "libmp3lame", "-q:a", "6", str(target)], check=True)


def onset_of(x: np.ndarray) -> int:
    peak = float(np.abs(x[: 2 * RATE]).max()) or 1.0
    return int(np.argmax(np.abs(x) > peak * 0.02))


def app_onset(x: np.ndarray) -> int:
    """Where the app's onsetOf (src/audio/samples.ts) finds the start: the first sample above 1% of
    the loudest in the first second. The manifest must say the same, as the app takes any
    difference for the MP3 decoder's delay and moves the loop by it."""
    window = np.abs(x[:RATE])
    above = np.nonzero(window > window.max() * 0.01)[0] if len(window) else []
    return int(above[0]) if len(above) else 0


def envelope(x: np.ndarray, frame: int = 882) -> np.ndarray:
    """RMS level every 20 ms."""
    frames = len(x) // frame
    return np.sqrt(np.mean(x[: frames * frame].reshape(frames, frame) ** 2, axis=1)) if frames else np.zeros(0)


def detect_pitch(x: np.ndarray) -> float | None:
    """The fundamental (as a fractional MIDI number) of a steady stretch, by the YIN method."""
    window = int(0.2 * RATE)
    max_lag = int(RATE / 25)
    min_lag = int(RATE / 4500)
    if len(x) < window + max_lag:
        return None
    seg = x[: window + max_lag].astype(np.float64)
    seg -= seg.mean()
    size = 1 << int(np.ceil(np.log2(len(seg) * 2)))
    spectrum = np.fft.rfft(seg, size)
    head = np.fft.rfft(seg[:window], size)
    cross = np.fft.irfft(np.conj(head) * spectrum, size)[: max_lag + 1]
    energy = np.concatenate(([0.0], np.cumsum(seg**2)))
    lags = np.arange(max_lag + 1)
    diff = energy[window] + (energy[lags + window] - energy[lags]) - 2 * cross
    diff[0] = 0
    cumulative = np.cumsum(diff[1:]) / np.arange(1, max_lag + 1)
    normalised = np.ones(max_lag + 1)
    normalised[1:] = diff[1:] / np.maximum(cumulative, 1e-12)
    candidates = np.nonzero(normalised[min_lag:] < 0.15)[0]
    if len(candidates):
        tau = int(candidates[0]) + min_lag
        while tau + 1 <= max_lag and normalised[tau + 1] < normalised[tau]:
            tau += 1
    else:
        tau = int(np.argmin(normalised[min_lag:])) + min_lag
    if 0 < tau < max_lag:
        a, b, c = normalised[tau - 1], normalised[tau], normalised[tau + 1]
        shift = 0.5 * (a - c) / (a - 2 * b + c) if (a - 2 * b + c) != 0 else 0.0
    else:
        shift = 0.0
    frequency = RATE / (tau + shift)
    return 69 + 12 * np.log2(frequency / 440) if 20 < frequency < 5000 else None


def loop_points(x: np.ndarray, end_target: int, length: float, midi: int) -> tuple[int, int]:
    """A loop of about `length` seconds ending near end_target, at rising zero crossings whose
    surroundings (two cycles of the note) match best."""
    period = RATE / (440 * 2 ** ((midi - 69) / 12))
    window = max(256, int(2 * period))
    spread = max(int(0.03 * RATE), int(1.5 * period))

    def crossings(around: int, spread: int) -> np.ndarray:
        lo, hi = max(window, around - spread), min(len(x) - window, around + spread)
        segment = x[lo - 1 : hi]
        rising = np.nonzero((segment[:-1] <= 0) & (segment[1:] > 0))[0] + lo
        return rising if len(rising) else np.array([around])

    ends = crossings(end_target, spread)
    starts = crossings(end_target - int(length * RATE), spread)
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


def decay_length(midi: int) -> float:
    return next(length for top, length in DECAY if midi < top)


@dataclass
class Note:
    midi: int
    samples: np.ndarray
    onset: int
    cents: float = 0.0
    source: str = "soundfont"
    loop: tuple[int, int] | None = None
    loudness: float = 0.0
    levelled: bool = False
    shaped: bool = False


def measure_loudness(note: Note, sustains: bool) -> float:
    part = note.samples[note.onset + int(0.1 * RATE) : note.onset + int((0.8 if sustains else 0.4) * RATE)]
    return float(np.sqrt(np.mean(part**2))) if len(part) else 0.0


def shape(note: Note, sustains: bool) -> None:
    """Trim a note to what is kept: a held stretch with a loop, or a ringing note that fades out."""
    if note.shaped:
        return
    note.shaped = True
    x = note.samples
    if sustains:
        level = envelope(x[note.onset :])
        steady = float(np.median(level[15:75])) if len(level) > 20 else float(level.max(initial=0))
        # The note is held until its level last falls below half the steady level (a note that
        # swells from soft counts from its start), at the latest HOLD.
        above = np.nonzero(level >= steady * 0.5)[0]
        held = (int(above[-1]) + 1) * 882 if len(above) else len(x) - note.onset
        keep = min(int(HOLD * RATE), held)
        x = x[: note.onset + keep]
        if keep > int(1.3 * RATE):
            end_target = len(x) - int(0.06 * RATE)
            start, end = loop_points(x, end_target, min(LOOP_LENGTH, keep / RATE - 0.6), note.midi)
            x = bake_crossfade(x, start, end)[: end + int(0.01 * RATE)]
            note.loop = (start, end)
    else:
        x = x[: note.onset + int(decay_length(note.midi) * RATE)].copy()
        fade = min(len(x), int(0.08 * RATE))
        x[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)
    note.samples = x


def level(notes: list[Note]) -> None:
    """Bring a group of notes (one layer of one source) to the same loudness, keeping their balance."""
    fresh = [n for n in notes if not n.levelled]
    if not fresh:
        return
    gain = TARGET_RMS / float(np.median([n.loudness or TARGET_RMS for n in notes]))
    for n in fresh:
        n.samples = n.samples * min(gain, 0.95 / max(float(np.abs(n.samples).max()), 1e-9))
        n.levelled = True


# ---------------------------------------------------------------------------------------------
# Recordings

NAME = re.compile(r"_([A-G]#?)(-?\d)(?=_|\.)")
LAYER = re.compile(r"_(vl?\d|pp|p|mp|mf|f|ff)(?=_|\.wav$)")
ROUND = re.compile(r"(?:_rr(\d+)|_(\d+)\.wav$)")
KEY = re.compile(r"_(\d+)\.wav$")
PITCH_CLASS = {"C": 0, "C#": 1, "D": 2, "D#": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "G#": 8, "A": 9, "A#": 10, "B": 11}
DYNAMICS = {"pp": 1, "p": 2, "mp": 3, "mf": 4, "f": 5, "ff": 6}


def layer_rank(token: str | None) -> int:
    if token is None:
        return 0
    if token in DYNAMICS:
        return DYNAMICS[token]
    return int(re.sub(r"\D", "", token))


@dataclass
class Take:
    path: Path
    named: int | None  # MIDI number from the file name (C4 = 60), before the folder's octave convention
    key: str | None  # for files numbered by key instead (organ): the group and the key number
    number: int
    rank: int
    round: int


def takes_in(folder: Path) -> list[Take]:
    takes = []
    for path in sorted(folder.glob("*.wav")):
        name = NAME.search(path.name)
        layer = LAYER.search(path.name)
        rnd = ROUND.search(path.name)
        key = KEY.search(path.name) if not name else None
        takes.append(
            Take(
                path=path,
                named=(int(name.group(2)) + 1) * 12 + PITCH_CLASS[name.group(1)] if name else None,
                key=path.name[: key.start()] if key else None,
                number=int(key.group(1)) if key else 0,
                rank=layer_rank(layer.group(1) if layer else None),
                round=int(next(g for g in rnd.groups() if g)) if rnd else 1,
            )
        )
    return takes


def mode(values: list[int]) -> int:
    return max(set(values), key=values.count)


def recorded_notes(folder: Path, sustains: bool, keys: tuple[tuple[str, int], ...] = ()) -> tuple[dict[int, Note], dict[int, Note], list[str]]:
    """The soft and the loud recording of every pitch in a folder (the same note where there is only
    one), placed by measuring what was played, and warnings where a name doesn't match it."""
    every = takes_in(folder)
    first_round = {(t.named, t.key, t.number, t.rank): min(x.round for x in every if (x.named, x.key, x.number, x.rank) == (t.named, t.key, t.number, t.rank)) for t in every}
    takes = [t for t in every if t.round == first_round[(t.named, t.key, t.number, t.rank)]]
    audio = {t.path: decode(t.path) for t in takes}
    measured = {t.path: detect_pitch(audio[t.path][onset_of(audio[t.path]) + int(0.15 * RATE) :]) for t in takes}
    # The folder's octave numbering (middle C as C3 or C4), or the key numbering of the organ.
    midi_of: dict[Path, int] = {}
    named = [t for t in takes if t.named is not None and measured[t.path] is not None]
    if named:
        offset = mode([round((measured[t.path] - t.named) / 12) * 12 for t in named])  # type: ignore[operator]
        midi_of.update({t.path: t.named + offset for t in takes if t.named is not None})
    first_key = dict(keys)
    for group in {t.key for t in takes if t.key}:
        if group not in first_key:
            raise SystemExit(f"{folder}: say which note key 1 of {group} is (Set.keys).")
        midi_of.update({t.path: first_key[group] + t.number - 1 for t in takes if t.key == group})
    # A take a semitone or two from its name (both layers of the horn's G2 are an F sharp, near
    # enough) goes where it sounds, unless a take named for that pitch is there; further off, the
    # measurement caught an overtone and the name stands.
    moved: dict[Path, str] = {}
    for t in takes:
        found, named_midi = measured[t.path], midi_of.get(t.path)
        if found is None or named_midi is None:
            continue
        off = found - named_midi
        off -= round(off / 12) * 12
        if sustains and 0.6 < abs(off) <= 2.5:
            midi_of[t.path] = named_midi + round(off)
            moved[t.path] = f"{t.path.name}: sounds {off * 100:+.0f} cents from its name, used as {named_midi + round(off)}"
    named_pitches = {midi_of[t.path] for t in takes if t.path in midi_of and t.path not in moved}
    soft: dict[int, Take] = {}
    loud: dict[int, Take] = {}
    for t in takes:
        midi = midi_of.get(t.path)
        if midi is None or (t.path in moved and midi in named_pitches):
            continue
        if midi not in soft or t.rank < soft[midi].rank:
            soft[midi] = t
        if midi not in loud or t.rank > loud[midi].rank:
            loud[midi] = t

    warnings: list[str] = list(moved.values())
    notes: dict[Path, Note] = {}

    def note(t: Take, midi: int) -> Note:
        if t.path in notes:
            return notes[t.path]
        x = audio[t.path]
        x = x[max(0, onset_of(x) - int(0.005 * RATE)) :]
        cents = 0.0
        found = measured[t.path]
        # Wind, strings and voices are tuned by ear while playing; a piano's tuning stays (and its
        # bass strings' overtones mislead the measurement).
        if found is not None and sustains:
            off = (found - midi) * 100
            off -= round(off / 1200) * 1200
            if abs(off) > 60:
                warnings.append(f"{t.path.name}: sounds {off:+.0f} cents from {midi}, left untuned")
            elif abs(off) > 3:
                cents = round(off, 1)
        made = Note(midi=midi, samples=x, onset=onset_of(x), cents=cents, source=folder.as_posix())
        made.loudness = measure_loudness(made, sustains)
        notes[t.path] = made
        return made

    return {m: note(soft[m], m) for m in sorted(soft)}, {m: note(loud[m], m) for m in sorted(loud)}, warnings


# ---------------------------------------------------------------------------------------------
# Soundfont notes


def vlq(value: int) -> bytes:
    out = [value & 0x7F]
    value >>= 7
    while value:
        out.insert(0, (value & 0x7F) | 0x80)
        value >>= 7
    return bytes(out)


def held(midi: int, sustains: bool) -> float:
    return HOLD + 0.2 if sustains else decay_length(midi)


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


def soundfont_notes(program: int, notes: list[int], sustains: bool, soundfont: Path, work: Path) -> list[Note]:
    if not notes:
        return []
    midi_path, wav_path = work / "sf.mid", work / "sf.wav"
    midi_path.write_bytes(midi_file(program, notes, sustains))
    subprocess.run(
        ["fluidsynth", "-ni", "-q", "-F", str(wav_path), "-r", str(RATE), "-O", "float", "-R", "0", "-C", "0", "-g", "1.0", str(soundfont), str(midi_path)],
        check=True,
        capture_output=True,
    )
    audio = decode(wav_path)
    rendered = []
    for i, midi in enumerate(notes):
        begin = int(i * SLOT * RATE)
        x = audio[begin : begin + int((held(midi, sustains) + 0.3) * RATE)]
        start = max(0, onset_of(x) - int(0.002 * RATE))
        x = x[start:]
        made = Note(midi=midi, samples=x, onset=onset_of(x))
        made.loudness = measure_loudness(made, sustains)
        rendered.append(made)
    return rendered


def gaps(have: list[int], low: int, high: int) -> list[int]:
    """Soundfont notes for the stretches no recording reaches within STRETCH semitones (each covers
    a semitone either side)."""
    missing = [m for m in range(low, high + 1) if not have or min(abs(m - h) for h in have) > STRETCH]
    fill: list[int] = []
    for m in missing:
        if fill and m - fill[-1] <= 1:
            continue
        fill.append(m + 1 if m + 1 in missing else m)
    return fill


def build_set(name: str, spec: Set, libraries: dict[str, Path], soundfont: Path, out: Path, work: Path, shared: dict) -> dict:
    """One instrument's notes: its recordings (or another set's, for the same folder) in the range it
    plays, soundfont notes where they don't reach, written as MP3 with a manifest entry."""
    layers: list[dict[int, Note]] = [{}]
    if spec.recordings:
        if spec.recordings not in shared:
            soft, loud, warnings = recorded_notes(libraries[spec.recordings[0]] / spec.recordings[1], spec.sustains, spec.keys)
            for w in warnings:
                print(f"  {w}", file=sys.stderr)
            shared[spec.recordings] = {"soft": soft, "loud": loud, "folder": name, "files": {}}
        entry = shared[spec.recordings]
        near = lambda notes: {m: n for m, n in notes.items() if spec.low - STRETCH <= m <= spec.high + STRETCH}  # noqa: E731
        soft, loud = near(entry["soft"]), near(entry["loud"])
        layers = [soft, loud] if any(soft[m] is not loud[m] for m in soft) else [soft]
    fill = gaps(sorted(layers[0]), spec.low, spec.high)
    filled = soundfont_notes(spec.program, fill, spec.sustains, soundfont, work)
    level(filled)
    for notes in layers:
        level(list(notes.values()))

    target = out / name
    if target.exists():
        shutil.rmtree(target)
    files: dict[int, str] = shared[spec.recordings]["files"] if spec.recordings else {}
    folder = shared[spec.recordings]["folder"] if spec.recordings else name
    in_both = {id(n) for n in layers[0].values()} & {id(n) for n in layers[-1].values()}

    def file_of(n: Note, layer: int) -> str:
        if n.source == "soundfont":
            path = f"{name}/sf{n.midi}.mp3"
        elif id(n) in files:
            return files[id(n)]
        else:
            path = f"{folder}/{n.midi}{'' if id(n) in in_both else 'pf'[layer]}.mp3"
            files[id(n)] = path
        shape(n, spec.sustains)
        encode(n.samples, out / path, work)
        return path

    manifest_layers = []
    for index, notes in enumerate(layers):
        entries = []
        for n in sorted([*notes.values(), *filled], key=lambda n: n.midi):
            path = file_of(n, index)
            item: dict = {"midi": n.midi, "file": path, "onset": round(app_onset(n.samples) / RATE, 5)}
            if n.cents:
                item["cents"] = n.cents
            if n.loop:
                item["loop"] = [round(n.loop[0] / RATE, 5), round(n.loop[1] / RATE, 5)]
            entries.append(item)
        manifest_layers.append({"velocity": SINGLE if len(layers) == 1 else (SOFT, LOUD)[index], "notes": entries})

    sources = [CREDITS[spec.recordings[0]]] if spec.recordings else []
    if fill:
        sources.append(CREDITS["soundfont"])
    print(f"{name}: {len(layers[0])} recorded pitches in {len(layers)} layer(s), {len(fill)} soundfont notes", file=sys.stderr)
    return {"program": spec.program, "sustains": spec.sustains, "sources": sources, "layers": manifest_layers}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--vsco", type=Path, required=True, help="A checkout of VSCO-2-CE")
    parser.add_argument("--vcsl", type=Path, required=True, help="A checkout of VCSL")
    parser.add_argument("--soundfont", type=Path, default=Path("/usr/share/sounds/sf2/MuseScore_General_Full.sf2"))
    parser.add_argument("--out", type=Path, default=Path(__file__).resolve().parent.parent / "public" / "samples")
    parser.add_argument("--only", nargs="*", help="Build only these sets (the manifest keeps the others).")
    args = parser.parse_args()
    for tool in ("fluidsynth", "ffmpeg"):
        if not shutil.which(tool):
            raise SystemExit(f"{tool} is needed.")
    if not args.soundfont.exists():
        raise SystemExit(f"No soundfont at {args.soundfont}.")
    libraries = {VSCO: args.vsco, VCSL: args.vcsl}

    manifest_path = args.out / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) if args.only and manifest_path.exists() else {"sets": {}}
    manifest["version"] = 2
    shared: dict[tuple[str, str], dict] = {}
    with tempfile.TemporaryDirectory() as tmp:
        for name, spec in SETS.items():
            if args.only and name not in args.only and not any(spec.recordings == SETS[o].recordings for o in args.only if o in SETS):
                continue
            manifest["sets"][name] = build_set(name, spec, libraries, args.soundfont, args.out, Path(tmp), shared)
    manifest["sets"] = {name: manifest["sets"][name] for name in SETS if name in manifest["sets"]}
    manifest_path.write_text(json.dumps(manifest, indent=1) + "\n")


if __name__ == "__main__":
    main()
