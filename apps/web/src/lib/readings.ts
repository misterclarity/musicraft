/** Choosing between two readings of a page, when the recognition service read it with two engines. */
import { importMusicXml, readingQuality, repairRecognized, type ImportResult } from "@musicraft/score-core";
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

/**
 * Import the readings of a page and keep the one whose bars hold together best after the usual
 * repairs: the most bars with notes that add up to their time signature (the first on a tie).
 */
export function chooseReading(readings: Reading[], instrument: string, pageName: string): ChosenReading {
  const candidates: { reading: Reading; imported: ImportResult; fitting: number; withNotes: number; order: string }[] = [];
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
  const best = candidates.reduce((a, b) => (b.fitting > a.fitting ? b : a));
  if (readings.length < 2) return { reading: best.reading, imported: best.imported };
  const other = candidates.find((c) => c !== best);
  const engine = (c: { reading: Reading }) => (c.reading.readBy ? ` (${c.reading.readBy})` : "");
  const note = other
    ? `${pageName}: kept the ${best.order} reading${engine(best)}: ${best.fitting} of ${best.withNotes} bars with notes add up, against ${other.fitting} of ${other.withNotes} in the ${other.order}${engine(other)}.`
    : `${pageName}: only the ${best.order} reading${engine(best)} could be used.`;
  return { reading: best.reading, imported: best.imported, note };
}
