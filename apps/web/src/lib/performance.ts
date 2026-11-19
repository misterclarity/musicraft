/**
 * Page turns in performance mode. The music is engraved in pages the size of the screen and shown
 * one at a time, two side by side (a landscape tablet), and with half-page turns: first the top of
 * the next page replaces the top of this one (already played) while the bottom is still being
 * read, then the rest. Played along with, the view follows the bar being played.
 */

/** Where a page can be cut between two lines of music (fractions of its height, top to bottom). */
export interface PageLines {
  gaps: number[];
}

export type PerformView =
  | { kind: "page"; page: number }
  /** The top of page `top` (down to `topCut`) above the end of page `bottom` (from `bottomCut`). */
  | { kind: "half"; top: number; bottom: number; topCut: number; bottomCut: number }
  /** Two pages side by side; null where there is no page. */
  | { kind: "spread"; left: number | null; right: number | null };

/** A view, and which page (from where down) the player reads while it is shown. */
export interface Step {
  view: PerformView;
  reads: { page: number; from: number }[];
}

/**
 * Where to cut a page for a half turn: the gap between lines nearest its middle, the lower one of two
 * as near (more of the next page shows). None for a page of one line.
 */
export function halfCut(page: PageLines | undefined): number | null {
  if (!page?.gaps.length) return null;
  return page.gaps.reduce((best, gap) => (Math.abs(gap - 0.5) <= Math.abs(best - 0.5) + 1e-9 ? gap : best));
}

/** How much of the next page fits above a cut: down to its last gap above the cut (or the cut itself). */
function topCut(page: PageLines | undefined, limit: number): number {
  const above = (page?.gaps ?? []).filter((gap) => gap <= limit);
  return above.length ? Math.max(...above) : limit;
}

/** The steps through the pages, one turn (or half turn) at a time. */
export function performSteps(pages: PageLines[], options: { twoUp: boolean; half: boolean }): Step[] {
  const count = pages.length;
  const steps: Step[] = [];
  const page = (n: number) => (n < count ? n : null);
  if (!count) return steps;
  if (options.twoUp && options.half) {
    // [1 2] → [3 2] → [3 4] → [5 4]…: the page just finished makes way for the next while the other is read.
    for (let q = 0; q === 0 || q + 1 < count; q++) {
      const view: PerformView = q % 2 === 0 ? { kind: "spread", left: q, right: page(q + 1) } : { kind: "spread", left: q + 1, right: q };
      steps.push({ view, reads: [{ page: q, from: 0 }] });
    }
  } else if (options.twoUp) {
    for (let left = 0; left < count; left += 2) {
      const right = page(left + 1);
      steps.push({ view: { kind: "spread", left, right }, reads: [{ page: left, from: 0 }, ...(right === null ? [] : [{ page: right, from: 0 }])] });
    }
  } else {
    for (let n = 0; n < count; n++) {
      steps.push({ view: { kind: "page", page: n }, reads: [{ page: n, from: 0 }] });
      const cut = options.half && n + 1 < count ? halfCut(pages[n]) : null;
      if (cut !== null) {
        steps.push({ view: { kind: "half", top: n + 1, bottom: n, topCut: topCut(pages[n + 1], cut), bottomCut: cut }, reads: [{ page: n, from: cut }] });
      }
    }
  }
  return steps;
}

/**
 * The step to show while a bar is played: the one for its page and the part of the page it is in
 * (`y`, a fraction of the height), or the last one showing its page.
 */
export function stepFor(steps: Step[], page: number, y: number): number | null {
  let best: number | null = null;
  let bestFrom = -1;
  steps.forEach((step, i) => {
    for (const read of step.reads) {
      if (read.page === page && read.from <= y && read.from > bestFrom) {
        best = i;
        bestFrom = read.from;
      }
    }
  });
  if (best !== null) return best;
  for (let i = steps.length - 1; i >= 0; i--) if (shownPages(steps[i]!.view).includes(page)) return i;
  return null;
}

/** The pages a view shows. */
export function shownPages(view: PerformView): number[] {
  if (view.kind === "page") return [view.page];
  if (view.kind === "half") return [view.bottom, view.top];
  return [view.left, view.right].filter((p): p is number => p !== null).sort((a, b) => a - b);
}

/** "Page 2 of 5", "Pages 2–3 of 5". */
export function stepLabel(view: PerformView, count: number): string {
  const pages = shownPages(view);
  return pages.length === 1 ? `Page ${pages[0]! + 1} of ${count}` : `Pages ${pages[0]! + 1}–${pages[pages.length - 1]! + 1} of ${count}`;
}
