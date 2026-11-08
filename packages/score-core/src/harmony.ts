/**
 * Simple chord recognition: which chord sounds on each beat, from all parts at concert pitch.
 * Used by the AI assistant (analyze_harmony) and the arranger.
 */
import { add, frac, gt, lt, max, min, sub, toNumber, type Fraction } from "./fraction";
import { eventOnsets, eventValue, measureLengths, timeSignatures, type Id, type Score } from "./model";
import { midiNumber, type Pitch, type Step } from "./pitch";

interface Template {
  suffix: string;
  intervals: number[];
  /** Small penalty for less common chords, so a plain triad wins ties. */
  cost: number;
}

const TEMPLATES: Template[] = [
  { suffix: "", intervals: [0, 4, 7], cost: 0 },
  { suffix: "m", intervals: [0, 3, 7], cost: 0 },
  { suffix: "7", intervals: [0, 4, 7, 10], cost: 0.02 },
  { suffix: "maj7", intervals: [0, 4, 7, 11], cost: 0.04 },
  { suffix: "m7", intervals: [0, 3, 7, 10], cost: 0.03 },
  { suffix: "dim", intervals: [0, 3, 6], cost: 0.04 },
  { suffix: "m7b5", intervals: [0, 3, 6, 10], cost: 0.05 },
  { suffix: "dim7", intervals: [0, 3, 6, 9], cost: 0.05 },
  { suffix: "aug", intervals: [0, 4, 8], cost: 0.06 },
  { suffix: "sus4", intervals: [0, 5, 7], cost: 0.06 },
  { suffix: "sus2", intervals: [0, 2, 7], cost: 0.08 },
  { suffix: "6", intervals: [0, 4, 7, 9], cost: 0.07 },
  { suffix: "m6", intervals: [0, 3, 7, 9], cost: 0.08 },
  { suffix: "9", intervals: [0, 4, 7, 10, 2], cost: 0.09 },
  { suffix: "add9", intervals: [0, 4, 7, 2], cost: 0.09 },
  { suffix: "7sus4", intervals: [0, 5, 7, 10], cost: 0.09 },
  { suffix: "5", intervals: [0, 7], cost: 0.1 },
];

export interface SoundingNote {
  pitch: Pitch;
  /** How long the note sounds in the window (any unit). */
  weight: number;
}

export interface ChordGuess {
  /** e.g. "Bb", "F7/A", "Gm"; a single pitch class is shown in brackets, e.g. "(C)". */
  name: string;
  root?: Pick<Pitch, "step" | "alter">;
  bass?: Pick<Pitch, "step" | "alter">;
  /** Pitch classes (0–11) of the chord. */
  pitchClasses: number[];
  /** 0–1, how much of the sound the chord explains. */
  fit: number;
}

const pc = (p: Pitch) => ((midiNumber(p) % 12) + 12) % 12;

export function pitchName(p: Pick<Pitch, "step" | "alter">): string {
  const acc = p.alter > 0 ? "#".repeat(p.alter) : "b".repeat(-p.alter);
  return `${p.step}${acc}`;
}

/** Name the chord formed by a set of sounding notes, or null for silence. */
export function nameChord(notes: SoundingNote[]): ChordGuess | null {
  const weights = new Map<number, number>();
  const spelling = new Map<number, Map<string, { p: Pitch; w: number }>>();
  let total = 0;
  let bassMidi = Infinity;
  let bass: Pitch | undefined;
  for (const n of notes) {
    if (n.weight <= 0) continue;
    const c = pc(n.pitch);
    weights.set(c, (weights.get(c) ?? 0) + n.weight);
    let names = spelling.get(c);
    if (!names) spelling.set(c, (names = new Map()));
    const key = pitchName(n.pitch);
    const entry = names.get(key) ?? { p: n.pitch, w: 0 };
    entry.w += n.weight;
    names.set(key, entry);
    total += n.weight;
    const midi = midiNumber(n.pitch);
    if (midi < bassMidi) {
      bassMidi = midi;
      bass = n.pitch;
    }
  }
  if (!total || !bass) return null;
  const spell = (c: number): Pick<Pitch, "step" | "alter"> => {
    const best = [...(spelling.get(c)?.values() ?? [])].sort((a, b) => b.w - a.w)[0];
    return best ? { step: best.p.step, alter: best.p.alter } : { step: "C" as Step, alter: 0 };
  };
  const bassPc = pc(bass);
  if (weights.size === 1) {
    const only = spell(bassPc);
    return { name: `(${pitchName(only)})`, root: only, bass: only, pitchClasses: [bassPc], fit: 1 };
  }

  let best: { score: number; root: number; template: Template; fit: number } | undefined;
  for (const root of weights.keys()) {
    for (const template of TEMPLATES) {
      const members = new Set(template.intervals.map((i) => (root + i) % 12));
      let inside = 0;
      let outside = 0;
      for (const [c, w] of weights) {
        if (members.has(c)) inside += w;
        else outside += w;
      }
      let missing = 0;
      for (const m of members) if (!weights.has(m)) missing++;
      // Missing fifths are common; other missing tones count more.
      const fifthMissing = !weights.has((root + 7) % 12) && template.intervals.includes(7) ? 1 : 0;
      const score =
        (inside - outside) / total -
        0.18 * (missing - fifthMissing) -
        0.06 * fifthMissing -
        template.cost +
        (root === bassPc ? 0.08 : 0);
      if (!best || score > best.score + 1e-9) best = { score, root, template, fit: inside / total };
    }
  }
  const { root, template, fit } = best!;
  const rootName = spell(root);
  const bassName = spell(bassPc);
  const slash = root !== bassPc ? `/${pitchName(bassName)}` : "";
  return {
    name: `${pitchName(rootName)}${template.suffix}${slash}`,
    root: rootName,
    bass: bassName,
    pitchClasses: template.intervals.map((i) => (root + i) % 12),
    fit,
  };
}

export interface HarmonySegment {
  measureIndex: number;
  /** Start within the bar, in whole notes. */
  offset: Fraction;
  length: Fraction;
  /** 1-based beat number where the segment starts. */
  beat: number;
  chord: ChordGuess | null;
}

/** The beat used for harmonic analysis: a dotted quarter in 6/8, 9/8 and 12/8. */
export function analysisBeat(beats: number, beatType: number): Fraction {
  if (beatType === 8 && beats % 3 === 0 && beats > 3) return frac(3, 8);
  return frac(1, beatType);
}

/** Notes sounding in a window of a bar, from the given parts (all by default). */
export function soundingNotes(score: Score, measureIndex: number, start: Fraction, end: Fraction, partIds?: Id[]): SoundingNote[] {
  const length = measureLengths(score)[measureIndex]!;
  const notes: SoundingNote[] = [];
  for (const part of score.parts) {
    if (partIds && !partIds.includes(part.id)) continue;
    for (const voice of part.measures[measureIndex]?.voices ?? []) {
      const onsets = eventOnsets(voice, length);
      voice.events.forEach((e, i) => {
        if (e.kind !== "note" || e.grace) return;
        const a = onsets[i]!;
        const b = add(a, eventValue(e, length));
        const overlap = sub(min(b, end), max(a, start));
        if (!gt(overlap, frac(0))) return;
        for (const n of e.notes) notes.push({ pitch: n.pitch, weight: toNumber(overlap) });
      });
    }
  }
  return notes;
}

/** Chords beat by beat for bars from–to; consecutive beats with the same chord are merged. */
export function analyzeHarmony(score: Score, from: number, to: number, partIds?: Id[]): HarmonySegment[] {
  const lengths = measureLengths(score);
  const times = timeSignatures(score);
  const segments: HarmonySegment[] = [];
  for (let m = from; m <= to; m++) {
    const length = lengths[m]!;
    const beat = analysisBeat(times[m]!.beats, times[m]!.beatType);
    let t = frac(0);
    let index = 1;
    while (lt(t, length)) {
      const end = min(add(t, beat), length);
      const chord = nameChord(soundingNotes(score, m, t, end, partIds));
      const previous = segments[segments.length - 1];
      if (previous && previous.measureIndex === m && previous.chord?.name === chord?.name) {
        previous.length = add(previous.length, sub(end, t));
      } else {
        segments.push({ measureIndex: m, offset: t, length: sub(end, t), beat: index, chord });
      }
      t = end;
      index++;
    }
  }
  return segments;
}

/** "Bb (1–2) | F7/A (3) | Bb (4)" for one bar. */
export function describeBarHarmony(segments: HarmonySegment[], beatsInBar: number): string {
  return segments
    .map((s, i) => {
      const next = segments[i + 1];
      const last = next && next.measureIndex === s.measureIndex ? next.beat - 1 : beatsInBar;
      const beats = last > s.beat ? `${s.beat}–${last}` : `${s.beat}`;
      return `${s.chord?.name ?? "rest"} (${beats})`;
    })
    .join(" | ");
}
