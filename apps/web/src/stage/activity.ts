/**
 * What the stage shows while the music plays: who is playing, how loud and how high, and where the
 * beat is. The stage view fills `live` from playback frames; the 3D components read it every frame.
 */
import { timeSignatures, type Performance, type PerformanceNote, type Score } from "@musicraft/score-core";

export interface PartActivity {
  /** 0 when silent, up to 1 at the loudest dynamics. */
  level: number;
  /** The highest note sounding, as a sounding MIDI number. */
  midi: number | null;
  /** When the part's newest sounding note began (seconds): a new value means a new note. */
  onset: number;
}

/** Activity of every part from the notes sounding now (parts that are silent are left out). */
export function partActivity(notes: PerformanceNote[]): Map<string, PartActivity> {
  const parts = new Map<string, PartActivity>();
  for (const note of notes) {
    const part = parts.get(note.partId) ?? { level: 0, midi: null, onset: -1 };
    part.level = Math.max(part.level, Math.min(1, note.velocity / 118));
    part.midi = part.midi === null ? note.midi : Math.max(part.midi, note.midi);
    part.onset = Math.max(part.onset, note.start);
    parts.set(note.partId, part);
  }
  return parts;
}

/** The state of the performance, shared with the 3D components. */
export const live = {
  playing: false,
  time: 0,
  parts: new Map<string, PartActivity>(),
};

export interface Beat {
  /** Which beat of the bar (0-based). */
  beat: number;
  /** How many beats the conductor gives in this bar. */
  beats: number;
  /** 0 on the beat, rising to 1 just before the next. */
  phase: number;
}

/**
 * Where the conductor's beat is at a time. Compound time (6/8, 9/8, 12/8) is conducted in dotted
 * quarters, so 12/8 has four beats.
 */
export function beatAt(score: Score, performance: Performance, time: number): Beat | null {
  const measures = performance.measures;
  if (!measures.length) return null;
  let lo = 0;
  let hi = measures.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measures[mid]!.start <= time) lo = mid;
    else hi = mid - 1;
  }
  const bar = measures[lo]!;
  if (time < bar.start || time >= bar.start + bar.duration + 0.5) return null;
  const signature = timeSignatures(score)[bar.measureIndex] ?? { beats: 4, beatType: 4 };
  const compound = signature.beatType === 8 && signature.beats % 3 === 0 && signature.beats > 3;
  const beats = Math.max(1, compound ? signature.beats / 3 : signature.beats);
  const position = ((time - bar.start) / bar.duration) * beats;
  const beat = Math.min(beats - 1, Math.max(0, Math.floor(position)));
  return { beat, beats, phase: Math.min(1, Math.max(0, position - beat)) };
}
