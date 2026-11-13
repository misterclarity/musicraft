/** Helpers for scores that came from optical music recognition. */
import { produce } from "immer";
import { add, cmp, frac, gt, isZero, mul, ZERO, type Fraction } from "./fraction";
import { getInstrument, type InstrumentDef } from "./instruments";
import {
  concertKeys,
  emptyPartMeasure,
  eventValue,
  measureLengths,
  renumberMeasures,
  timeSignatures,
  timeSignatureValue,
  voiceLength,
  type Clef,
  type MeasureInfo,
  type NoteEvent,
  type Part,
  type Score,
  type TimeSignature,
} from "./model";
import { diatonicNumber, keyAlterations, negateInterval, samePitch, STEPS, transposePitch, type KeySignature } from "./pitch";
import { setStaffCount, writtenContexts } from "./transpose";

const sameTime = (a: MeasureInfo["time"], b: MeasureInfo["time"]) => !!a && !!b && a.beats === b.beats && a.beatType === b.beatType;
const sameKey = (a: MeasureInfo["key"], b: MeasureInfo["key"]) => !!a && !!b && a.fifths === b.fifths;

export interface MergedScore {
  score: Score;
  /** First and last measure index of each input score in the result. */
  ranges: [number, number][];
}

/**
 * Join scores recognised from consecutive pages into one. Parts are matched by position; time and
 * key signatures that merely repeat the previous page's are dropped.
 */
export function mergeScores(scores: Score[]): MergedScore {
  if (scores.length === 0) throw new Error("Nothing to merge.");
  const ranges: [number, number][] = [];
  const merged = produce(scores[0]!, (draft) => {
    ranges.push([0, draft.measures.length - 1]);
    let time = draft.measures.find((m) => m.time)?.time;
    let key = draft.measures.find((m) => m.key)?.key;
    for (const m of draft.measures) {
      time = m.time ?? time;
      key = m.key ?? key;
    }
    for (const next of scores.slice(1)) {
      const offset = draft.measures.length;
      for (const info of next.measures) {
        const copy: MeasureInfo = { ...info };
        if (copy.time && sameTime(copy.time, time)) delete copy.time;
        if (copy.key && sameKey(copy.key, key)) delete copy.key;
        time = copy.time ?? time;
        key = copy.key ?? key;
        draft.measures.push(copy);
      }
      const partCount = Math.max(draft.parts.length, next.parts.length);
      for (let p = 0; p < partCount; p++) {
        const incoming = next.parts[p];
        let target = draft.parts[p] as Part | undefined;
        if (!target && incoming) {
          // A part that first appears on this page: empty bars for the earlier pages, then its music.
          target = { ...incoming, measures: Array.from({ length: offset }, () => emptyPartMeasure(incoming.staves)) };
          draft.parts.push(target);
        }
        if (!target) continue;
        if (incoming && incoming.staves > target.staves) setStaffCount(target, incoming.staves);
        const measures = incoming?.measures ?? next.measures.map(() => emptyPartMeasure(target!.staves));
        for (const pm of measures) target.measures.push(pm);
      }
      ranges.push([offset, draft.measures.length - 1]);
    }
    if (draft.meta.title === "Untitled" || !draft.meta.title) {
      const titled = scores.find((s) => s.meta.title && s.meta.title !== "Untitled");
      if (titled) draft.meta.title = titled.meta.title;
    }
    renumberMeasures(draft);
  });
  return { score: merged, ranges };
}

/** Mark a short first bar as a pickup (upbeat) when every part agrees on its length. */
export function markPickup(score: Score): Score {
  const lengths = measureLengths(score);
  const first = lengths[0];
  if (!first || score.measures[0]?.implicit) return score;
  let common: Fraction | undefined;
  for (const part of score.parts) {
    const pm = part.measures[0];
    if (!pm) return score;
    let longest = ZERO;
    for (const voice of pm.voices) {
      const len = voiceLength(voice, first);
      if (cmp(len, longest) > 0) longest = len;
    }
    if (cmp(longest, ZERO) === 0 || cmp(longest, first) >= 0) return score;
    if (common && cmp(common, longest) !== 0) return score;
    common = longest;
  }
  return produce(score, (draft) => {
    draft.measures[0]!.implicit = true;
    renumberMeasures(draft);
  });
}

/** Fix habits of recognition engines: a slur between two identical notes is really a tie. */
export function cleanupRecognized(score: Score): Score {
  return produce(score, (draft) => {
    for (const part of draft.parts) {
      const lastNote = new Map<string, NoteEvent>();
      for (const pm of part.measures) {
        for (const voice of pm.voices) {
          const key = `${voice.staff}/${voice.voice}`;
          for (const event of voice.events) {
            if (event.kind !== "note" || event.grace) continue;
            const previous = lastNote.get(key);
            if (
              previous &&
              previous.slurs?.some((s) => s.type === "start") &&
              event.slurs?.some((s) => s.type === "stop") &&
              previous.notes.length === event.notes.length &&
              previous.notes.every((n, i) => samePitch(n.pitch, event.notes[i]!.pitch))
            ) {
              previous.slurs = previous.slurs.filter((s) => s.type !== "start");
              event.slurs = event.slurs.filter((s) => s.type !== "stop");
              if (!previous.slurs.length) delete previous.slurs;
              if (!event.slurs.length) delete event.slurs;
              previous.notes.forEach((n) => (n.tie = { ...n.tie, start: true }));
              event.notes.forEach((n) => (n.tie = { ...n.tie, stop: true }));
            }
            lastNote.set(key, event);
          }
        }
      }
    }
  });
}

/** What repairRecognized changed: the repaired score and a sentence per change for the user. */
export interface RecognitionRepair {
  score: Score;
  notes: string[];
}

/**
 * Fix what recognition engines get wrong in ways the music itself gives away: slurs that are ties,
 * misread time signatures, clefs an instrument never uses, a tempo mark taken for the title.
 */
export function repairRecognized(score: Score): RecognitionRepair {
  const notes: string[] = [];
  let repaired = fillBarRests(cleanupRecognized(score));
  const title = repaired.meta.title;
  if (!plausibleTitle(title)) {
    if (title && title !== "Untitled") {
      notes.push(`"${title}" is not a title${/=\s*\d/.test(title) ? " (it looks like the tempo mark)" : ""}, so it was dropped.`);
    }
    repaired = produce(repaired, (draft) => {
      draft.meta.title = "Untitled";
    });
  }
  for (const step of [repairClefs, inferTimeSignatures]) {
    const result = step(repaired);
    repaired = result.score;
    notes.push(...result.notes);
  }
  return { score: repaired, notes };
}

/**
 * How well a recognised score holds together, to choose between two readings of a page: bars with
 * notes, and how many of them add up to their time signature in every voice.
 */
export function readingQuality(score: Score): { fitting: number; withNotes: number } {
  const lengths = measureLengths(score);
  let fitting = 0;
  let withNotes = 0;
  score.measures.forEach((_, m) => {
    const voices = score.parts.flatMap((part) => part.measures[m]?.voices ?? []);
    if (!voices.some((v) => v.events.some((e) => e.kind === "note"))) return;
    withNotes++;
    if (voices.every((v) => cmp(voiceLength(v, lengths[m]!), lengths[m]!) === 0)) fitting++;
  });
  return { fitting, withNotes };
}

/** Whether recognised text can be a title: not a tempo mark such as "(♩=112)", a number or stray signs. */
export function plausibleTitle(title: string | undefined): boolean {
  const text = (title ?? "").trim();
  if (!text || text === "Untitled") return false;
  if (/=\s*\d/.test(text)) return false;
  // One Chinese, Japanese or Korean character can be a word; one Latin letter is more likely a stray mark.
  if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(text)) return true;
  return text.replace(/[^\p{L}]/gu, "").length >= 2;
}

/** A whole rest alone in a bar rests for the whole bar, whatever the time signature (3/4, 12/8 …). */
function fillBarRests(score: Score): Score {
  const lengths = measureLengths(score);
  return produce(score, (draft) => {
    for (const part of draft.parts) {
      part.measures.forEach((pm, m) => {
        // In 4/2 and longer bars a whole rest is only part of the bar.
        if (cmp(lengths[m]!, frac(2)) >= 0) return;
        for (const voice of pm.voices) {
          const only = voice.events.length === 1 ? voice.events[0]! : undefined;
          if (only?.kind === "rest" && !only.measureRest && only.duration.type === "whole" && !only.duration.dots && !only.duration.tuplet) {
            only.measureRest = true;
          }
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Time signatures

const sameTimeSignature = (a: TimeSignature, b: TimeSignature) => a.beats === b.beats && a.beatType === b.beatType;
const fractionKey = (f: Fraction) => `${f.n}/${f.d}`;

/**
 * Stretches of bars that should share a time signature as far as the printed signs tell: a new one
 * starts at every time signature, key change, double or final barline and repeat sign.
 */
function timeSections(score: Score): { from: number; to: number }[] {
  const keys = concertKeys(score);
  const sections: { from: number; to: number }[] = [];
  let from = 0;
  for (let m = 1; m < score.measures.length; m++) {
    const info = score.measures[m]!;
    const before = score.measures[m - 1]!;
    const boundary =
      !!info.time ||
      keys[m]!.fifths !== keys[m - 1]!.fifths ||
      !!info.repeatStart ||
      !!before.repeatEnd ||
      (!!before.barline && before.barline !== "regular" && before.barline !== "dashed");
    if (boundary) {
      sections.push({ from, to: m - 1 });
      from = m;
    }
  }
  sections.push({ from, to: score.measures.length - 1 });
  return sections;
}

/** How long the music in a bar is: its longest voice, not counting whole-bar rests (they fit any bar). */
function contentLength(score: Score, m: number, nominal: Fraction): Fraction | undefined {
  let longest: Fraction | undefined;
  for (const part of score.parts) {
    for (const voice of part.measures[m]?.voices ?? []) {
      if (voice.events.every((e) => e.kind === "rest" && (e.measureRest || e.hidden))) continue;
      const length = voiceLength(voice, nominal);
      if (!longest || gt(length, longest)) longest = length;
    }
  }
  return longest && !isZero(longest) ? longest : undefined;
}

/**
 * Whether bars group their eighths in threes (6/8, 12/8) rather than twos (3/4, 6/4): notes that
 * start a third of the way into a pair of beats, and dotted quarters and halves on those beats.
 */
function compoundVotes(score: Score, bars: number[], length: Fraction): { compound: number; simple: number } {
  let compound = 0;
  let simple = 0;
  for (const m of bars) {
    for (const part of score.parts) {
      for (const voice of part.measures[m]?.voices ?? []) {
        let time = ZERO;
        for (const event of voice.events) {
          const value = eventValue(event, length);
          if (isZero(value)) continue;
          const eighths = mul(time, frac(8));
          time = add(time, value);
          if (eighths.d !== 1 || (event.kind === "rest" && (event.measureRest || event.hidden))) continue;
          const at = eighths.n;
          const { type, dots, tuplet } = event.duration;
          const dottedBeat = dots === 1 && !tuplet && (type === "quarter" || type === "half");
          if (at % 3 === 0 && (dottedBeat || at % 2 === 1)) compound++;
          else if (at % 2 === 0 && at % 3 !== 0) simple++;
        }
      }
    }
  }
  return { compound, simple };
}

/** The time signature for bars of a given length, preferring compound time when the rhythm groups in threes. */
function timeForLength(length: Fraction, votes: { compound: number; simple: number }, stated: TimeSignature): TimeSignature | undefined {
  const count = (unit: number) => {
    const n = mul(length, frac(unit));
    return n.d === 1 ? n.n : undefined;
  };
  const eighths = count(8);
  if (eighths !== undefined && eighths >= 6 && eighths % 3 === 0) {
    // 12/8 is far more common than 6/4 or 3/2; 3/4 more common than 6/8.
    const compound = votes.compound > votes.simple || (eighths === 12 && votes.compound === votes.simple);
    if (compound) return { beats: eighths, beatType: 8 };
  }
  const halves = count(2);
  if (stated.beatType === 2 && halves !== undefined && halves >= 2) return { beats: halves, beatType: 2 };
  const quarters = count(4);
  if (quarters !== undefined) return { beats: quarters, beatType: 4 };
  if (eighths !== undefined) return { beats: eighths, beatType: 8 };
  const sixteenths = count(16);
  return sixteenths !== undefined ? { beats: sixteenths, beatType: 16 } : undefined;
}

/** The time signature most bars of a section add up to, when that is not the one it has. */
function inferSectionTime(score: Score, section: { from: number; to: number }, stated: TimeSignature): TimeSignature | undefined {
  const nominal = timeSignatureValue(stated);
  const byLength = new Map<string, { length: Fraction; bars: number[] }>();
  let evidence = 0;
  for (let m = section.from; m <= section.to; m++) {
    if (score.measures[m]!.implicit) continue;
    const length = contentLength(score, m, nominal);
    if (!length) continue;
    evidence++;
    const entry = byLength.get(fractionKey(length)) ?? { length, bars: [] };
    entry.bars.push(m);
    byLength.set(fractionKey(length), entry);
  }
  const top = [...byLength.values()].sort((a, b) => b.bars.length - a.bars.length)[0];
  if (!top || cmp(top.length, nominal) === 0) return undefined;
  // Only real time signatures: a quarter note to two whole notes long.
  if (cmp(top.length, frac(1, 4)) < 0 || cmp(top.length, frac(2)) > 0) return undefined;
  const agreeing = top.bars.length;
  const fitting = byLength.get(fractionKey(nominal))?.bars.length ?? 0;
  // At least three bars and most of them must agree, clearly more than fit the printed time
  // signature: two bars that miss the same beat are more likely misread than in another metre.
  if (agreeing < 3 || agreeing * 2 < evidence || agreeing < fitting * 2) return undefined;
  const time = timeForLength(top.length, compoundVotes(score, top.bars, top.length), stated);
  return time && time.beats <= 16 ? time : undefined;
}

/**
 * Recognition engines misread time signatures (homr reads 12/8 as 2/2) while reading the notes
 * right: then almost every bar of the section seems too long or too short. Where most bars of a
 * section agree on another length, give the section a time signature of that length.
 */
export function inferTimeSignatures(score: Score): RecognitionRepair {
  if (!score.measures.length) return { score, notes: [] };
  const times = timeSignatures(score);
  const changes: { from: number; to: number; time: TimeSignature; was: TimeSignature }[] = [];
  for (const section of timeSections(score)) {
    const time = inferSectionTime(score, section, times[section.from]!);
    if (time) changes.push({ ...section, time, was: times[section.from]! });
  }
  if (!changes.length) return { score, notes: [] };
  const repaired = produce(score, (draft) => {
    const touched = new Set<number>();
    for (const change of changes) {
      draft.measures[change.from]!.time = change.time;
      touched.add(change.from);
      // The bars after the section keep the time signature they had.
      const after = draft.measures[change.to + 1];
      if (after && !after.time) {
        after.time = times[change.to + 1]!;
        touched.add(change.to + 1);
      }
    }
    // Drop the signs this left repeating the time signature already in force.
    let current: TimeSignature | undefined;
    draft.measures.forEach((m, i) => {
      if (i > 0 && m.time && current && touched.has(i) && sameTimeSignature(m.time, current)) delete m.time;
      current = m.time ?? current;
    });
  });
  const label = (m: number) => score.measures[m]!.number;
  const notes = changes.map((c) => {
    const bars = c.from === c.to ? `Bar ${label(c.from)} adds` : `Bars ${label(c.from)}–${label(c.to)} add`;
    return `${bars} up to ${c.time.beats}/${c.time.beatType}, not ${c.was.beats}/${c.was.beatType}: the time signature was corrected.`;
  });
  return { score: repaired, notes };
}

// ---------------------------------------------------------------------------------------------
// Clefs

/** The one clef an instrument's music uses, if it never changes clef (trumpets, clarinets, saxophones …). */
function onlyClef(instrument: InstrumentDef): Clef | undefined {
  const clef = instrument.clefs[0];
  if (instrument.staves !== 1 || !clef || clef.sign !== "G" || clef.octaveChange) return undefined;
  if (instrument.family !== "brass" && instrument.family !== "woodwind" && instrument.family !== "strings") return undefined;
  // Horn and bass clarinet parts do switch to the bass clef.
  if (instrument.id === "horn-f" || instrument.id === "bass-clarinet") return undefined;
  return clef;
}

const sameClef = (a: Clef, b: Clef) => a.sign === b.sign && a.line === b.line && (a.octaveChange ?? 0) === (b.octaveChange ?? 0);

/** The note on the middle line of the staff (diatonic number): B4 in the treble clef, D3 in the bass clef. */
function middleLine(clef: Clef): number {
  const reference = clef.sign === "G" ? 32 : clef.sign === "F" ? 24 : 28; // G4, F3, C4 on the clef's line
  return reference + (3 - clef.line) * 2 + 7 * (clef.octaveChange ?? 0);
}

/**
 * Recognition sometimes reads a bass clef (or another clef) in the part of an instrument that only
 * ever uses the treble clef, and reads the notes after it in that clef. Remove such clefs and read
 * those notes in the treble clef again; accidentals that differ from the key stay as they are.
 */
export function repairClefs(score: Score): RecognitionRepair {
  const notes: string[] = [];
  const repaired = produce(score, (draft) => {
    draft.parts.forEach((part, p) => {
      const instrument = getInstrument(part.instrument);
      const clef = onlyClef(instrument);
      if (!clef) return;
      const contexts = writtenContexts(score, score.parts[p]!);
      // Where each clef applies: [measure, offset) spans in reading order.
      const changes = part.measures.flatMap((pm, m) => (pm.clefChanges ?? []).filter((c) => c.staff === 1).map((c) => ({ m, change: c })));
      changes.sort((a, b) => a.m - b.m || cmp(a.change.offset, b.change.offset));
      const spans: { clef: Clef; from: { m: number; offset: Fraction }; to?: { m: number; offset: Fraction } }[] = [];
      let current = { clef: part.clefs[0] ?? clef, from: { m: 0, offset: ZERO } };
      for (const { m, change } of changes) {
        spans.push({ ...current, to: { m, offset: change.offset } });
        current = { clef: change.clef, from: { m, offset: change.offset } };
      }
      spans.push(current);
      const wrong = spans.filter((s) => !sameClef(s.clef, clef));
      if (!wrong.length && !changes.length) return;
      // If most of the part is in another clef, the instrument was probably chosen wrongly: leave it.
      // The last bar a clef applies to: a clef change at the start of a bar ends it in the bar before.
      const lastBar = (s: (typeof spans)[number]) => (!s.to ? part.measures.length - 1 : isZero(s.to.offset) ? s.to.m - 1 : s.to.m);
      const barsIn = (s: (typeof spans)[number]) => lastBar(s) - s.from.m + 1;
      if (wrong.reduce((n, s) => n + barsIn(s), 0) * 2 > part.measures.length) return;
      const before = (m: number, offset: Fraction, edge: { m: number; offset: Fraction }) => m < edge.m || (m === edge.m && cmp(offset, edge.offset) < 0);
      const lengths = measureLengths(score);
      for (const span of wrong) {
        const shift = middleLine(clef) - middleLine(span.clef);
        const last = lastBar(span);
        for (let m = span.from.m; m <= last; m++) {
          const ctx = contexts[m]!;
          const keyAlter = keyAlterations(ctx.key.fifths);
          for (const voice of part.measures[m]!.voices) {
            if (voice.staff !== 1) continue;
            let time = ZERO;
            for (const event of voice.events) {
              const at = time;
              time = add(time, eventValue(event, lengths[m]!));
              if (event.kind !== "note" || before(m, at, span.from) || (span.to && !before(m, at, span.to))) continue;
              for (const note of event.notes) {
                const written = transposePitch(note.pitch, ctx.interval);
                const diatonic = diatonicNumber(written) + shift;
                const step = STEPS[((diatonic % 7) + 7) % 7]!;
                // A note that follows the key signature still does on its new line; a printed accidental stays.
                const alter = written.alter === keyAlter[written.step] ? keyAlter[step] : written.alter;
                const moved = { step, alter, octave: Math.floor(diatonic / 7) };
                note.pitch = transposePitch(moved, negateInterval(ctx.interval));
              }
            }
          }
        }
        const from = score.measures[span.from.m]!.number;
        const to = score.measures[last]!.number;
        const bars = from === to ? `Bar ${from}` : `Bars ${from}–${to}`;
        notes.push(`${bars}: the ${clefName(span.clef)} read in this ${instrument.name} part was removed and its notes read in the ${clefName(clef)}.`);
      }
      part.clefs[0] = clef;
      for (const pm of part.measures) {
        if (!pm.clefChanges) continue;
        pm.clefChanges = pm.clefChanges.filter((c) => c.staff !== 1);
        if (!pm.clefChanges.length) delete pm.clefChanges;
      }
    });
  });
  return { score: repaired, notes };
}

function clefName(clef: Clef): string {
  if (clef.sign === "G") return "treble clef";
  if (clef.sign === "F") return clef.line === 3 ? "baritone clef" : "bass clef";
  if (clef.sign === "C") return clef.line === 3 ? "alto clef" : clef.line === 4 ? "tenor clef" : "C clef";
  return "percussion clef";
}

// ---------------------------------------------------------------------------------------------
// Key signatures

/**
 * Put a key signature that recognition missed or misread at a bar, up to the next key signature.
 * Recognition spelled the notes by the key it saw, so notes that followed that key follow the new
 * one (an E read as E natural under a missed three-flat signature becomes E flat); notes with
 * printed accidentals, which differ from the old key, stay as they are.
 */
export function correctKeySignature(score: Score, measureIndex: number, key: KeySignature): Score {
  if (!score.measures[measureIndex]) return score;
  let end = measureIndex + 1;
  while (end < score.measures.length && !score.measures[end]!.key) end++;
  const before = score.parts.map((part) => writtenContexts(score, part));
  const keyed = produce(score, (draft) => {
    draft.measures[measureIndex]!.key = key;
  });
  const after = keyed.parts.map((part) => writtenContexts(keyed, part));
  return produce(keyed, (draft) => {
    draft.parts.forEach((part, p) => {
      for (let m = measureIndex; m < end; m++) {
        const was = before[p]![m]!;
        const now = after[p]![m]!;
        const oldAlter = keyAlterations(was.key.fifths);
        const newAlter = keyAlterations(now.key.fifths);
        for (const voice of part.measures[m]!.voices) {
          for (const event of voice.events) {
            if (event.kind !== "note") continue;
            for (const note of event.notes) {
              const written = transposePitch(note.pitch, was.interval);
              if (written.alter !== oldAlter[written.step]) continue;
              note.pitch = transposePitch({ ...written, alter: newAlter[written.step] }, negateInterval(now.interval));
            }
          }
        }
      }
    });
  });
}
