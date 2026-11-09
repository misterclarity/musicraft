/** Lines of music on scanned pages and the bars of the score they hold. */
import type { Score } from "@musicraft/score-core";
import type { PageRecord } from "./db";

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageSystem {
  /** Index into the pages. */
  page: number;
  /** Line on that page, from the top. */
  system: number;
  /** First and last measure index it holds now. */
  from: number;
  to: number;
  /** Its staff boxes (normalised 0–1). */
  staffs: Box[];
}

/**
 * Resolve the lines of the scanned pages against the current score. Each line is anchored to the id of
 * its first bar, so bars inserted or deleted afterwards (an expanded multi-bar rest, an undo) stay with
 * the right line. Projects saved before lines had ids use bar positions instead.
 */
export function resolveSystems(pages: PageRecord[], score: Score): PageSystem[] {
  const indexById = new Map(score.measures.map((m, i) => [m.id, i]));
  const last = score.measures.length - 1;
  const starts: { page: number; system: number; start: number; staffs: Box[]; pageEnd?: number }[] = [];
  pages.forEach((page, p) => {
    const layout = page.layout;
    if (!layout) return;
    const perSystem = Math.max(1, layout.staffsPerSystem ?? 1);
    const relative = layout.systemStarts?.length ? layout.systemStarts : [0];
    relative.forEach((rel, s) => {
      const id = layout.systemStartIds?.[s];
      let start: number | undefined;
      if (layout.systemStartIds) start = id !== undefined ? indexById.get(id) : undefined;
      else if (layout.measureRange) start = layout.measureRange[0] + rel;
      // A line whose first bar was deleted is merged into the line before it.
      if (start === undefined || start > last) return;
      starts.push({
        page: p,
        system: s,
        start,
        staffs: layout.staffs.slice(s * perSystem, s * perSystem + perSystem),
        pageEnd: layout.systemStartIds ? undefined : layout.measureRange?.[1],
      });
    });
  });
  starts.sort((a, b) => a.start - b.start || a.page - b.page || a.system - b.system);
  return starts.map((entry, k) => {
    const next = starts[k + 1];
    let to = next ? next.start - 1 : last;
    if (entry.pageEnd !== undefined && (!next || next.page !== entry.page)) to = Math.min(to, entry.pageEnd);
    return { page: entry.page, system: entry.system, from: entry.start, to: Math.max(entry.start, to), staffs: entry.staffs };
  });
}

/** The line that holds a bar, if any. */
export function systemOfMeasure(systems: PageSystem[], measureIndex: number): PageSystem | undefined {
  return systems.find((s) => s.from <= measureIndex && measureIndex <= s.to);
}
