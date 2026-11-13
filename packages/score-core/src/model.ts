/**
 * The score model. Plain JSON-serialisable objects (no classes) so scores can be stored in
 * IndexedDB, sent to workers and updated immutably.
 *
 * Pitches are stored at CONCERT (sounding) pitch; written pitch for transposing instruments is
 * derived from the part's instrument. Durations are fractions of a whole note.
 */
import { durationValue, type Duration, type NoteType } from "./duration";
import { add, frac, sum, ZERO, type Fraction } from "./fraction";
import { newId } from "./ids";
import type { KeySignature, Pitch } from "./pitch";

export type Id = string;

export const SCORE_SCHEMA_VERSION = 1;

export interface Score {
  id: Id;
  schemaVersion: number;
  meta: ScoreMeta;
  /** Bar-level information shared by all parts. */
  measures: MeasureInfo[];
  parts: Part[];
}

export interface ScoreMeta {
  title: string;
  subtitle?: string;
  composer?: string;
  arranger?: string;
  lyricist?: string;
  copyright?: string;
}

export interface TimeSignature {
  beats: number;
  beatType: number;
  symbol?: "common" | "cut";
}

export interface Tempo {
  /** Beats per minute of `beatUnit`. */
  bpm: number;
  beatUnit: NoteType;
  beatUnitDots?: number;
  text?: string;
}

export type BarlineStyle = "regular" | "double" | "final" | "dashed" | "heavy";

export interface Ending {
  /** The numbers printed on the bracket, e.g. "1" or "1, 2". */
  number: string;
  /** Whether this bar starts and/or ends the bracket. */
  start: boolean;
  stop: boolean;
  /** The bracket has an open end (no downward hook). */
  open?: boolean;
}

export interface MeasureInfo {
  id: Id;
  /** Displayed bar number. */
  number: string;
  /** A pickup or otherwise incomplete bar that is allowed to be short. */
  implicit?: boolean;
  /** Present on the first bar and wherever the time signature changes. */
  time?: TimeSignature;
  /** Concert key; present on the first bar and wherever it changes. */
  key?: KeySignature;
  tempo?: Tempo;
  rehearsal?: string;
  barline?: BarlineStyle;
  repeatStart?: boolean;
  /** End repeat; `times` is how often the passage is played in total (default 2). */
  repeatEnd?: { times?: number };
  ending?: Ending;
}

export type ClefSign = "G" | "F" | "C" | "percussion";

export interface Clef {
  sign: ClefSign;
  line: number;
  /** -1 for "8vb" clefs (tenor voice, guitar), +1 for "8va". */
  octaveChange?: number;
}

export interface Part {
  id: Id;
  name: string;
  abbreviation?: string;
  /** Instrument catalog id, e.g. "trumpet-bb". */
  instrument: string;
  /** Number of staves (2 for piano). */
  staves: number;
  /** Clef at the start of each staff (index 0 = staff 1). */
  clefs: Clef[];
  /** One entry per score measure. */
  measures: PartMeasure[];
}

export interface PartMeasure {
  voices: Voice[];
  clefChanges?: ClefChange[];
  directions?: Direction[];
}

export interface ClefChange {
  staff: number;
  /** Position within the bar (whole notes from the barline). */
  offset: Fraction;
  clef: Clef;
}

export interface Voice {
  /** 1-based staff within the part. */
  staff: number;
  /** Voice number within the staff, starting at 1. */
  voice: number;
  events: MusicEvent[];
}

export type MusicEvent = NoteEvent | RestEvent;

export type Articulation =
  | "accent"
  | "marcato"
  | "staccato"
  | "staccatissimo"
  | "tenuto"
  | "fermata"
  | "trill"
  | "mordent"
  | "turn"
  | "breath";

export const ARTICULATIONS: readonly Articulation[] = [
  "accent",
  "marcato",
  "staccato",
  "staccatissimo",
  "tenuto",
  "fermata",
  "trill",
  "mordent",
  "turn",
  "breath",
];

export interface SlurMark {
  type: "start" | "stop";
  number?: number;
}

export interface NoteEvent {
  kind: "note";
  id: Id;
  duration: Duration;
  /** Chord tones, lowest first. A single note is a one-element chord. */
  notes: Note[];
  /** Grace notes take no time. */
  grace?: { slash?: boolean };
  articulations?: Articulation[];
  slurs?: SlurMark[];
}

export interface Note {
  id: Id;
  /** Concert (sounding) pitch. */
  pitch: Pitch;
  tie?: { start?: boolean; stop?: boolean };
}

export interface RestEvent {
  kind: "rest";
  id: Id;
  duration: Duration;
  /** A whole-bar rest, drawn centred regardless of the time signature. */
  measureRest?: boolean;
  /** Fills time without being printed (gaps in secondary voices). */
  hidden?: boolean;
}

export type Dynamic =
  | "ppp"
  | "pp"
  | "p"
  | "mp"
  | "mf"
  | "f"
  | "ff"
  | "fff"
  | "sf"
  | "sfz"
  | "sffz"
  | "fp"
  | "rf"
  | "rfz"
  | "fz";

export const DYNAMICS: readonly Dynamic[] = [
  "ppp",
  "pp",
  "p",
  "mp",
  "mf",
  "f",
  "ff",
  "fff",
  "sf",
  "sfz",
  "sffz",
  "fp",
  "rf",
  "rfz",
  "fz",
];

export type Direction =
  | { id: Id; kind: "dynamic"; staff: number; offset: Fraction; value: Dynamic }
  | { id: Id; kind: "words"; staff: number; offset: Fraction; text: string; placement?: "above" | "below" }
  | { id: Id; kind: "wedge"; staff: number; offset: Fraction; type: "crescendo" | "diminuendo" | "stop" };

// ---------------------------------------------------------------------------
// Construction helpers
// ---------------------------------------------------------------------------

/** A whole-bar rest. It is drawn as a whole rest whatever the time signature and lasts the whole bar. */
export function measureRest(id: Id = newId("e")): RestEvent {
  return { kind: "rest", id, duration: { type: "whole", dots: 0 }, measureRest: true };
}

export function emptyPartMeasure(staves: number): PartMeasure {
  const voices: Voice[] = [];
  for (let staff = 1; staff <= staves; staff++) {
    voices.push({ staff, voice: 1, events: [measureRest()] });
  }
  return { voices };
}

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

export function timeSignatureValue(time: TimeSignature): Fraction {
  return frac(time.beats, time.beatType);
}

/** The time signature in effect at each measure (defaults to 4/4 before the first one). */
export function timeSignatures(score: Score): TimeSignature[] {
  let current: TimeSignature = { beats: 4, beatType: 4 };
  return score.measures.map((m) => (current = m.time ?? current));
}

/** The concert key in effect at each measure (defaults to C major). */
export function concertKeys(score: Score): KeySignature[] {
  let current: KeySignature = { fifths: 0, mode: "major" };
  return score.measures.map((m) => (current = m.key ?? current));
}

/** Nominal length of each measure according to its time signature. */
export function measureLengths(score: Score): Fraction[] {
  return timeSignatures(score).map(timeSignatureValue);
}

/** The time an event takes: zero for grace notes, the bar length for whole-bar rests. */
export function eventValue(event: MusicEvent, measureLength: Fraction): Fraction {
  if (event.kind === "note" && event.grace) return ZERO;
  if (event.kind === "rest" && event.measureRest) return measureLength;
  return durationValue(event.duration);
}

export function voiceLength(voice: Voice, measureLength: Fraction): Fraction {
  return sum(voice.events.map((e) => eventValue(e, measureLength)));
}

/** Onsets of each event within a voice. */
export function eventOnsets(voice: Voice, measureLength: Fraction): Fraction[] {
  const onsets: Fraction[] = [];
  let t = ZERO;
  for (const e of voice.events) {
    onsets.push(t);
    t = add(t, eventValue(e, measureLength));
  }
  return onsets;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

export interface EventLocation {
  partIndex: number;
  measureIndex: number;
  voiceIndex: number;
  eventIndex: number;
  /** Set when the id was a chord tone. */
  noteIndex?: number;
}

/** Find an event (or a chord tone inside it) by id. */
export function locate(score: Score, id: Id): EventLocation | undefined {
  for (let p = 0; p < score.parts.length; p++) {
    const part = score.parts[p]!;
    for (let m = 0; m < part.measures.length; m++) {
      const voices = part.measures[m]!.voices;
      for (let v = 0; v < voices.length; v++) {
        const events = voices[v]!.events;
        for (let e = 0; e < events.length; e++) {
          const ev = events[e]!;
          if (ev.id === id) return { partIndex: p, measureIndex: m, voiceIndex: v, eventIndex: e };
          if (ev.kind === "note") {
            const n = ev.notes.findIndex((note) => note.id === id);
            if (n >= 0) return { partIndex: p, measureIndex: m, voiceIndex: v, eventIndex: e, noteIndex: n };
          }
        }
      }
    }
  }
  return undefined;
}

export function* allEvents(
  score: Score,
): Generator<{ part: Part; partIndex: number; measureIndex: number; voice: Voice; event: MusicEvent }> {
  for (let p = 0; p < score.parts.length; p++) {
    const part = score.parts[p]!;
    for (let m = 0; m < part.measures.length; m++) {
      for (const voice of part.measures[m]!.voices) {
        for (const event of voice.events) yield { part, partIndex: p, measureIndex: m, voice, event };
      }
    }
  }
}

export function measureIsEmpty(pm: PartMeasure | undefined): boolean {
  if (!pm) return true;
  return pm.voices.every((v) => v.events.every((e) => e.kind === "rest"));
}

/**
 * Whether something printed at the start of a bar ends a multi-bar rest before it: a key or time
 * signature, rehearsal mark, tempo, start repeat or the start of a volta.
 */
export function breaksRestBefore(info: MeasureInfo): boolean {
  return !!(info.key || info.time || info.rehearsal || info.tempo || info.repeatStart || info.ending?.start);
}

/**
 * Whether something printed at the end of a bar ends a multi-bar rest after it: an end repeat, a
 * double, final or other special barline, or the end of a volta.
 */
export function breaksRestAfter(info: MeasureInfo): boolean {
  return !!(info.repeatEnd || (info.barline && info.barline !== "regular") || info.ending?.stop);
}

/**
 * A multi-bar rest that ended at bar `from` now ends at bar `to` (bars were added after it, or are
 * about to be removed from its end): what is printed at its end moves along (the barline, an end
 * repeat, the end of a volta), and a volta over it covers the bars in between.
 */
export function moveRestEnd(measures: MeasureInfo[], from: number, to: number): void {
  const source = measures[from];
  const target = measures[to];
  if (!source || !target || from === to) return;
  if (source.barline) {
    target.barline = source.barline;
    delete source.barline;
  }
  if (source.repeatEnd) {
    target.repeatEnd = source.repeatEnd;
    delete source.repeatEnd;
  }
  const ending = source.ending;
  if (!ending) return;
  for (let m = from + 1; m <= to; m++) measures[m]!.ending ??= { number: ending.number, start: false, stop: false };
  if (!target.ending) return;
  target.ending.stop = ending.stop;
  if (ending.open) target.ending.open = true;
  ending.stop = false;
  delete ending.open;
}

/** Renumber bars 1, 2, 3 … skipping a pickup bar at the start (which becomes bar 0). */
export function renumberMeasures(score: Score): void {
  let n = score.measures[0]?.implicit ? 0 : 1;
  for (const m of score.measures) m.number = String(n++);
}
