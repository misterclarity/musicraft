import { newScore, printBars, writeBars } from "@musicraft/score-core";
import { describe, expect, it } from "vitest";
import type { PageRecord } from "../lib/db";
import { applyFinding, describeSystem, extractJson, findingBar, parseFindings, parseKeySignature, parseTimeSignature } from "./proofread";
import { pageSystems } from "./vision";

function trumpetScore() {
  const score = newScore({ title: "T", parts: [{ instrument: "trumpet-bb" }], measures: 8, key: { fifths: -2 } });
  return writeBars(score, 0, "bar 1: E5/2 D5/4 r/4\nbar 2: C5/1", "written").score;
}

const page: PageRecord = {
  projectId: "p",
  index: 0,
  name: "page 1",
  blob: new Blob(),
  width: 1000,
  height: 1400,
  layout: {
    staffs: [
      { x: 0.1, y: 0.1, width: 0.8, height: 0.05 },
      { x: 0.1, y: 0.3, width: 0.8, height: 0.05 },
    ],
    staffsPerSystem: 1,
    measureRange: [0, 7],
    systemStarts: [0, 4],
  },
};

describe("lines of music on the pages", () => {
  it("splits pages into systems with their bars and a padded box", () => {
    const systems = pageSystems([page], trumpetScore());
    expect(systems.map((s) => s.measures)).toEqual([
      [0, 3],
      [4, 7],
    ]);
    expect(systems[0]!.box.x).toBeCloseTo(0.08);
    expect(systems[0]!.box.y).toBeLessThan(0.1);
    expect(systems[0]!.box.height).toBeGreaterThan(0.05);
  });

  it("describes the recognised bars at written pitch", () => {
    const score = trumpetScore();
    const text = describeSystem(score, pageSystems([page], trumpetScore())[0]!);
    expect(text).toContain("Recognised bars 1–4: time 4/4, key signature C major (no sharps or flats).");
    expect(text).toContain('# P1 "Trumpet in Bb" (Trumpet in Bb, a transposing instrument), written pitch:');
    expect(text).toContain("bar 1: E5/2 D5/4 r/4");
  });

  it("tells the model about key and time changes inside the line", () => {
    let score = trumpetScore();
    score = { ...score, measures: score.measures.map((m, i) => (i === 2 ? { ...m, key: { fifths: -5, mode: "major" as const }, time: { beats: 12, beatType: 8 } } : m)) };
    const text = describeSystem(score, pageSystems([page], score)[0]!);
    expect(text).toContain("Bar 3: time signature changes to 12/8.");
    expect(text).toContain("Bar 3: key signature changes to Eb major (3 flats).");
  });
});

describe("findings", () => {
  it("reads the model's JSON, keeping only valid findings inside the line", () => {
    const score = trumpetScore();
    const system = pageSystems([page], trumpetScore())[0]!;
    const answer = extractJson(
      'Here you go:\n```json\n{"findings": [' +
        '{"part": "P1", "bar": "1", "problem": "the second note is F5", "fix": "bar 1: E5/2 F5/4 r/4"},' +
        '{"bar": 2, "problem": "should be a half note", "fix": "C5/2"},' +
        '{"bar": "7", "problem": "outside this line"}' +
        '], "missing": [{"part": "P1", "bar": 1, "beat": 1, "kind": "dynamic", "value": "mf"}, {"bar": 1, "kind": "colour", "value": "red"},],}\n```',
    );
    const findings = parseFindings(score, system, answer);
    expect(findings.map((f) => [f.kind, f.measureIndex, f.fix ?? f.value])).toEqual([
      ["notes", 0, "bar 1: E5/2 F5/4 r/4"],
      ["notes", 1, "bar 2: C5/2"],
      ["dynamic", 0, "mf"],
    ]);
  });

  it("applies fixes and missed markings, and refuses fixes that don't fit", () => {
    let score = trumpetScore();
    const system = pageSystems([page], trumpetScore())[0]!;
    const [fix, short, dynamic] = parseFindings(score, system, {
      findings: [
        { bar: 1, problem: "x", fix: "bar 1: E5/2 F5/4 r/4" },
        { bar: 2, problem: "y", fix: "bar 2: C5/2" },
      ],
      missing: [{ bar: 1, beat: 3, kind: "dynamic", value: "mf" }],
    });
    score = applyFinding(score, fix!).score;
    expect(() => applyFinding(score, short!)).toThrow(/missing 2 beats/);
    score = applyFinding(score, dynamic!).score;
    expect(printBars(score, 0, 0, 0, "written")).toEqual(["bar 1: E5/2 F5/4(mf) r/4"]);
    const tempo = applyFinding(score, { id: "t", partIndex: 0, measureIndex: 0, measureId: score.measures[0]!.id, kind: "tempo", problem: "", value: "Allegro quarter = 132" }).score;
    expect(tempo.measures[0]!.tempo).toMatchObject({ bpm: 132, text: "Allegro" });
  });

  it("reads multi-bar rests from the image and keeps later fixes on the right bar", () => {
    let score = trumpetScore();
    const [system] = pageSystems([page], score);
    // Bar 3 is a rest bar; bar 1 has notes, so a multi-bar rest there is ignored.
    const findings = parseFindings(score, system!, {
      findings: [{ bar: 4, problem: "the rest is a half note", fix: "bar 4: C5/2 r/2" }],
      missing: [
        { bar: 3, kind: "multirest", value: 7 },
        { bar: 1, kind: "multi-bar rest", value: "4" },
      ],
    });
    expect(findings.map((f) => [f.kind, f.measureIndex, f.fix ?? f.value])).toEqual([
      ["notes", 3, "bar 4: C5/2 r/2"],
      ["multirest", 2, "7"],
    ]);
    const [fix, rest] = findings;
    score = applyFinding(score, rest!).score;
    expect(score.measures).toHaveLength(14);
    // The old bar 4 is now bar 10: the fix goes there, not to the new bar 4.
    expect(findingBar(score, fix!)).toBe(9);
    score = applyFinding(score, fix!).score;
    expect(printBars(score, 0, 9, 9, "written")).toEqual(["bar 10: C5/2 r/2"]);
    expect(printBars(score, 0, 3, 3, "written")).toEqual(["bar 4: R"]);
  });

  it("explains answers that are not JSON", () => {
    expect(() => extractJson("All good!")).toThrow(/did not answer with JSON/);
    expect(() => extractJson('{"findings": [')).toThrow(/cut off/);
  });
});

describe("key and time signatures", () => {
  it("reads printed signatures the way models describe them", () => {
    expect(["3 flats", "three flats", "bbb", "-3", "Eb major", "E♭ Major", "C minor"].map(parseKeySignature)).toEqual([-3, -3, -3, -3, -3, -3, -3]);
    expect(["1 sharp", "one sharp", "#", "G major"].map(parseKeySignature)).toEqual([1, 1, 1, 1]);
    expect(["none", "no sharps or flats", "0", "C major"].map(parseKeySignature)).toEqual([0, 0, 0, 0]);
    expect(parseKeySignature("lots")).toBeUndefined();
    expect(parseTimeSignature("12/8")).toEqual({ beats: 12, beatType: 8 });
    expect(parseTimeSignature("C")).toEqual({ beats: 4, beatType: 4, symbol: "common" });
    expect(parseTimeSignature("cut")).toEqual({ beats: 2, beatType: 2, symbol: "cut" });
    expect(parseTimeSignature("7/7")).toBeUndefined();
  });

  it("finds a missed key signature and a misread time signature, and applies them first", () => {
    let score = trumpetScore();
    const [system] = pageSystems([page], score);
    const findings = parseFindings(score, system!, {
      findings: [{ bar: 2, problem: "the note is E flat", fix: "bar 2: Eb5/1" }],
      missing: [
        { bar: 1, kind: "key", value: "3 flats" },
        { bar: 1, kind: "time", value: "4/4" },
        { bar: 3, kind: "time", value: "3/4" },
        { bar: 1, kind: "key", value: "none" },
      ],
    });
    // The trumpet's written C major (concert Bb) is no change; 4/4 is no change either.
    expect(findings.map((f) => [f.kind, f.measureIndex, f.value ?? f.fix])).toEqual([
      ["key", 0, "-5"],
      ["time", 2, "3/4"],
      ["notes", 1, "bar 2: Eb5/1"],
    ]);
    expect(findings[0]!.problem).toContain("Key signature with 3 flats, read as no sharps or flats");
    score = applyFinding(score, findings[0]!).score;
    // Written E and B follow the new key; the printed notes of bar 1 were E5 D5.
    expect(printBars(score, 0, 0, 1, "written")).toEqual(["bar 1: Eb5/2 D5/4 r/4", "bar 2: C5/1"]);
    score = applyFinding(score, findings[1]!).score;
    expect(score.measures[2]!.time).toEqual({ beats: 3, beatType: 4 });
  });
});
