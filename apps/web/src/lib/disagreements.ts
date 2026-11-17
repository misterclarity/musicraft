/**
 * The bars two recognition engines read differently (stored with the scanned pages), and what the
 * Checks and History tabs need to show them: the notes of each version, putting in the other one,
 * and which engine read which bars.
 */
import { printBars, type PartMeasure, type Score } from "@musicraft/score-core";
import type { PageRecord, ReadingDisagreement } from "./db";

/** The score with another version of a bar of its (single) part. */
export function withOtherReading(score: Score, measureIndex: number, bar: PartMeasure): Score {
  const part = score.parts[0];
  if (!part?.measures[measureIndex]) return score;
  const measures = [...part.measures];
  measures[measureIndex] = structuredClone(bar);
  return { ...score, parts: [{ ...part, measures }, ...score.parts.slice(1)] };
}

/** The pitches of a bar as the player reads them, e.g. "E5 D5 C♯5 D5" (another version of the bar if given). */
export function barPitches(score: Score, measureIndex: number, bar?: PartMeasure): string {
  const shown = bar ? withOtherReading(score, measureIndex, bar) : score;
  const line = printBars(shown, 0, measureIndex, measureIndex, "written")[0] ?? "";
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

/** The disagreements of all scanned pages whose bars are still in the score, in bar order. */
export function openDisagreements(score: Score, pages: PageRecord[]): { disagreement: ReadingDisagreement; measureIndex: number }[] {
  const index = new Map(score.measures.map((m, i) => [m.id, i]));
  return pages
    .flatMap((page) => page.recognition?.disagreements ?? [])
    .flatMap((disagreement) => {
      const measureIndex = index.get(disagreement.measureId);
      return measureIndex === undefined ? [] : [{ disagreement, measureIndex }];
    })
    .sort((a, b) => a.measureIndex - b.measureIndex);
}

/** The engine that read each bar of the scan, by bar id (bars of pages read by one engine only are left out). */
export function engineOfBars(scan: Score, pages: PageRecord[]): Map<string, string> {
  const lineStarts = new Map<string, string | null>();
  for (const page of pages) {
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
