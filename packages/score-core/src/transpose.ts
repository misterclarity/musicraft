import { produce } from "immer";
import { getInstrument, type InstrumentDef } from "./instruments";
import { concertKeys, emptyPartMeasure, type Id, type Part, type Score } from "./model";
import {
  addIntervals,
  intervalFifths,
  isUnison,
  keyAlterations,
  negateInterval,
  STEPS,
  stepIndex,
  transposeKey,
  transposePitch,
  type Interval,
  type KeySignature,
  type Pitch,
} from "./pitch";

/** How a part's notes are written in one measure: the written key and the interval concert → written. */
export interface WrittenContext {
  key: KeySignature;
  interval: Interval;
}

export function concertToWritten(instrument: InstrumentDef): Interval {
  return negateInterval(instrument.transposition);
}

/** Written key and spelling interval for every measure of a part. */
export function writtenContexts(score: Score, part: Part): WrittenContext[] {
  const toWritten = concertToWritten(getInstrument(part.instrument));
  return concertKeys(score).map((key) => (isUnison(toWritten) ? { key, interval: toWritten } : transposeKey(key, toWritten)));
}

export function toWrittenPitch(concert: Pitch, ctx: WrittenContext): Pitch {
  return transposePitch(concert, ctx.interval);
}

/** Convert a written key of a transposing instrument to the concert key and the interval for its notes. */
export function writtenKeyToConcert(written: KeySignature, instrument: InstrumentDef): WrittenContext {
  return transposeKey(written, instrument.transposition);
}

export interface TransposeOptions {
  /** Parts to transpose; all when omitted. */
  partIds?: Id[];
  /** First and last measure index (inclusive); the whole score when omitted. */
  from?: number;
  to?: number;
}

function inScope(score: Score, opts: TransposeOptions) {
  const from = opts.from ?? 0;
  const to = opts.to ?? score.measures.length - 1;
  const parts = new Set(opts.partIds ?? score.parts.map((p) => p.id));
  const whole = from === 0 && to === score.measures.length - 1 && parts.size === score.parts.length;
  return { from, to, parts, whole };
}

/**
 * Transpose the sounding pitch by an interval. When the whole score is transposed, key signatures
 * move too and extreme keys are respelled (C# major → Db major). When only some parts or bars move by
 * something other than octaves, the key signatures stay and notes get accidentals.
 */
export function transposeScore(score: Score, interval: Interval, opts: TransposeOptions = {}): Score {
  if (isUnison(interval)) return score;
  const scope = inScope(score, opts);
  const octavesOnly = intervalFifths(interval) === 0;
  const moveKeys = scope.whole && !octavesOnly;
  const keys = concertKeys(score);
  const perMeasure = keys.map((key) => (moveKeys ? transposeKey(key, interval) : { key, interval }));

  return produce(score, (draft) => {
    if (moveKeys) {
      draft.measures.forEach((m, i) => {
        if (m.key) m.key = perMeasure[i]!.key;
      });
    }
    for (const part of draft.parts) {
      if (!scope.parts.has(part.id)) continue;
      for (let m = scope.from; m <= scope.to; m++) {
        const iv = perMeasure[m]!.interval;
        for (const voice of part.measures[m]?.voices ?? []) {
          for (const event of voice.events) {
            if (event.kind !== "note") continue;
            for (const note of event.notes) note.pitch = transposePitch(note.pitch, iv);
          }
        }
      }
    }
  });
}

/** Shift notes by whole octaves (positive = up). */
export function shiftOctaves(score: Score, octaves: number, opts: TransposeOptions & { staff?: number } = {}): Score {
  if (octaves === 0) return score;
  const scope = inScope(score, opts);
  const iv: Interval = { diatonic: 7 * octaves, chromatic: 12 * octaves };
  return produce(score, (draft) => {
    for (const part of draft.parts) {
      if (!scope.parts.has(part.id)) continue;
      for (let m = scope.from; m <= scope.to; m++) {
        for (const voice of part.measures[m]?.voices ?? []) {
          if (opts.staff && voice.staff !== opts.staff) continue;
          for (const event of voice.events) {
            if (event.kind !== "note") continue;
            for (const note of event.notes) note.pitch = transposePitch(note.pitch, iv);
          }
        }
      }
    }
  });
}

/**
 * Move notes by letter-name steps within the key (a "diatonic" transposition): in C major a third
 * up turns C-D-E into E-F-G. Accidentals that differ from the key are kept relative to it.
 */
export function transposeDiatonic(score: Score, steps: number, opts: TransposeOptions = {}): Score {
  if (steps === 0) return score;
  const scope = inScope(score, opts);
  const keys = concertKeys(score);
  return produce(score, (draft) => {
    for (const part of draft.parts) {
      if (!scope.parts.has(part.id)) continue;
      for (let m = scope.from; m <= scope.to; m++) {
        const alterations = keyAlterations(keys[m]!.fifths);
        for (const voice of part.measures[m]?.voices ?? []) {
          for (const event of voice.events) {
            if (event.kind !== "note") continue;
            for (const note of event.notes) {
              const p = note.pitch;
              const deviation = p.alter - alterations[p.step];
              const target = p.octave * 7 + stepIndex(p.step) + steps;
              const step = STEPS[((target % 7) + 7) % 7]!;
              note.pitch = { step, octave: Math.floor(target / 7), alter: alterations[step] + deviation };
            }
          }
        }
      }
    }
  });
}

export type InstrumentChangeMode =
  /** The music sounds the same; written notes are recomputed (e.g. Bb trumpet part → C trumpet part). */
  | "keep-sounding"
  /** The written notes stay; the sound changes (e.g. the part was really for a Bb instrument). */
  | "keep-written";

export interface ChangeInstrumentOptions {
  mode?: InstrumentChangeMode;
  /** New part name; by default the part is renamed when it still had its old instrument's name. */
  name?: string;
}

export function changeInstrument(
  score: Score,
  partId: Id,
  instrumentId: string,
  opts: ChangeInstrumentOptions = {},
): Score {
  const partIndex = score.parts.findIndex((p) => p.id === partId);
  if (partIndex < 0) throw new Error(`No part with id ${partId}`);
  const oldPart = score.parts[partIndex]!;
  const oldInstrument = getInstrument(oldPart.instrument);
  const newInstrument = getInstrument(instrumentId);
  const mode = opts.mode ?? "keep-sounding";

  let result = score;
  if (mode === "keep-written") {
    // concert_new = written + new transposition = concert_old - old transposition + new transposition
    const delta = addIntervals(newInstrument.transposition, negateInterval(oldInstrument.transposition));
    if (!isUnison(delta)) {
      // With a single part the key signatures belong to it, so they move as well.
      result = transposeScore(result, delta, score.parts.length === 1 ? {} : { partIds: [partId] });
    }
  }

  return produce(result, (draft) => {
    const part = draft.parts[partIndex]!;
    part.instrument = newInstrument.id;
    if (opts.name) part.name = opts.name;
    else if (part.name === oldInstrument.name || part.name.trim() === "") part.name = newInstrument.name;
    part.abbreviation = newInstrument.abbreviation;
    if (newInstrument.staves !== part.staves) {
      setStaffCount(part, newInstrument.staves);
    }
    part.clefs = newInstrument.clefs.map((c) => ({ ...c }));
    // Clef changes inside the part were chosen for the old instrument's range; drop clashing ones.
    for (const pm of part.measures) {
      if (pm.clefChanges) {
        pm.clefChanges = pm.clefChanges.filter((c) => c.staff <= part.staves);
        if (pm.clefChanges.length === 0) delete pm.clefChanges;
      }
    }
  });
}

/** Change the number of staves of a part. Content of removed staves moves to the last remaining staff. */
export function setStaffCount(part: Part, staves: number): void {
  if (staves === part.staves) return;
  if (staves > part.staves) {
    for (const pm of part.measures) {
      for (let s = part.staves + 1; s <= staves; s++) {
        pm.voices.push(...emptyPartMeasure(1).voices.map((v) => ({ ...v, staff: s })));
      }
    }
  } else {
    for (const pm of part.measures) {
      const kept = pm.voices.filter((v) => v.staff <= staves);
      const moved = pm.voices
        .filter((v) => v.staff > staves && v.events.some((e) => e.kind === "note"))
        .map((v) => ({ ...v, staff: staves }));
      // Give moved voices free voice numbers on their new staff.
      let next = Math.max(0, ...kept.filter((v) => v.staff === staves).map((v) => v.voice)) + 1;
      for (const v of moved) v.voice = next++;
      pm.voices = [...kept, ...moved];
      pm.directions = pm.directions?.map((d) => (d.staff > staves ? { ...d, staff: staves } : d));
    }
  }
  part.staves = staves;
}
