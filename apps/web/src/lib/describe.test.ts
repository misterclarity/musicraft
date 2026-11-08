import { newScore, parsePitch, type Score } from "@musicraft/score-core";
import { describe, expect, it } from "vitest";
import { describeSelection } from "./describe";

function scoreWithNote(): { score: Score; eventId: string } {
  const score = newScore({ title: "T", parts: [{ instrument: "trumpet-bb" }], measures: 2 });
  const voice = score.parts[0]!.measures[0]!.voices[0]!;
  voice.events = [
    { kind: "note", id: "e1", duration: { type: "half", dots: 1 }, notes: [{ id: "n1", pitch: parsePitch("C5") }] },
    { kind: "rest", id: "e2", duration: { type: "quarter", dots: 0 } },
  ];
  return { score, eventId: "e1" };
}

describe("selection descriptions", () => {
  it("describes a note with written and sounding pitch", () => {
    const { score } = scoreWithNote();
    expect(describeSelection(score, { eventIds: ["e1"] }, false)).toBe("Trumpet in B♭ · bar 1 · D5 (sounds C5) · dotted half note");
    expect(describeSelection(score, { eventIds: ["e1"] }, true)).toBe("Trumpet in B♭ · bar 1 · C5 · dotted half note");
    expect(describeSelection(score, { eventIds: ["e2"] }, false)).toBe("Trumpet in B♭ · bar 1 · quarter rest");
  });

  it("describes bar ranges", () => {
    const { score } = scoreWithNote();
    expect(describeSelection(score, { eventIds: [], measures: { from: 0, to: 1 } }, false)).toBe("Bars 1–2 · all parts");
  });
});
