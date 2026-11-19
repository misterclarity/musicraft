/**
 * The bars two recognition engines read differently (stored with the scanned pages), and what the
 * Checks and History tabs need to show them: the notes of each version, putting in the other one,
 * and which engine read which bars.
 */
import { printBars, type PartMeasure, type Score } from "@musicraft/score-core";
import type { PageRecord, ReadingDisagreement } from "./db";

/** The part a scanned page's readings are of: the part scanned on its own, or the score's first. */
export function readingPart(score: Score, partId?: string): number {
  return Math.max(0, partId ? score.parts.findIndex((p) => p.id === partId) : 0);
}

/** The score with another version of a bar of the scanned part (the score's first unless given). */
export function withOtherReading(score: Score, measureIndex: number, bar: PartMeasure, partId?: string): Score {
  const index = readingPart(score, partId);
  const part = score.parts[index];
  if (!part?.measures[measureIndex]) return score;
  const measures = [...part.measures];
  measures[measureIndex] = structuredClone(bar);
  return { ...score, parts: score.parts.map((p, i) => (i === index ? { ...part, measures } : p)) };
}

/** The pitches of a bar as the player reads them, e.g. "E5 D5 C♯5 D5" (another version of the bar if given). */
export function barPitches(score: Score, measureIndex: number, bar?: PartMeasure, partId?: string): string {
  const shown = bar ? withOtherReading(score, measureIndex, bar, partId) : score;
  const line = printBars(shown, readingPart(score, partId), measureIndex, measureIndex, "written")[0] ?? "";
  const notes = line.replace(/^[^:]*:\s*/, "").match(/[A-G](?:##|#|bb|b|n)?-?\d/g) ?? [];
  return notes.length ? notes.map((n) => n.replace("##", "𝄪").replace("#", "♯").replace("bb", "𝄫").replace(/([A-G])b/, "$1♭").replace("n", "")).join(" ") : "rests only";
}

/** Whether a bar has the same notes and rests as another version of it (ids aside). */
export function sameBar(a: PartMeasure | undefined, b: PartMeasure): boolean {
  const content = (bar: PartMeasure) =>
    JSON.stringify(
      bar.voices.map((v) => ({
        staff: v.staff,
        events: v.events.map((e) => (e.kind === "note" ? { d: e.duration, g: !!e.grace, p: e.notes.map((n) => n.pitch) } : { d: e.duration, r: !!e.measureRest })),
      })),
    );
  return !!a && content(a) === content(b);
}

/**
 * The disagreements of all scanned pages whose bars (and part, for a part scanned on its own) are
 * still in the score, in bar order.
 */
export function openDisagreements(score: Score, pages: PageRecord[]): { disagreement: ReadingDisagreement; measureIndex: number; partId?: string }[] {
  const index = new Map(score.measures.map((m, i) => [m.id, i]));
  const parts = new Set(score.parts.map((p) => p.id));
  return pages
    .filter((page) => page.partId === undefined || parts.has(page.partId))
    .flatMap((page) => (page.recognition?.disagreements ?? []).map((disagreement) => ({ disagreement, partId: page.partId })))
    .flatMap(({ disagreement, partId }) => {
      const measureIndex = index.get(disagreement.measureId);
      return measureIndex === undefined ? [] : [{ disagreement, measureIndex, ...(partId ? { partId } : {}) }];
    })
    .sort((a, b) => a.measureIndex - b.measureIndex);
}

/** The engine that read each bar of the scan, by bar id (bars of pages read by one engine only are left out). */
export function engineOfBars(scan: Score, pages: PageRecord[]): Map<string, string> {
  const lineStarts = new Map<string, string | null>();
  // The score as first scanned: parts scanned on their own later are not in it.
  for (const page of pages.filter((p) => p.partId === undefined)) {
    const engines = page.recognition?.lineEngines;
    const starts = page.layout?.systemStartIds;
    if (!engines || !starts) continue;
    starts.forEach((id, k) => lineStarts.set(id, engines[k] ?? null));
  }
  const engines = new Map<string, string>();
  let current: string | null = null;
  for (const measure of scan.measures) {
    if (lineStarts.has(measure.id)) current = lineStarts.get(measure.id) ?? null;
    if (current) engines.set(measure.id, current);
  }
  return engines;
}
