import { describe, expect, it } from "vitest";
import {
  analyzeHarmony,
  concertKeys,
  keyName,
  nameChord,
  newScore,
  openAiTools,
  parsePitch,
  printBars,
  runTool,
  SCORE_TOOLS,
  systemPrompt,
  type Score,
} from "../src";
import { load } from "./helpers";

const chord = (...names: string[]) => nameChord(names.map((n) => ({ pitch: parsePitch(n), weight: 1 })))?.name;

function run(score: Score, name: string, args: unknown) {
  return runTool(SCORE_TOOLS, name, args, score);
}

function ok(score: Score, name: string, args: unknown): Score {
  const r = run(score, name, args);
  if (r.error) throw new Error(r.result);
  return r.score ?? score;
}

describe("chords", () => {
  it("names common chords and inversions", () => {
    expect(chord("C4", "E4", "G4")).toBe("C");
    expect(chord("E3", "G4", "C5")).toBe("C/E");
    expect(chord("G3", "B3", "D4", "F4")).toBe("G7");
    expect(chord("A3", "C4", "E4")).toBe("Am");
    expect(chord("B3", "D4", "F4")).toBe("Bdim");
    expect(chord("Bb2", "D4", "F4", "Bb4")).toBe("Bb");
    expect(chord("C4", "E4", "Bb4")).toBe("C7");
    expect(chord("D4")).toBe("(D)");
    expect(nameChord([])).toBeNull();
  });

  it("analyses beats across parts", () => {
    const { score } = load("piano.musicxml");
    const segments = analyzeHarmony(score, 0, 0);
    expect(segments[0]!.chord?.name).toBe("F");
  });
});

describe("tools", () => {
  it("describes the score and reads bars", () => {
    const { score } = load("trumpet-part.musicxml");
    const overview = run(score, "get_overview", {}).result;
    expect(overview).toContain('P1 "1st Bb Trumpet": Trumpet in Bb (trumpet-bb)');
    expect(overview).toContain("sounds a major 2nd lower than written");
    expect(overview).toMatch(/Key \(concert pitch\): Bb major from bar 1/);
    const bars = run(score, "get_bars", { from: 1, to: 2, pitch: "written" }).result;
    expect(bars).toContain("# bar 1: time 4/4, key Bb major (concert)");
    expect(bars).toContain("bar 1: E5/2(accent,f) D5/4(marcato) r/4");
    expect(run(score, "get_bars", { from: 99 }).result).toMatch(/^Error: There is no bar 99/);
  });

  it("explains invalid arguments and unknown tools", () => {
    const score = newScore({ title: "T", parts: [{ instrument: "trumpet-bb" }], measures: 2 });
    expect(run(score, "shift_octave", { octaves: 9 }).result).toMatch(/invalid arguments for shift_octave[\s\S]*octaves/);
    expect(run(score, "make_it_good", {}).result).toMatch(/no tool "make_it_good"/);
    expect(run(score, "change_instrument", { part: "P7", instrument: "trumpet-c" }).result).toMatch(/No part "P7"\. The parts are P1/);
  });

  it("transposes to a key and rewrites a part for another instrument", () => {
    const { score } = load("trumpet-part.musicxml");
    const up = ok(score, "transpose", { to_key: "C major", direction: "up" });
    expect(keyName(concertKeys(up)[0]!)).toBe("C major");
    // The same music for a trumpet in C: written notes are now the concert notes.
    const c = run(score, "change_instrument", { part: "P1", instrument: "trumpet-c" });
    expect(c.summary).toBe("P1 is now Trumpet in C (was Trumpet in Bb, same sound)");
    expect(printBars(c.score!, 0, 0, 0, "written")).toEqual(["bar 1: D5/2(accent,f) C5/4(marcato) r/4"]);
    const clarinet = ok(score, "change_instrument", { part: 1, instrument: "Clarinet in Bb" });
    expect(printBars(clarinet, 0, 0, 0, "written")).toEqual(["bar 1: E5/2(accent,f) D5/4(marcato) r/4"]);
  });

  it("writes, copies and moves bars", () => {
    let score = newScore({ title: "T", parts: [{ instrument: "piano" }, { instrument: "trumpet-bb" }], measures: 4 });
    score = ok(score, "write_bars", { part: "P1", music: "bar 1 staff 1: [E4 G4 C5]/2 [F4 A4 D5]/2\nbar 1 staff 2: C3/1" });
    const failed = run(score, "write_bars", { part: "P1", music: "bar 2 staff 1: C5/4" });
    expect(failed.error).toBe(true);
    expect(failed.result).toMatch(/missing 3 beats.*Nothing was written/);
    score = ok(score, "copy_bars", { from_part: "P1", from: 1, to_part: "P2", notes: "top" });
    expect(printBars(score, 1, 0, 0, "written")).toEqual(["bar 1: D5/2 E5/2"]);
    score = ok(score, "copy_bars", { from_part: "P2", from: 1, at: 3, octaves: -1 });
    expect(printBars(score, 1, 2, 2)).toEqual(["bar 3: C4/2 D4/2"]);
    score = ok(score, "shift_octave", { parts: ["P2"], from: 3, octaves: 1 });
    expect(printBars(score, 1, 2, 2)).toEqual(["bar 3: C5/2 D5/2"]);
  });

  it("sets bar properties, marks and articulations", () => {
    let score = newScore({ title: "T", parts: [{ instrument: "trumpet-bb" }], measures: 4 });
    score = ok(score, "write_bars", { part: "P1", music: "bar 1: C5/4 D5/4 E5/4 F5/4\nbar 2: G5/1", pitch: "written" });
    score = ok(score, "set_bar_properties", { bar: 3, time: "3/4", key: "D major", key_for_part: "P1", tempo_bpm: 90, tempo_text: "Slower", rehearsal: "B" });
    expect(score.measures[2]).toMatchObject({ time: { beats: 3, beatType: 4 }, key: { fifths: 0 }, rehearsal: "B", tempo: { bpm: 90, text: "Slower" } });
    score = ok(score, "add_dynamics", { part: "P1", marks: [{ bar: 1, dynamic: "p" }, { bar: 1, beat: 3, dynamic: "f" }] });
    score = ok(score, "add_hairpin", { part: "P1", type: "crescendo", from_bar: 1, to_bar: 1, to_beat: 3 });
    score = ok(score, "add_text", { part: "P1", bar: 2, text: "solo" });
    score = ok(score, "set_articulation", { articulation: "staccato", from: 1, beats: [2, 4] });
    expect(printBars(score, 0, 0, 1, "written")).toEqual([
      "bar 1: C5/4(p,cresc) D5/4(staccato,hairpin-end) E5/4(f) F5/4(staccato)",
      'bar 2: G5/1(text="solo")',
    ]);
    expect(run(score, "add_dynamics", { part: "P1", marks: [{ bar: 1, beat: 5, dynamic: "p" }] }).result).toMatch(/Beat 5 is not in bar 1/);
  });

  it("expands a multi-bar rest", () => {
    const score = newScore({ title: "T", parts: [{ instrument: "trumpet-bb" }], measures: 3 });
    const result = run(score, "multi_bar_rest", { bar: 2, bars: 6 });
    expect(result.result).toBe("Done: bar 2 is now a 6-bar rest (bars 2–7). Later bars were renumbered.");
    expect(result.score!.measures).toHaveLength(8);
    const withNotes = ok(score, "write_bars", { part: "P1", music: "bar 1: C5/1" });
    expect(run(withNotes, "multi_bar_rest", { bar: 1, bars: 4 }).result).toMatch(/has notes/);
  });

  it("inserts and deletes bars", () => {
    let score = newScore({ title: "T", parts: [{ instrument: "trumpet-bb" }], measures: 4 });
    score = ok(score, "insert_bars", { after: 2, count: 2 });
    expect(score.measures).toHaveLength(6);
    score = ok(score, "delete_bars", { from: 1, to: 3 });
    expect(score.measures.map((m) => m.number)).toEqual(["1", "2", "3"]);
  });

  it("describes the tools as JSON schema for the API", () => {
    const specs = openAiTools(SCORE_TOOLS);
    expect(specs.map((s) => s.function.name)).toContain("write_bars");
    const text = JSON.stringify(specs);
    expect(text).not.toContain("$schema");
    expect(text).not.toContain("9007199254740991");
    const write = specs.find((s) => s.function.name === "write_bars")!.function.parameters as { required: string[] };
    expect(write.required).toEqual(["part", "music"]);
    expect(systemPrompt()).toContain("C4 is middle C");
  });
});
