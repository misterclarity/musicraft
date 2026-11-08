import { newScore, printBars, writeBars } from "@musicraft/score-core";
import { describe, expect, it } from "vitest";
import type { PageRecord } from "../lib/db";
import { applyFinding, describeSystem, extractJson, parseFindings } from "./proofread";
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
    const systems = pageSystems([page], 8);
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
    const text = describeSystem(score, pageSystems([page], 8)[0]!);
    expect(text).toContain("Recognised bars 1–4 (time 4/4, concert key Bb major)");
    expect(text).toContain('# P1 "Trumpet in Bb" (Trumpet in Bb, written key C major), written pitch:');
    expect(text).toContain("bar 1: E5/2 D5/4 r/4");
  });
});

describe("findings", () => {
  it("reads the model's JSON, keeping only valid findings inside the line", () => {
    const score = trumpetScore();
    const system = pageSystems([page], 8)[0]!;
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
    const system = pageSystems([page], 8)[0]!;
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
    const tempo = applyFinding(score, { id: "t", partIndex: 0, measureIndex: 0, kind: "tempo", problem: "", value: "Allegro quarter = 132" }).score;
    expect(tempo.measures[0]!.tempo).toMatchObject({ bpm: 132, text: "Allegro" });
  });

  it("explains answers that are not JSON", () => {
    expect(() => extractJson("All good!")).toThrow(/did not answer with JSON/);
    expect(() => extractJson('{"findings": [')).toThrow(/cut off/);
  });
});
