import { deleteMeasures, expandMultiRest, newScore } from "@musicraft/score-core";
import { describe, expect, it } from "vitest";
import type { PageRecord } from "./db";
import { resolveSystems } from "./pageLayout";

const staff = (y: number) => ({ x: 0.1, y, width: 0.8, height: 0.05 });

function scanned(score: ReturnType<typeof newScore>, withIds: boolean): PageRecord[] {
  // Two pages: bars 1–4 on page 1 (lines starting at bars 1 and 3), bars 5–8 on page 2 (one line).
  const ids = (from: number, starts: number[]) => (withIds ? { systemStartIds: starts.map((s) => score.measures[from + s]!.id) } : {});
  return [
    { projectId: "p", index: 0, name: "1", blob: new Blob(), width: 1000, height: 1400, layout: { staffs: [staff(0.1), staff(0.3)], staffsPerSystem: 1, measureRange: [0, 3], systemStarts: [0, 2], ...ids(0, [0, 2]) } },
    { projectId: "p", index: 1, name: "2", blob: new Blob(), width: 1000, height: 1400, layout: { staffs: [staff(0.1)], staffsPerSystem: 1, measureRange: [4, 7], systemStarts: [0], ...ids(4, [0]) } },
  ];
}

const ranges = (pages: PageRecord[], score: ReturnType<typeof newScore>) => resolveSystems(pages, score).map((s) => [s.page, s.system, s.from, s.to]);

describe("scanned page lines", () => {
  const score = newScore({ title: "T", parts: [{ instrument: "trumpet-bb" }], measures: 8 });

  it("maps each line to its bars", () => {
    const expected = [
      [0, 0, 0, 1],
      [0, 1, 2, 3],
      [1, 0, 4, 7],
    ];
    expect(ranges(scanned(score, true), score)).toEqual(expected);
    expect(ranges(scanned(score, false), score)).toEqual(expected);
  });

  it("keeps lines aligned when a multi-bar rest adds bars, and after undo", () => {
    const pages = scanned(score, true);
    const expanded = expandMultiRest(score, 2, 7); // bar 3 (line 2 of page 1) is a 7-bar rest
    expect(ranges(pages, expanded)).toEqual([
      [0, 0, 0, 1],
      [0, 1, 2, 9],
      [1, 0, 10, 13],
    ]);
    // Undo gives back the original score object: the same lines again.
    expect(ranges(pages, score)).toEqual([
      [0, 0, 0, 1],
      [0, 1, 2, 3],
      [1, 0, 4, 7],
    ]);
  });

  it("merges a line into the one before when its first bar is deleted", () => {
    const pages = scanned(score, true);
    const shorter = deleteMeasures(score, 2, 2);
    expect(ranges(pages, shorter)).toEqual([
      [0, 0, 0, 2],
      [1, 0, 3, 6],
    ]);
  });
});
