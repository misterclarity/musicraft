import { describe, expect, it } from "vitest";
import { McnError, parseMcn, printBars, writeBars } from "../src/ai/notation";
import { formatPitch, newScore, type MusicEvent, type NoteEvent, type Score } from "../src";
import { load } from "./helpers";

/** Bar contents without ids, to compare scores structurally. */
function content(score: Score) {
  return JSON.parse(
    JSON.stringify(score.parts.map((p) => p.measures), (key, value) => (key === "id" ? undefined : value)),
  );
}

const firstVoice = (score: Score, bar: number, part = 0): MusicEvent[] => score.parts[part]!.measures[bar]!.voices[0]!.events;

describe("parsing", () => {
  it("reads notes, chords, rests, dots, ties, tuplets and marks", () => {
    const [line] = parseMcn("bar 12: Bb4/4. C5/8 [F4 A4 C5]/4~ 3:2{C5/8(staccato) D5/8 E5/8} r/16 F#5/16(accent,mf,slur)");
    expect(line!.bar).toBe("12");
    const ev = line!.events;
    expect(ev.map((e) => `${e.kind}:${e.duration.type}${".".repeat(e.duration.dots)}`)).toEqual([
      "note:quarter.",
      "note:eighth",
      "note:quarter",
      "note:eighth",
      "note:eighth",
      "note:eighth",
      "rest:16th",
      "note:16th",
    ]);
    expect(ev[2]!.notes.map((n) => [formatPitch(n.pitch), n.tie])).toEqual([
      ["F4", true],
      ["A4", true],
      ["C5", true],
    ]);
    expect(ev[3]!.duration.tuplet).toEqual({ actual: 3, normal: 2 });
    expect(ev[6]!.duration.tuplet).toBeUndefined();
    expect(ev[7]!.articulations).toEqual(["accent"]);
    expect(ev[7]!.dynamic).toBe("mf");
    expect(ev[7]!.slurStart).toBe(true);
  });

  it("accepts staff and voice, whole-bar rests, comments and unicode accidentals", () => {
    const lines = parseMcn("# P2 Piano\nbar 3 staff 2: R\nbar 3 staff 1 voice 2: E♭4/2 r/2\n\nbar 4: c♯5/1");
    expect(lines.map((l) => [l.bar, l.staff, l.voice, l.events[0]!.kind])).toEqual([
      ["3", 2, 1, "barRest"],
      ["3", 1, 2, "note"],
      ["4", 1, 1, "note"],
    ]);
    expect(formatPitch(lines[1]!.events[0]!.notes[0]!.pitch)).toBe("Eb4");
    expect(formatPitch(lines[2]!.events[0]!.notes[0]!.pitch)).toBe("C#5");
  });

  it("explains mistakes", () => {
    expect(() => parseMcn("bar 1: C5 D5/4")).toThrow(/C5.*needs a length, e\.g\. C5\/4/);
    expect(() => parseMcn("bar 1: C/4")).toThrow(/needs an octave/);
    expect(() => parseMcn("bar 1: C5/4(loud)")).toThrow(/unknown mark "loud"/);
    expect(() => parseMcn("bar 1: C5/4 R")).toThrow(/must be the only thing/);
    expect(() => parseMcn("bar 1: 3:2{C5/8 D5/8")).toThrow(/not closed/);
    expect(() => parseMcn("C5/4 D5/4")).toThrow(/expected "bar <number>: <notes>"/);
    expect(() => parseMcn("bar 1: C5/3")).toThrow(McnError);
    expect(() => parseMcn("bar 1: 3:2{C5/8 D5/8 E5/8}(staccato) r/2")).toThrow(/Marks go right after a note's length/);
    expect(() => parseMcn("bar 1: C5/4\nbar 1: D5/4")).toThrow(/twice/);
  });
});

describe("printing and writing", () => {
  it("prints written or concert pitch", () => {
    const { score } = load("trumpet-part.musicxml");
    expect(printBars(score, 0, 0, 0, "written")).toEqual(["bar 1: E5/2(accent,f) D5/4(marcato) r/4"]);
    expect(printBars(score, 0, 0, 0, "concert")).toEqual(["bar 1: D5/2(accent,f) C5/4(marcato) r/4"]);
    expect(printBars(score, 0, 2, 2, "written")).toEqual(["bar 3: 3:2{Eb5/8 F5/8 G5/8} Ab5/4 r/2"]);
  });

  it("numbers voices by their order on each staff", () => {
    const { score } = load("piano.musicxml");
    const lines = printBars(score, 0, 0, 0);
    expect(lines[0]).toMatch(/^bar 1 staff 1: \[F4 A4 C5\]\/4\(p\)/);
    expect(lines).toContain("bar 1 staff 1 voice 2: C4/2");
    expect(lines).toContain("bar 1 staff 2: F2/2.");
  });

  it("round-trips every bar of the fixtures", () => {
    for (const name of ["trumpet-part.musicxml", "piano.musicxml"]) {
      const { score } = load(name);
      for (const frame of ["written", "concert"] as const) {
        const text = printBars(score, 0, 0, score.measures.length - 1, frame).join("\n");
        const { score: rewritten } = writeBars(score, 0, text, frame);
        expect(printBars(rewritten, 0, 0, score.measures.length - 1, frame).join("\n")).toBe(text);
        expect(content(rewritten)).toEqual(content(score));
      }
    }
  });

  it("stores written input as concert pitch", () => {
    const score = newScore({ title: "T", parts: [{ instrument: "trumpet-bb" }], measures: 2 });
    const { score: next, measures } = writeBars(score, 0, "bar 1: D5/2~ D5/2\nbar 2: [C5 E5]/1", "written");
    expect(measures).toEqual([0, 1]);
    const bar1 = firstVoice(next, 0) as NoteEvent[];
    expect(bar1.map((e) => formatPitch(e.notes[0]!.pitch))).toEqual(["C5", "C5"]);
    expect(bar1[0]!.notes[0]!.tie).toEqual({ start: true });
    expect(bar1[1]!.notes[0]!.tie).toEqual({ stop: true });
    expect((firstVoice(next, 1)[0] as NoteEvent).notes.map((n) => formatPitch(n.pitch))).toEqual(["Bb4", "D5"]);
  });

  it("refuses bars that don't add up and bars that don't exist", () => {
    const score = newScore({ title: "T", parts: [{ instrument: "trumpet-bb" }], measures: 2, time: { beats: 3, beatType: 4 } });
    expect(() => writeBars(score, 0, "bar 1: C5/2")).toThrow(/add up to 2 beats but 3\/4 needs 3 beats \(missing 1 beat\)/);
    expect(() => writeBars(score, 0, "bar 1: C5/2 D5/2")).toThrow(/too much by 1 beat/);
    expect(() => writeBars(score, 0, "bar 9: R")).toThrow(/no bar 9\. Bars are numbered 1–2/);
    expect(() => writeBars(score, 0, "bar 1 staff 2: R")).toThrow(/one staff/);
  });

  it("turns marks into dynamics, hairpins and text", () => {
    const score = newScore({ title: "T", parts: [{ instrument: "trumpet-bb" }], measures: 2 });
    const { score: next } = writeBars(score, 0, 'bar 1: C5/4(p,cresc) D5/4 E5/4 F5/4(hairpin-end,text="solo")');
    const dirs = next.parts[0]!.measures[0]!.directions!.map((d) => {
      const what = d.kind === "dynamic" ? d.value : d.kind === "words" ? d.text : d.type;
      return `${d.kind}:${what}@${d.offset.n}/${d.offset.d}`;
    });
    expect(dirs).toEqual(["dynamic:p@0/1", "wedge:crescendo@0/1", "words:solo@3/4", "wedge:stop@1/1"]);
    // And they print back the same way.
    expect(printBars(next, 0, 0, 0)).toEqual(['bar 1: C5/4(p,cresc) D5/4 E5/4 F5/4(hairpin-end,text="solo")']);
  });

  it("adds and removes second voices", () => {
    const score = newScore({ title: "T", parts: [{ instrument: "piano" }], measures: 1 });
    let next = writeBars(score, 0, "bar 1 staff 1: E5/1\nbar 1 staff 1 voice 2: C5/2 r/2").score;
    expect(printBars(next, 0, 0, 0)).toEqual(["bar 1 staff 1: E5/1", "bar 1 staff 1 voice 2: C5/2 r/2", "bar 1 staff 2: R"]);
    next = writeBars(next, 0, "bar 1 staff 1 voice 2: R").score;
    expect(printBars(next, 0, 0, 0)).toEqual(["bar 1 staff 1: E5/1", "bar 1 staff 2: R"]);
  });
});
