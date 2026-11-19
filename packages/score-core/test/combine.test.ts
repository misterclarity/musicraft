import { describe, expect, it } from "vitest";
import { addScannedPart, newScore, type NoteEvent, type Score } from "../src";

/** A score of `bars` bars for these instruments, the first part playing a C in every bar. */
function score(bars: number, instruments: string[], options: { time?: { beats: number; beatType: number }; marks?: Record<number, string> } = {}): Score {
  const s = newScore({ parts: instruments.map((instrument) => ({ instrument })), measures: bars, time: options.time });
  for (const [bar, mark] of Object.entries(options.marks ?? {})) s.measures[Number(bar)]!.rehearsal = mark;
  s.parts[0]!.measures.forEach((m, i) => {
    const note: NoteEvent = { kind: "note", id: `e${instruments[0]}${i}`, duration: { type: "whole", dots: 0 }, notes: [{ id: `n${instruments[0]}${i}`, pitch: { step: "C", alter: 0, octave: 5 } }] };
    m.voices[0]!.events = [note];
  });
  return s;
}

const pitches = (s: Score, part: number) => s.parts[part]!.measures.map((m) => (m.voices[0]!.events[0]!.kind === "note" ? "C" : "-")).join("");

describe("adding a separately scanned part", () => {
  it("lines the part up bar by bar, as a new part, keeping the score's bars", () => {
    const quartet = score(8, ["trumpet-bb", "trombone"], { marks: { 4: "A" } });
    const clarinet = score(8, ["clarinet-bb"], { marks: { 4: "A" } });
    const { score: combined, partIds, measureIds, notes } = addScannedPart(quartet, clarinet);
    expect(combined.parts.map((p) => p.instrument)).toEqual(["trumpet-bb", "trombone", "clarinet-bb"]);
    expect(partIds).toEqual([combined.parts[2]!.id]);
    expect(pitches(combined, 2)).toBe("CCCCCCCC");
    expect(combined.measures.map((m) => m.id)).toEqual(quartet.measures.map((m) => m.id));
    expect(measureIds).toEqual(quartet.measures.map((m) => m.id));
    // Mark A and the final bar line.
    expect(notes).toEqual(["Rehearsal marks, repeats and double bar lines line up (2 of 2)."]);
    // The score it came from is left alone.
    expect(quartet.parts).toHaveLength(2);
  });

  it("rests where the part has no bars, and adds bars when it is longer", () => {
    const duo = score(6, ["trumpet-bb"]);
    const short = addScannedPart(duo, score(4, ["horn-f"]), { at: 1 });
    expect(pitches(short.score, 1)).toBe("-CCCC-");
    expect(short.notes.join(" ")).toMatch(/starts at bar 2.*fewer than the score: it rests from bar 6/);
    const long = addScannedPart(duo, score(9, ["horn-f"]));
    expect(long.score.measures).toHaveLength(9);
    expect(long.score.measures.slice(6).map((m) => m.number)).toEqual(["7", "8", "9"]);
    expect(pitches(long.score, 0)).toBe("CCCCCC---");
    expect(long.notes[0]).toMatch(/3 bars longer than the score/);
  });

  it("says where time signatures, keys and landmarks don't line up", () => {
    const waltz = score(8, ["violin"], { time: { beats: 3, beatType: 4 }, marks: { 2: "A", 6: "B" } });
    const part = score(8, ["cello"], { marks: { 3: "A", 6: "B" } });
    part.measures[0]!.key = { fifths: 1, mode: "major" };
    const { notes } = addScannedPart(waltz, part);
    expect(notes).toContainEqual(expect.stringMatching(/time signature differs .* bars 1, 2, 3 and 5 more/));
    expect(notes).toContainEqual(expect.stringMatching(/key differs/));
    expect(notes).toContainEqual(expect.stringMatching(/don't line up at bars 3 and 4/));
  });

  it("names a second part of the same instrument apart", () => {
    const trumpet = score(4, ["trumpet-bb"]);
    const { score: two } = addScannedPart(trumpet, score(4, ["trumpet-bb"]));
    expect(two.parts.map((p) => p.name)).toEqual([trumpet.parts[0]!.name, `${trumpet.parts[0]!.name} 2`]);
  });
});
