import { describe, expect, it } from "vitest";
import {
  addChordNote,
  alterNotes,
  checkScore,
  copyMeasures,
  deleteMeasures,
  deleteNotes,
  enterNote,
  formatPitch,
  insertMeasures,
  moveNotes,
  newScore,
  parsePitch,
  pasteMeasures,
  respellNotes,
  setDuration,
  setDurations,
  setDynamic,
  setTempo,
  shownPitch,
  toggleArticulation,
  toggleDot,
  toggleDots,
  toggleTie,
  toggleTies,
  type MusicEvent,
  type NoteEvent,
  type Score,
} from "../src";

function trumpet(): Score {
  // Concert Bb major (written C major for the Bb trumpet), 4/4, 4 bars of rests.
  return newScore({ title: "T", parts: [{ instrument: "trumpet-bb" }], measures: 4, key: { fifths: -2 } });
}

const events = (score: Score, bar = 0): MusicEvent[] => score.parts[0]!.measures[bar]!.voices[0]!.events;
const describe1 = (e: MusicEvent) =>
  e.kind === "note" ? `${e.notes.map((n) => formatPitch(n.pitch)).join("+")}/${e.duration.type}${".".repeat(e.duration.dots)}` : `r/${e.measureRest ? "bar" : e.duration.type + ".".repeat(e.duration.dots)}`;
const shape = (score: Score, bar = 0) => events(score, bar).map(describe1);

describe("entering notes", () => {
  it("types written notes on a Bb trumpet part and stores concert pitch", () => {
    let score = trumpet();
    const restId = events(score)[0]!.id;
    const { score: s1, nextEventId } = enterNote(score, restId, "D", { inputDuration: { type: "quarter", dots: 0 } });
    // Written D5 (nearest to the default B4) sounds C5.
    expect(shape(s1)).toEqual(["C5/quarter", "r/half.", ]);
    expect(shownPitch(s1, restId, "written").map(formatPitch)).toEqual(["D5"]);
    expect(nextEventId).toBe(events(s1)[1]!.id);
    // Enter E on the next rest: nearest E to the previous D5 is E5.
    score = enterNote(s1, nextEventId!, "E").score;
    expect(shownPitch(score, events(score)[1]!.id, "written").map(formatPitch)).toEqual(["E5"]);
    expect(checkScore(score, { comfortableRange: false })).toEqual([]);
  });

  it("uses concert pitch when the view is concert", () => {
    const score = trumpet();
    const { score: s1 } = enterNote(score, events(score)[0]!.id, "C", { view: "concert" });
    expect(formatPitch((events(s1)[0] as NoteEvent).notes[0]!.pitch)).toBe("C5");
  });

  it("moves, alters, respells and stacks notes", () => {
    let score = trumpet();
    const id = events(score)[0]!.id;
    score = enterNote(score, id, "C").score; // written C5
    score = moveNotes(score, [id], { semitones: 1 });
    expect(shownPitch(score, id, "written").map(formatPitch)).toEqual(["C#5"]);
    score = respellNotes(score, [id]);
    expect(shownPitch(score, id, "written").map(formatPitch)).toEqual(["Db5"]);
    score = alterNotes(score, [id], 1);
    expect(shownPitch(score, id, "written").map(formatPitch)).toEqual(["D5"]);
    score = moveNotes(score, [id], { steps: -1 });
    expect(shownPitch(score, id, "written").map(formatPitch)).toEqual(["C5"]);
    score = moveNotes(score, [id], { octaves: -1 });
    expect(shownPitch(score, id, "written").map(formatPitch)).toEqual(["C4"]);
    score = addChordNote(score, id, 2);
    score = addChordNote(score, id, 2);
    expect(shownPitch(score, id, "written").map(formatPitch)).toEqual(["C4", "E4", "G4"]);
  });
});

describe("durations", () => {
  function bar(): Score {
    let score = trumpet();
    let id: string | undefined = events(score)[0]!.id;
    for (const step of ["C", "D", "E", "F"] as const) {
      const result = enterNote(score, id!, step, { inputDuration: { type: "quarter", dots: 0 } });
      score = result.score;
      id = result.nextEventId;
    }
    return score;
  }

  it("shortening leaves rests", () => {
    const score = bar();
    const shorter = setDuration(score, events(score)[0]!.id, { type: "eighth", dots: 0 });
    expect(shape(shorter)).toEqual(["Bb4/eighth", "r/eighth", "C5/quarter", "D5/quarter", "Eb5/quarter"]);
  });

  it("lengthening overwrites what follows and never crosses the barline", () => {
    const score = bar();
    const longer = setDuration(score, events(score)[0]!.id, { type: "half", dots: 1 });
    expect(shape(longer)).toEqual(["Bb4/half.", "Eb5/quarter"]);
    const tooLong = setDuration(score, events(score)[3]!.id, { type: "whole", dots: 0 });
    expect(shape(tooLong)).toEqual(["Bb4/quarter", "C5/quarter", "D5/quarter", "Eb5/quarter"]);
    const dotted = toggleDot(score, events(score)[1]!.id);
    expect(shape(dotted)).toEqual(["Bb4/quarter", "C5/quarter.", "r/eighth", "Eb5/quarter"]);
    // Nothing changes (same object, so no undo step) when the length stays the same.
    expect(setDuration(score, events(score)[3]!.id, { type: "half", dots: 0 })).toBe(score);
  });

  it("deleting turns notes into rests and an empty bar into a bar rest", () => {
    const score = bar();
    const fewer = deleteNotes(score, [events(score)[1]!.id]);
    expect(shape(fewer)).toEqual(["Bb4/quarter", "r/quarter", "D5/quarter", "Eb5/quarter"]);
    const none = deleteNotes(score, events(score).map((e) => e.id));
    expect(shape(none)).toEqual(["r/bar"]);
  });
});

describe("marks", () => {
  it("ties equal notes and refuses ties to other notes", () => {
    let score = trumpet();
    let id: string | undefined = events(score)[0]!.id;
    for (const step of ["C", "C", "D", "D"] as const) {
      const result = enterNote(score, id!, step, { inputDuration: { type: "quarter", dots: 0 } });
      score = result.score;
      id = result.nextEventId;
    }
    const tied = toggleTie(score, events(score)[0]!.id);
    expect((events(tied)[0] as NoteEvent).notes[0]!.tie).toEqual({ start: true });
    expect((events(tied)[1] as NoteEvent).notes[0]!.tie).toEqual({ stop: true });
    const untied = toggleTie(tied, events(tied)[0]!.id);
    expect((events(untied)[0] as NoteEvent).notes[0]!.tie).toBeUndefined();
    expect(() => toggleTie(score, events(score)[1]!.id)).toThrow("same note");
  });

  it("toggles articulations and places dynamics at the note", () => {
    let score = trumpet();
    const id = events(score)[0]!.id;
    score = enterNote(score, id, "G", { inputDuration: { type: "half", dots: 0 } }).score;
    const next = events(score)[1]!.id;
    score = enterNote(score, next, "A").score;
    score = toggleArticulation(score, [id], "accent");
    score = toggleArticulation(score, [id], "marcato");
    expect((events(score)[0] as NoteEvent).articulations).toEqual(["marcato"]);
    score = toggleArticulation(score, [id], "marcato");
    expect((events(score)[0] as NoteEvent).articulations).toBeUndefined();
    score = setDynamic(score, next, "mf");
    const directions = score.parts[0]!.measures[0]!.directions!;
    expect(directions).toEqual([expect.objectContaining({ kind: "dynamic", value: "mf", offset: { n: 1, d: 2 } })]);
    expect(setDynamic(score, next, null).parts[0]!.measures[0]!.directions).toBeUndefined();
  });
});

describe("bars", () => {
  it("inserts and deletes bars keeping the opening signatures", () => {
    let score = trumpet();
    score = insertMeasures(score, 0, 2);
    expect(score.measures).toHaveLength(6);
    expect(score.measures[0]!.time).toEqual({ beats: 4, beatType: 4 });
    expect(score.measures[0]!.key).toEqual({ fifths: -2 });
    expect(score.measures[2]!.time).toBeUndefined();
    expect(score.measures.map((m) => m.number)).toEqual(["1", "2", "3", "4", "5", "6"]);
    score = deleteMeasures(score, 0, 1);
    expect(score.measures).toHaveLength(4);
    expect(score.measures[0]!.time).toEqual({ beats: 4, beatType: 4 });
    expect(score.measures[3]!.barline).toBe("final");
    expect(() => deleteMeasures(score, 0, 3)).toThrow();
  });

  it("copies and pastes bars with fresh ids", () => {
    let score = trumpet();
    score = enterNote(score, events(score)[0]!.id, "G").score;
    const clip = copyMeasures(score, 0, 0);
    const pasted = pasteMeasures(score, clip, 2, [score.parts[0]!.id]);
    expect(shape(pasted, 2)).toEqual(shape(pasted, 0));
    expect(events(pasted, 2)[0]!.id).not.toBe(events(pasted, 0)[0]!.id);
    // Pasting past the end adds bars.
    expect(pasteMeasures(score, clip, 4, [score.parts[0]!.id]).measures).toHaveLength(5);
  });

  it("works with written pitch on a grand staff too", () => {
    let score = newScore({ title: "P", parts: [{ instrument: "piano" }], measures: 1 });
    const bassRest = score.parts[0]!.measures[0]!.voices.find((v) => v.staff === 2)!.events[0]!.id;
    score = enterNote(score, bassRest, "C").score;
    const bass = score.parts[0]!.measures[0]!.voices.find((v) => v.staff === 2)!.events[0] as NoteEvent;
    // Nearest C to the bass-clef default D3 is C3.
    expect(formatPitch(bass.notes[0]!.pitch)).toBe("C3");
    expect(parsePitch("C3")).toEqual(bass.notes[0]!.pitch);
  });
});

describe("edits on several notes and ties", () => {
  function fourQuarters(): Score {
    let score = trumpet();
    let id: string | undefined = events(score)[0]!.id;
    for (const step of ["C", "D", "E", "F"] as const) {
      const result = enterNote(score, id!, step, { inputDuration: { type: "quarter", dots: 0 } });
      score = result.score;
      id = result.nextEventId;
    }
    return score;
  }

  it("lengthens or dots several selected notes even when one swallows the next", () => {
    const score = fourQuarters();
    const ids = events(score).slice(0, 2).map((e) => e.id);
    // The first note grows over the second, which is then skipped instead of failing the edit.
    expect(shape(setDurations(score, ids, { type: "half", dots: 0 }))).toEqual(["Bb4/half", "D5/quarter", "Eb5/quarter"]);
    expect(shape(toggleDots(score, ids))).toEqual(["Bb4/quarter.", "r/eighth", "D5/quarter", "Eb5/quarter"]);
  });

  it("ties the notes that can be tied and skips the others", () => {
    let score = trumpet();
    let id: string | undefined = events(score)[0]!.id;
    for (const step of ["C", "C", "D", "E"] as const) {
      const result = enterNote(score, id!, step, { inputDuration: { type: "quarter", dots: 0 } });
      score = result.score;
      id = result.nextEventId;
    }
    const tied = toggleTies(score, events(score).map((e) => e.id));
    expect((events(tied)[0] as NoteEvent).notes[0]!.tie).toEqual({ start: true });
    expect((events(tied)[1] as NoteEvent).notes[0]!.tie).toEqual({ stop: true });
    expect(() => toggleTies(score, [events(score)[3]!.id])).toThrow("same note");
  });

  it("removes both ends of a tie when one note moves, and keeps it when both move", () => {
    const start = trumpet();
    let entry = enterNote(start, events(start)[0]!.id, "C", { inputDuration: { type: "half", dots: 0 } });
    entry = enterNote(entry.score, entry.nextEventId!, "C");
    const score = toggleTie(entry.score, events(entry.score)[0]!.id);
    const [first, second] = events(score) as NoteEvent[];
    expect(first!.notes[0]!.tie).toEqual({ start: true });
    const moved = moveNotes(score, [second!.id], { semitones: 1 });
    expect((events(moved)[0] as NoteEvent).notes[0]!.tie).toBeUndefined();
    expect((events(moved)[1] as NoteEvent).notes[0]!.tie).toBeUndefined();
    expect(checkScore(moved).filter((i) => i.code === "tie-mismatch")).toEqual([]);
    const both = moveNotes(score, [first!.id, second!.id], { octaves: -1 });
    expect((events(both)[0] as NoteEvent).notes[0]!.tie).toEqual({ start: true });
    expect((events(both)[1] as NoteEvent).notes[0]!.tie).toEqual({ stop: true });
    const deleted = deleteNotes(score, [second!.id]);
    expect((events(deleted)[0] as NoteEvent).notes[0]!.tie).toBeUndefined();
  });
});

describe("deleting bars", () => {
  it("keeps the final barline when the last bars go, and the opening tempo when the first bar goes", () => {
    let score = trumpet();
    expect(score.measures[3]!.barline).toBe("final");
    const shorter = deleteMeasures(score, 2, 3);
    expect(shorter.measures.map((m) => m.barline)).toEqual([undefined, "final"]);
    score = setTempo(score, 0, { bpm: 72, beatUnit: "quarter" });
    expect(deleteMeasures(score, 0, 0).measures[0]!.tempo).toEqual({ bpm: 72, beatUnit: "quarter" });
    // A tempo change inside the deleted bars still applies after them.
    score = setTempo(score, 1, { bpm: 132, beatUnit: "quarter" });
    expect(deleteMeasures(score, 1, 1).measures[1]!.tempo).toEqual({ bpm: 132, beatUnit: "quarter" });
  });
});
