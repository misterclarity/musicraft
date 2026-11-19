import { describe, expect, it } from "vitest";
import { halfCut, performSteps, stepFor, stepLabel, type PageLines } from "./performance";

// Three pages of three lines each, and a last page with one line.
const lines = (gaps: number[]): PageLines => ({ gaps });
const pages = [lines([0.34, 0.66]), lines([0.3, 0.62]), lines([0.35, 0.7]), lines([])];

describe("performance mode page turns", () => {
  it("turns one page at a time", () => {
    const steps = performSteps(pages, { twoUp: false, half: false });
    expect(steps.map((s) => s.view)).toEqual([0, 1, 2, 3].map((page) => ({ kind: "page", page })));
    expect(stepLabel(steps[1]!.view, 4)).toBe("Page 2 of 4");
  });

  it("turns half a page first: the top of the next page above the end of this one", () => {
    const steps = performSteps(pages, { twoUp: false, half: true });
    expect(steps.map((s) => s.view.kind)).toEqual(["page", "half", "page", "half", "page", "half", "page"]);
    // Page 1 is cut at its gap nearest the middle; page 2 shows down to its last gap above that.
    expect(steps[1]!.view).toEqual({ kind: "half", top: 1, bottom: 0, topCut: 0.62, bottomCut: 0.66 });
    expect(steps[3]!.view).toEqual({ kind: "half", top: 2, bottom: 1, topCut: 0.35, bottomCut: 0.62 });
    expect(stepLabel(steps[1]!.view, 4)).toBe("Pages 1–2 of 4");
    expect(halfCut(lines([0.2, 0.45, 0.7]))).toBe(0.45);
    expect(halfCut(lines([]))).toBeNull();
  });

  it("shows two pages side by side, and with half turns replaces the one just played", () => {
    const book = performSteps(pages, { twoUp: true, half: false });
    expect(book.map((s) => s.view)).toEqual([
      { kind: "spread", left: 0, right: 1 },
      { kind: "spread", left: 2, right: 3 },
    ]);
    const half = performSteps(pages, { twoUp: true, half: true });
    expect(half.map((s) => s.view)).toEqual([
      { kind: "spread", left: 0, right: 1 },
      { kind: "spread", left: 2, right: 1 },
      { kind: "spread", left: 2, right: 3 },
    ]);
    expect(performSteps([lines([])], { twoUp: true, half: true }).map((s) => s.view)).toEqual([{ kind: "spread", left: 0, right: null }]);
  });

  it("follows the bar being played", () => {
    const steps = performSteps(pages, { twoUp: false, half: true });
    // A bar at the top of page 1, then one below its cut (the next page's top appears), then page 2.
    expect(stepFor(steps, 0, 0.1)).toBe(0);
    expect(stepFor(steps, 0, 0.8)).toBe(1);
    expect(stepFor(steps, 1, 0.1)).toBe(2);
    expect(stepFor(steps, 3, 0.5)).toBe(6);
    const half = performSteps(pages, { twoUp: true, half: true });
    // Playing page 2 (right): page 3 replaces page 1 on the left; playing page 4: its spread is the last.
    expect(stepFor(half, 1, 0.5)).toBe(1);
    expect(stepFor(half, 3, 0.5)).toBe(2);
    expect(stepFor(steps, 9, 0.5)).toBeNull();
  });
});
