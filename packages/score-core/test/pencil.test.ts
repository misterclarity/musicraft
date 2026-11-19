import { describe, expect, it } from "vitest";
import {
  deleteMeasures,
  enterNote,
  exportMusicXml,
  hasPencilMark,
  newScore,
  nextRehearsalLetter,
  pencilMarks,
  removePencilMarks,
  setPencilMark,
  togglePencilMark,
  type Score,
} from "../src";

/** A violin part of 8 bars with a quarter-note C in bar 1. */
function violin(): { score: Score; partId: string; noteId: string } {
  let score = newScore({ title: "T", parts: [{ instrument: "violin" }], measures: 8 });
  const rest = score.parts[0]!.measures[0]!.voices[0]!.events[0]!.id;
  score = enterNote(score, rest, "C", { inputDuration: { type: "quarter", dots: 0 } }).score;
  return { score, partId: score.parts[0]!.id, noteId: rest };
}

describe("pencil marks", () => {
  it("writes, replaces and rubs out marks: one fingering per note, bowing up or down", () => {
    const { score, partId, noteId } = violin();
    const at = { measureId: score.measures[0]!.id, eventId: noteId };
    let s = setPencilMark(score, partId, { ...at, kind: "fingering", text: "3" });
    s = setPencilMark(s, partId, { ...at, kind: "fingering", text: " 1-2 " });
    expect(pencilMarks(s, s.parts[0]!).map((m) => [m.kind, m.text])).toEqual([["fingering", "1-2"]]);
    s = togglePencilMark(s, partId, at, "up-bow");
    s = togglePencilMark(s, partId, at, "down-bow");
    expect(hasPencilMark(s, partId, at, "up-bow")).toBeUndefined();
    expect(hasPencilMark(s, partId, at, "down-bow")).toBeDefined();
    s = togglePencilMark(s, partId, at, "down-bow");
    expect(hasPencilMark(s, partId, at, "down-bow")).toBeUndefined();
    // An empty fingering rubs it out; so does rubbing out the note's marks.
    expect(pencilMarks(setPencilMark(s, partId, { ...at, kind: "fingering", text: "" }), s.parts[0]!)).toEqual([]);
    s = togglePencilMark(s, partId, at, "breath");
    expect(removePencilMarks(s, partId, at).parts[0]!.pencil).toBeUndefined();
    // The score it started from is left alone.
    expect(score.parts[0]!.pencil).toBeUndefined();
  });

  it("drops the marks of bars and notes that are gone", () => {
    const { score, partId } = violin();
    let s = setPencilMark(score, partId, { measureId: score.measures[3]!.id, kind: "highlight" });
    s = setPencilMark(s, partId, { measureId: score.measures[5]!.id, kind: "text", text: "slower" });
    s = deleteMeasures(s, 3, 3);
    expect(pencilMarks(s, s.parts[0]!).map((m) => m.text)).toEqual(["slower"]);
    expect(pencilMarks(s, { ...s.parts[0]!, pencil: [{ id: "x", kind: "breath", measureId: s.measures[0]!.id, eventId: "gone" }] })).toEqual([]);
  });

  it("suggests the next rehearsal letter after the ones printed or pencilled before", () => {
    const { score, partId } = violin();
    expect(nextRehearsalLetter(score, partId, 4)).toBe("A");
    const printed = { ...score, measures: score.measures.map((m, i) => (i === 2 ? { ...m, rehearsal: "B" } : m)) };
    expect(nextRehearsalLetter(printed, partId, 4)).toBe("C");
    const pencilled = setPencilMark(printed, partId, { measureId: printed.measures[3]!.id, kind: "rehearsal", text: "Z" });
    expect(nextRehearsalLetter(pencilled, partId, 6)).toBe("AA");
  });

  it("are written in grey for the engraver when asked, and keep marked empty bars out of multi-bar rests", () => {
    const { score, partId, noteId } = violin();
    const bar = score.measures[0]!.id;
    let s = setPencilMark(score, partId, { measureId: bar, eventId: noteId, kind: "fingering", text: "3" });
    s = togglePencilMark(s, partId, { measureId: bar, eventId: noteId }, "up-bow");
    s = togglePencilMark(s, partId, { measureId: bar, eventId: noteId }, "breath");
    s = setPencilMark(s, partId, { measureId: bar, eventId: noteId, kind: "text", text: "dolce" });
    s = setPencilMark(s, partId, { measureId: s.measures[4]!.id, kind: "rehearsal", text: "B" });
    const xml = exportMusicXml(s, { pencil: true, multiRests: true });
    expect(xml).toContain('<fingering placement="above" color="#7c838c">3</fingering>');
    expect(xml).toContain('<up-bow color="#7c838c"/>');
    expect(xml).toContain('<breath-mark color="#7c838c"/>');
    expect(xml).toContain('<words color="#7c838c" font-style="italic">dolce</words>');
    expect(xml).toContain('<rehearsal color="#7c838c" enclosure="square">B</rehearsal>');
    // Bars 2–4 rest together; bar 5 has the letter, so 5–8 is a rest of its own.
    expect([...xml.matchAll(/<multiple-rest>(\d+)<\/multiple-rest>/g)].map((m) => m[1])).toEqual(["3", "4"]);
    const plain = exportMusicXml(s, { multiRests: true });
    expect(plain).not.toMatch(/fingering|up-bow|breath-mark|dolce|enclosure/);
    expect([...plain.matchAll(/<multiple-rest>(\d+)<\/multiple-rest>/g)].map((m) => m[1])).toEqual(["7"]);
  });
});
