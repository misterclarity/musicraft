/**
 * Two readings of a page, when the recognition service read it with two engines: choosing between
 * them, or taking each line from the reading in which it holds together better, and listing the
 * bars the readings disagree on.
 */
import {
  canCombine,
  combineReadings,
  harmoniseKeys,
  importMusicXml,
  lineQuality,
  readingDisagreements,
  readingLines,
  readingQuality,
  repairRecognized,
  type CombinedLine,
  type ImportResult,
  type PageReading,
  type Score,
} from "@musicraft/score-core";
import type { ReadingDisagreement } from "./db";
import type { OmrStaff } from "./omr";

export interface Reading {
  /** The engine that read it, e.g. "homr 0.7.0". */
  readBy?: string | null;
  musicxml: string;
  staffs: OmrStaff[];
}

export interface ChosenReading {
  reading: Reading;
  imported: ImportResult;
  /** What the comparison found, when there was more than one reading. */
  note?: string;
}

/** How scanned pages are imported: written for the chosen instrument, voices in reading order. */
export function importReading(musicxml: string, instrument: string): ImportResult {
  return importMusicXml(musicxml, { instruments: [instrument], detectPickups: false, sequentialVoices: true });
}

interface Candidate {
  reading: Reading;
  imported: ImportResult;
  fitting: number;
  withNotes: number;
  order: "first" | "second";
}

/** Import each reading (those that can be); throws the first error when none can. */
function importCandidates(readings: Reading[], instrument: string): Candidate[] {
  const candidates: Candidate[] = [];
  let firstError: Error | undefined;
  readings.forEach((reading, i) => {
    try {
      const imported = importReading(reading.musicxml, instrument);
      const quality = readingQuality(repairRecognized(imported.score).score);
      candidates.push({ reading, imported, ...quality, order: i === 0 ? "first" : "second" });
    } catch (e) {
      firstError ??= e as Error;
    }
  });
  if (!candidates.length) throw firstError ?? new Error("No music was recognised.");
  return candidates;
}

const engine = (reading: Reading) => (reading.readBy ? ` (${reading.readBy})` : "");

function choose(candidates: Candidate[], readings: number, pageName: string): ChosenReading & { best: Candidate } {
  const best = candidates.reduce((a, b) => (b.fitting > a.fitting ? b : a));
  if (readings < 2) return { reading: best.reading, imported: best.imported, best };
  const other = candidates.find((c) => c !== best);
  const note = other
    ? `${pageName}: kept the ${best.order} reading${engine(best.reading)}: ${best.fitting} of ${best.withNotes} bars with notes add up, against ${other.fitting} of ${other.withNotes} in the ${other.order}${engine(other.reading)}.`
    : `${pageName}: only the ${best.order} reading${engine(best.reading)} could be used.`;
  return { reading: best.reading, imported: best.imported, note, best };
}

/**
 * Import the readings of a page and keep the one whose bars hold together best after the usual
 * repairs: the most bars with notes that add up to their time signature (the first on a tie).
 */
export function chooseReading(readings: Reading[], instrument: string, pageName: string): ChosenReading {
  const { reading, imported, note } = choose(importCandidates(readings, instrument), readings.length, pageName);
  return { reading, imported, ...(note ? { note } : {}) };
}

export interface PageResult {
  /** The page as it will be used: one reading, or lines from both. */
  imported: ImportResult;
  /** Staff boxes, to show its lines on the original page. */
  staffs: OmrStaff[];
  /** The engine that read each line (in the order of imported.systemStarts). */
  lineEngines: (string | null)[];
  /** Bars the other reading read differently, by bar id. */
  disagreements: ReadingDisagreement[];
  note?: string;
}

/** "line 2", "lines 2 and 5", "lines 1, 2 and 5". */
function lineList(lines: number[]): string {
  const names = lines.map((l) => String(l + 1));
  if (names.length === 1) return `line ${names[0]}`;
  return `lines ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** A line is better the more of its bars with notes add up, and the fewer don't. */
const net = (q: { fitting: number; withNotes: number }) => 2 * q.fitting - q.withNotes;

/**
 * Read a page from its readings. With two readings that found the same lines, each line comes from
 * the reading in which it holds together better (after giving the reading that missed a key
 * signature the other's); otherwise the better reading is kept whole. Either way, the bars where
 * the other reading has other notes are listed, with its version of them.
 */
export function readPage(readings: Reading[], instrument: string, pageName: string): PageResult {
  const candidates = importCandidates(readings, instrument);
  const chosen = choose(candidates, readings.length, pageName);
  const single = (note?: string): PageResult => ({
    imported: chosen.imported,
    staffs: chosen.reading.staffs,
    lineEngines: readingLines({ score: chosen.imported.score, systemStarts: chosen.imported.systemStarts }).map(() => chosen.reading.readBy ?? null),
    disagreements: [],
    ...(note ? { note } : {}),
  });
  if (candidates.length < 2) return single(chosen.note);

  const [first, second] = candidates as [Candidate, Candidate];
  const pair = harmoniseKeys([
    { score: first.imported.score, systemStarts: first.imported.systemStarts },
    { score: second.imported.score, systemStarts: second.imported.systemStarts },
  ]);
  const repaired = pair.map((r) => ({ ...r, score: repairRecognized(r.score).score })) as [PageReading, PageReading];

  let score: Score;
  let systemStarts: number[];
  let lines: CombinedLine[];
  let note = chosen.note;
  let staffs = chosen.reading.staffs;
  const sources = [first.reading, second.reading];
  if (canCombine(pair[0], pair[1])) {
    const ranges = pair.map(readingLines);
    const pick = ranges[0]!.map(([from, to], k) => {
      const [otherFrom, otherTo] = ranges[1]![k]!;
      return net(lineQuality(repaired[1].score, otherFrom, otherTo)) > net(lineQuality(repaired[0].score, from, to)) ? 1 : 0;
    });
    const combined = combineReadings(pair, pick);
    ({ score, systemStarts, lines } = combined);
    const fromSecond = pick.flatMap((p, k) => (p === 1 ? [k] : []));
    const quality = readingQuality(repairRecognized(score).score);
    if (fromSecond.length && fromSecond.length < pick.length) {
      note =
        `${pageName}: ${lineList(fromSecond)} from the second reading${engine(second.reading)}, the rest from the first${engine(first.reading)}: ` +
        `${quality.fitting} of ${quality.withNotes} bars with notes add up, against ${first.fitting} and ${second.fitting} in either alone.`;
    } else {
      const [kept, other] = fromSecond.length ? [second, first] : [first, second];
      note =
        `${pageName}: kept the ${kept.order} reading${engine(kept.reading)} for every line: ${quality.fitting} of ${quality.withNotes} bars with notes add up, ` +
        `against ${other.fitting} of ${other.withNotes} in the ${other.order}${engine(other.reading)}.`;
    }
    // Both found the same lines: either reading's staff boxes fit.
    staffs = first.reading.staffs.length >= second.reading.staffs.length ? first.reading.staffs : second.reading.staffs;
  } else {
    const index = chosen.best === first ? 0 : 1;
    score = pair[index]!.score;
    systemStarts = pair[index]!.systemStarts;
    const count = score.measures.length;
    lines = [{ source: index as 0 | 1, bars: [0, count], sourceBars: [0, count] }];
  }

  const disagreements: ReadingDisagreement[] = readingDisagreements(repaired, lines).map((d) => {
    const other = sources[d.other.source]!;
    const bar = d.kind === "missing" ? undefined : structuredClone(repaired[d.other.source].score.parts[0]!.measures[d.other.measure]!);
    return { measureId: score.measures[d.measure]!.id, kind: d.kind, readBy: other.readBy ?? null, ...(bar ? { bar } : {}) };
  });
  const lineEngines = readingLines({ score, systemStarts }).map((_, k) => sources[lines.length > 1 ? lines[k]!.source : lines[0]!.source]!.readBy ?? null);
  return {
    imported: {
      score,
      systemStarts,
      warnings: [...new Set([...first.imported.warnings, ...second.imported.warnings])],
      imagePositions: { ...second.imported.imagePositions, ...first.imported.imagePositions },
    },
    staffs,
    lineEngines,
    disagreements,
    ...(note ? { note } : {}),
  };
}
