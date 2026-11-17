import { describe, expect, it } from "vitest";
import { describeAccuracy, type AccuracyResult } from "./accuracy";

const result = (notes: number, right: number, wrong: number, groups: AccuracyResult["groups"] = {}, changedBars = 3): AccuracyResult => ({ notes, right, wrong, groups, changedBars });

describe("how well a scan was read, in words", () => {
  it("gives the share of notes read right, after the corrections and for each engine", () => {
    const lines = describeAccuracy({
      scan: result(200, 180, 25, { "engine A": { notes: 120, right: 114, wrong: 8 }, "engine B": { notes: 76, right: 66, wrong: 17 }, added: { notes: 4, right: 0, wrong: 0 } }),
      afterRepairs: result(200, 188, 15),
    });
    expect(lines).toEqual([
      "The scan had 180 of the 200 notes right (90%).",
      "25 of its notes were wrong or extra.",
      "After the automatic corrections: 188 of 200 (94%).",
      "Lines read by engine A: 114 of 120 right (95%).",
      "Lines read by engine B: 66 of 76 right (87%).",
      "4 notes are in bars added since the scan.",
      "3 bars changed since the scan.",
    ]);
  });

  it("says when the comparison says little", () => {
    expect(describeAccuracy({ scan: result(100, 10, 90) }).at(-1)).toMatch(/transposed or rearranged/);
    expect(describeAccuracy({ scan: result(0, 0, 0) })).toEqual(["The score has no notes to compare yet."]);
  });
});
