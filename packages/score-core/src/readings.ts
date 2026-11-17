/**
 * Two recognition engines read the same page: combining their readings line by line, finding the
 * bars where they disagree, and measuring how well a scan was read once it has been corrected.
 */
import { cmp, toNumber, ZERO } from "./fraction";
import {
  concertKeys,
  eventOnsets,
  eventValue,
  measureLengths,
  renumberMeasures,
  timeSignatures,
  voiceLength,
  type Clef,
  type MeasureInfo,
  type Part,
  type PartMeasure,
  type Score,
} from "./model";
import { correctKeySignature } from "./omr";
import { midiNumber } from "./pitch";
import { writtenContexts } from "./transpose";

/** One engine's reading of a page, as imported. */
export interface PageReading {
  score: Score;
  /** Bar indexes where each line of music starts. */
  systemStarts: number[];
}

/** The bars of each line of a reading: [first, end) bar indexes. */
export function readingLines(reading: PageReading): [number, number][] {
  const count = reading.score.measures.length;
  const starts = [...new Set([0, ...reading.systemStarts])].filter((s) => s >= 0 && s < count).sort((a, b) => a - b);
  return starts.map((start, i) => [start, starts[i + 1] ?? count]);
}

/** Bars from `from` up to `to` (not included) that have notes, and how many of them add up in every voice. */
export function lineQuality(score: Score, from: number, to: number): { fitting: number; withNotes: number } {
  const lengths = measureLengths(score);
  let fitting = 0;
  let withNotes = 0;
  for (let m = from; m < to; m++) {
    const voices = score.parts.flatMap((part) => part.measures[m]?.voices ?? []);
    if (!voices.some((v) => v.events.some((e) => e.kind === "note"))) continue;
    withNotes++;
    if (voices.every((v) => cmp(voiceLength(v, lengths[m]!), lengths[m]!) === 0)) fitting++;
  }
  return { fitting, withNotes };
}

/** Whether two readings can be combined line by line: the same lines, and the same staves. */
export function canCombine(a: PageReading, b: PageReading): boolean {
  if (readingLines(a).length !== readingLines(b).length) return false;
  if (a.score.parts.length !== b.score.parts.length) return false;
  return a.score.parts.every((part, i) => part.staves === b.score.parts[i]!.staves);
}

/**
 * Make two readings agree on the key of every line. Where they differ, the key with more sharps or
 * flats as printed wins (recognition misses key signatures far more often than it invents them),
 * and the other reading's notes that followed its key follow the winning one.
 */
export function harmoniseKeys(readings: [PageReading, PageReading]): [PageReading, PageReading] {
  let [a, b] = readings;
  if (!canCombine(a, b)) return readings;
  const written = (reading: PageReading, bar: number) => writtenContexts(reading.score, reading.score.parts[0]!)[bar]!.key.fifths;
  const count = readingLines(a).length;
  for (let k = 0; k < count; k++) {
    const startA = readingLines(a)[k]![0];
    const startB = readingLines(b)[k]![0];
    const keyA = concertKeys(a.score)[startA]!;
    const keyB = concertKeys(b.score)[startB]!;
    if (keyA.fifths === keyB.fifths) continue;
    if (Math.abs(written(a, startA)) >= Math.abs(written(b, startB))) b = { ...b, score: correctKeySignature(b.score, startB, keyA) };
    else a = { ...a, score: correctKeySignature(a.score, startA, keyB) };
  }
  return [a, b];
}

/** The clef of each staff of a part just before a bar. */
function clefsBefore(part: Part, measure: number): Clef[] {
  const clefs = part.clefs.map((c) => ({ ...c }));
  for (let m = 0; m < measure; m++) {
    const changes = [...(part.measures[m]?.clefChanges ?? [])].sort((x, y) => cmp(x.offset, y.offset));
    for (const change of changes) clefs[change.staff - 1] = { ...change.clef };
  }
  return clefs;
}

const sameClef = (a: Clef | undefined, b: Clef | undefined) => !!a && !!b && a.sign === b.sign && a.line === b.line && (a.octaveChange ?? 0) === (b.octaveChange ?? 0);

export interface CombinedLine {
  /** Which reading the line came from. */
  source: 0 | 1;
  /** Its bars in the combined score: [first, end). */
  bars: [number, number];
  /** The same bars in the reading it came from. */
  sourceBars: [number, number];
}

/**
 * A page made of lines from two readings: line k from reading `pick[k]`. Key and time signatures
 * and clefs are written out where a line follows one from the other reading, and left out where
 * they repeat. Bars keep their ids.
 */
export function combineReadings(readings: [PageReading, PageReading], pick: (0 | 1)[]): { score: Score; systemStarts: number[]; lines: CombinedLine[] } {
  const ranges = readings.map(readingLines);
  const keys = readings.map((r) => concertKeys(r.score));
  const times = readings.map((r) => timeSignatures(r.score));
  const firstSource = readings[pick[0] ?? 0]!;
  const parts = firstSource.score.parts;
  const startClefs = parts.map((p) => p.clefs.map((c) => ({ ...c })));
  const current = startClefs.map((clefs) => clefs.map((c) => ({ ...c })));
  const measures: MeasureInfo[] = [];
  const partMeasures: PartMeasure[][] = parts.map(() => []);
  const systemStarts: number[] = [];
  const lines: CombinedLine[] = [];
  let lastKey: { fifths: number } | undefined;
  let lastTime: { beats: number; beatType: number } | undefined;

  pick.forEach((source, k) => {
    const reading = readings[source]!;
    const [from, to] = ranges[source]![k]!;
    const start = measures.length;
    systemStarts.push(start);
    for (let m = from; m < to; m++) {
      const info = structuredClone(reading.score.measures[m]!);
      const key = keys[source]![m]!;
      const time = times[source]![m]!;
      if (lastKey && lastKey.fifths === key.fifths) delete info.key;
      else info.key = { ...key };
      if (lastTime && lastTime.beats === time.beats && lastTime.beatType === time.beatType) delete info.time;
      else info.time = { ...time };
      if (start > 0 && m === from) delete info.implicit;
      lastKey = key;
      lastTime = time;
      measures.push(info);
      reading.score.parts.forEach((part, p) => {
        const bar = structuredClone(part.measures[m]!);
        if (m === from) {
          // The reading's clefs coming into the line, where they differ from the lines before.
          clefsBefore(part, from).forEach((clef, s) => {
            const atStart = bar.clefChanges?.some((c) => c.staff === s + 1 && cmp(c.offset, ZERO) === 0);
            if (!atStart && !sameClef(clef, current[p]![s])) bar.clefChanges = [{ staff: s + 1, offset: ZERO, clef }, ...(bar.clefChanges ?? [])];
          });
        }
        for (const change of [...(bar.clefChanges ?? [])].sort((x, y) => cmp(x.offset, y.offset))) current[p]![change.staff - 1] = { ...change.clef };
        partMeasures[p]!.push(bar);
      });
    }
    lines.push({ source, bars: [start, measures.length], sourceBars: [from, to] });
  });

  const score: Score = {
    ...firstSource.score,
    measures,
    parts: parts.map((part, p) => ({ ...part, clefs: startClefs[p]!, measures: partMeasures[p]! })),
  };
  renumberMeasures(score);
  return { score, systemStarts, lines };
}

/** The notes of a bar as "part/onset/pitch/length" (whole notes), sorted. */
function soundsOf(score: Score, lengths: ReturnType<typeof measureLengths>, measure: number, partIndex?: number): string[] {
  const sounds: string[] = [];
  score.parts.forEach((part, p) => {
    if (partIndex !== undefined && p !== partIndex) return;
    for (const voice of part.measures[measure]?.voices ?? []) {
      const onsets = eventOnsets(voice, lengths[measure]!);
      voice.events.forEach((event, i) => {
        if (event.kind !== "note" || event.grace) return;
        const onset = toNumber(onsets[i]!).toFixed(4);
        const value = toNumber(eventValue(event, lengths[measure]!)).toFixed(4);
        for (const note of event.notes) sounds.push(`${p}/${onset}/${midiNumber(note.pitch)}/${value}`);
      });
    }
  });
  return sounds.sort();
}

export type Disagreement =
  | { kind: "pitch" | "rhythm"; /** Bar index in the combined score. */ measure: number; /** The other reading's bar. */ other: { source: 0 | 1; measure: number } }
  | { kind: "missing"; measure: number; other: { source: 0 | 1 } };

/** The melody of a bar's sounds: pitches in order, a repeated or held note counted once. */
const melody = (sounds: string[]) =>
  sounds
    .map((s) => s.split("/")[2])
    .filter((midi, j, all) => j === 0 || midi !== all[j - 1])
    .join();

/** How alike two bars are, to pair the bars of two readings. */
function likeness(a: string[], b: string[]): number {
  if (a.join() === b.join()) return 2;
  if (melody(a) === melody(b)) return 1.5;
  const pa = new Set(a.map((s) => s.split("/")[2]));
  const pb = new Set(b.map((s) => s.split("/")[2]));
  const shared = [...pa].filter((p) => pb.has(p)).length;
  const all = new Set([...pa, ...pb]).size;
  return all && shared / all >= 0.5 ? 0.5 : -1;
}

/**
 * Pair the bars of two readings of the same music by their notes (a global sequence alignment), so
 * that a bar one reading split, merged or missed pairs with nothing and the rest still line up.
 */
export function alignBars(a: Score, b: Score): [number | null, number | null][] {
  const la = measureLengths(a);
  const lb = measureLengths(b);
  const sa = a.measures.map((_, m) => soundsOf(a, la, m));
  const sb = b.measures.map((_, m) => soundsOf(b, lb, m));
  const gap = -1;
  const rows = sa.length + 1;
  const cols = sb.length + 1;
  const best = new Float64Array(rows * cols);
  for (let i = 1; i < rows; i++) best[i * cols] = i * gap;
  for (let j = 1; j < cols; j++) best[j] = j * gap;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      best[i * cols + j] = Math.max(best[(i - 1) * cols + j - 1]! + likeness(sa[i - 1]!, sb[j - 1]!), best[(i - 1) * cols + j]! + gap, best[i * cols + j - 1]! + gap);
    }
  }
  const pairs: [number | null, number | null][] = [];
  let i = sa.length;
  let j = sb.length;
  while (i > 0 || j > 0) {
    const here = best[i * cols + j]!;
    if (i > 0 && j > 0 && Math.abs(here - (best[(i - 1) * cols + j - 1]! + likeness(sa[i - 1]!, sb[j - 1]!))) < 1e-9) {
      pairs.push([--i, --j]);
    } else if (i > 0 && Math.abs(here - (best[(i - 1) * cols + j]! + gap)) < 1e-9) {
      pairs.push([--i, null]);
    } else {
      pairs.push([null, --j]);
    }
  }
  return pairs.reverse();
}

/**
 * Where the reading not chosen for a line read it differently: other pitches, the same melody in
 * another rhythm, or no such bar at all. Bars are paired by their notes, so it works whether or not
 * the readings found the same lines.
 */
export function readingDisagreements(readings: [PageReading, PageReading], lines: CombinedLine[]): Disagreement[] {
  const lengths = readings.map((r) => measureLengths(r.score));
  const partner = [new Map<number, number | null>(), new Map<number, number | null>()];
  for (const [i, j] of alignBars(readings[0].score, readings[1].score)) {
    if (i !== null) partner[0]!.set(i, j);
    if (j !== null) partner[1]!.set(j, i);
  }
  const found: Disagreement[] = [];
  for (const line of lines) {
    const other: 0 | 1 = line.source === 0 ? 1 : 0;
    for (let bar = line.bars[0]; bar < line.bars[1]; bar++) {
      const own = line.sourceBars[0] + (bar - line.bars[0]);
      const pair = partner[line.source]!.get(own);
      if (pair === null || pair === undefined) {
        found.push({ kind: "missing", measure: bar, other: { source: other } });
        continue;
      }
      const a = soundsOf(readings[line.source]!.score, lengths[line.source]!, own);
      const b = soundsOf(readings[other]!.score, lengths[other]!, pair);
      if (a.join() === b.join()) continue;
      found.push({ kind: melody(a) === melody(b) ? "rhythm" : "pitch", measure: bar, other: { source: other, measure: pair } });
    }
  }
  return found;
}

export interface Accuracy {
  /** Notes in the corrected score. */
  notes: number;
  /** Of these, notes the scan had right (same bar, place, pitch and length). */
  right: number;
  /** Notes of the scan that were removed or changed. */
  wrong: number;
}

/**
 * How well a scan was read, now that it has been corrected: its notes compared with the corrected
 * score's, bar by bar (bars keep their ids through edits). `groupOf` sorts bars into groups (for
 * example the engine that read the line); bars added since count under "added".
 */
export function scanAccuracy(scan: Score, corrected: Score, groupOf: (measureId: string) => string | undefined = () => undefined): Accuracy & { groups: Record<string, Accuracy>; changedBars: number } {
  const scanLengths = measureLengths(scan);
  const lengths = measureLengths(corrected);
  const scanIndex = new Map(scan.measures.map((m, i) => [m.id, i]));
  const correctedIndex = new Map(corrected.measures.map((m, i) => [m.id, i]));
  const total: Accuracy = { notes: 0, right: 0, wrong: 0 };
  const groups: Record<string, Accuracy> = {};
  let changedBars = 0;
  const add = (group: string | undefined, counts: Accuracy) => {
    for (const target of [total, ...(group ? [(groups[group] ??= { notes: 0, right: 0, wrong: 0 })] : [])]) {
      target.notes += counts.notes;
      target.right += counts.right;
      target.wrong += counts.wrong;
    }
  };
  // Parts are matched by id, or by position if they were replaced.
  const partFor = (p: number) => {
    const id = scan.parts[p]?.id;
    const byId = corrected.parts.findIndex((part) => part.id === id);
    return byId >= 0 ? byId : p;
  };
  scan.measures.forEach((info, m) => {
    const c = correctedIndex.get(info.id);
    const before = scan.parts.flatMap((_, p) => soundsOf(scan, scanLengths, m, p).map((s) => s.replace(/^\d+\//, `${partFor(p)}/`)));
    const after = c === undefined ? [] : soundsOf(corrected, lengths, c);
    const remaining = new Map<string, number>();
    for (const s of after) remaining.set(s, (remaining.get(s) ?? 0) + 1);
    let right = 0;
    for (const s of before) {
      const n = remaining.get(s) ?? 0;
      if (n > 0) {
        right++;
        remaining.set(s, n - 1);
      }
    }
    if (right !== before.length || right !== after.length) changedBars++;
    add(groupOf(info.id), { notes: after.length, right, wrong: before.length - right });
  });
  corrected.measures.forEach((info, c) => {
    if (scanIndex.has(info.id)) return;
    const notes = soundsOf(corrected, lengths, c).length;
    if (notes) changedBars++;
    add("added", { notes, right: 0, wrong: 0 });
  });
  return { ...total, groups, changedBars };
}
