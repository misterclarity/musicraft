import { addScannedPart, newScore, enterNote, type PartMeasure, type Score } from "@musicraft/score-core";
import { describe, expect, it } from "vitest";
import type { PageRecord } from "./db";
import { barPitches, engineOfBars, openDisagreements, sameBar, withOtherReading } from "./disagreements";

/** A trumpet part, four bars: bar 1 E D C♯ D as written (concert C is D major for a B♭ trumpet), the others rests. */
function score(): Score {
  let s = newScore({ title: "T", parts: [{ instrument: "trumpet-bb" }], measures: 4 });
  for (const step of ["E", "D", "C", "D"] as const) {
    const events = s.parts[0]!.measures[0]!.voices[0]!.events;
    const target = events.find((e) => e.kind === "rest")!;
    s = enterNote(s, target.id, step, { inputDuration: { type: "quarter", dots: 0 } }).score;
  }
  return s;
}

const page = (s: Score, recognition: PageRecord["recognition"], starts: number[]): PageRecord =>
  ({ projectId: "p", index: 0, name: "p", blob: new Blob(), width: 1, height: 1, layout: { staffs: [], systemStartIds: starts.map((i) => s.measures[i]!.id) }, recognition }) as PageRecord;

describe("the bars two readings disagree on", () => {
  it("shows a bar's pitches as the player reads them, and another version of it", () => {
    const s = score();
    expect(barPitches(s, 0)).toBe("E5 D5 C♯5 D5");
    expect(barPitches(s, 1)).toBe("rests only");
    // The other reading has a B♭ (concert), which the player reads as C natural.
    const other = structuredClone(s.parts[0]!.measures[0]!) as PartMeasure;
    const event = other.voices[0]!.events[2]!;
    if (event.kind === "note") event.notes[0]!.pitch = { step: "B", alter: -1, octave: 4 };
    expect(barPitches(s, 0, other)).toBe("E5 D5 C5 D5");
  });

  it("puts in the other version, and knows when it is in", () => {
    const s = score();
    const other = structuredClone(s.parts[0]!.measures[1]!) as PartMeasure;
    expect(sameBar(s.parts[0]!.measures[0], other)).toBe(false);
    const changed = withOtherReading(s, 0, other);
    expect(sameBar(changed.parts[0]!.measures[0], other)).toBe(true);
    expect(barPitches(changed, 0)).toBe("rests only");
    // The rest of the score is untouched.
    expect(changed.parts[0]!.measures[1]).toBe(s.parts[0]!.measures[1]);
  });

  it("lists the disagreements of bars still in the score, in order, and the engine of each bar", () => {
    const s = score();
    const recognition = {
      lineEngines: ["engine A", "engine B"],
      disagreements: [
        { measureId: s.measures[2]!.id, kind: "pitch" as const, readBy: "engine A" },
        { measureId: "gone", kind: "missing" as const, readBy: "engine A" },
        { measureId: s.measures[0]!.id, kind: "rhythm" as const, readBy: "engine B" },
      ],
    };
    const pages = [page(s, recognition, [0, 2])];
    expect(openDisagreements(s, pages).map((d) => d.measureIndex)).toEqual([0, 2]);
    expect([...engineOfBars(s, pages).values()]).toEqual(["engine A", "engine A", "engine B", "engine B"]);
  });

  it("puts another reading into the part that was scanned on its own, and lists its bars by part", () => {
    const horn = newScore({ title: "T", parts: [{ instrument: "horn-f" }], measures: 4 });
    const { score: both, partIds } = addScannedPart(horn, score());
    const trumpetBar = structuredClone(both.parts[1]!.measures[1]!) as PartMeasure;
    const changed = withOtherReading(both, 0, trumpetBar, partIds[0]);
    // The scanned part (second) changes; the horn doesn't.
    expect(barPitches(changed, 0, undefined, partIds[0])).toBe("rests only");
    expect(changed.parts[0]).toBe(both.parts[0]);
    const pages = [{ ...page(both, { lineEngines: ["A"], disagreements: [{ measureId: both.measures[1]!.id, kind: "pitch" as const, readBy: "A" }] }, [0]), partId: partIds[0] }];
    expect(openDisagreements(both, pages)).toEqual([expect.objectContaining({ measureIndex: 1, partId: partIds[0] })]);
    // Its pages say nothing about the score as first scanned, nor once the part is taken out again.
    expect(engineOfBars(both, pages).size).toBe(0);
    expect(openDisagreements(horn, pages)).toEqual([]);
  });
});
