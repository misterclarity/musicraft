import { describe, expect, it } from "vitest";
import {
  add,
  arrangeForEnsemble,
  checkScore,
  extractLine,
  frac,
  newScore,
  parsePitch,
  phraseOctaveShifts,
  printBars,
  runTool,
  SCORE_TOOLS,
  soundingNotes,
  writeBars,
  type Fraction,
  type Score,
} from "../src";
import { load } from "./helpers";

const n = (pitch: string, start: [number, number], end: [number, number]) => ({ pitch: parsePitch(pitch), start: frac(...start), end: frac(...end) });

function pianoPiece(): Score {
  // C major: melody in the right hand over chords, a bass line in the left hand.
  const score = newScore({ title: "Piece", parts: [{ instrument: "piano" }], measures: 4 });
  return writeBars(
    score,
    0,
    [
      "bar 1 staff 1: [C4 E4 G4 E5]/2 [C4 F4 A4 F5]/2",
      "bar 1 staff 2: C3/2 F2/2",
      "bar 2 staff 1: [B3 D4 G4 D5]/2 [C4 E4 G4 C5]/2",
      "bar 2 staff 2: G2/2 C3/2",
      "bar 3 staff 1: E5/4 F5/4 G5/4 A5/4",
      "bar 3 staff 2: [C3 G3]/1",
      "bar 4 staff 1: [E4 G4 C5]/1",
      "bar 4 staff 2: C3/1",
    ].join("\n"),
  ).score;
}

describe("lines", () => {
  it("keeps a held top note while lower notes move", () => {
    const line = extractLine([n("E5", [0, 1], [1, 2]), n("C5", [0, 1], [1, 4]), n("D5", [1, 4], [1, 2]), n("F5", [1, 2], [1, 1])], "top");
    expect(line.map((s) => `${s.pitch.step}${s.pitch.octave}@${s.start.n}/${s.start.d}-${s.end.n}/${s.end.d}`)).toEqual(["E5@0/1-1/2", "F5@1/2-1/1"]);
  });

  it("chooses octave shifts per phrase, keeping them steady", () => {
    const range: [number, number] = [58, 77];
    expect(phraseOctaveShifts([[60, 64], [62], [], [65], [84, 86], [88]], range, 2)).toEqual([0, 0, 0, 0, -1, -1]);
  });
});

describe("arranging", () => {
  it("turns a piano piece into a brass quintet whose bars add up and whose parts fit", () => {
    const { score, report } = arrangeForEnsemble(pianoPiece(), { ensemble: "brass-quintet" });
    expect(score.parts.map((p) => p.instrument)).toEqual(["trumpet-bb", "trumpet-bb", "horn-f", "trombone", "tuba"]);
    expect(checkScore(score).filter((i) => i.code.startsWith("bar-") || i.code === "out-of-range")).toEqual([]);
    // Melody (concert) is the top line; the tuba takes the bass.
    expect(printBars(score, 0, 0, 3)).toEqual(["bar 1: E5/2 F5/2", "bar 2: D5/2 C5/2", "bar 3: E5/4 F5/4 G5/4 A5/4", "bar 4: C5/1(breath)"]);
    expect(printBars(score, 4, 0, 1)).toEqual(["bar 1: C3/2 F2/2", "bar 2: G2/2 C3/2"]);
    // All five parts together sound complete chords: C then F in bar 1, G then C in bar 2, C in bar 3.
    const classes = (bar: number, at: Fraction) => {
      const found = new Set<string>();
      for (const n of soundingNotes(score, bar, at, add(at, frac(1, 16)))) found.add(`${n.pitch.step}${n.pitch.alter ? (n.pitch.alter > 0 ? "#" : "b") : ""}`);
      return [...found].sort().join(" ");
    };
    expect(classes(0, frac(0))).toBe("C E G");
    expect(classes(0, frac(1, 2))).toBe("A C F");
    expect(classes(1, frac(0))).toBe("B D G");
    expect(classes(1, frac(1, 2))).toBe("C E G");
    // Passing notes in the melody don't change the chord under it.
    expect(printBars(score, 1, 2, 2)).toEqual(["bar 3: G4/1"]);
    expect(report[0]).toBe("Trumpet 1 in Bb plays the melody.");
    expect(report.join(" ")).toContain("Tuba plays the bass line");
  });

  it("can keep the source and arrange for a list of instruments", () => {
    const source = pianoPiece();
    const { score } = arrangeForEnsemble(source, { instruments: [{ instrument: "flute" }, { instrument: "clarinet-bb" }, { instrument: "bassoon" }], keepSource: true });
    expect(score.parts.map((p) => p.instrument)).toEqual(["flute", "clarinet-bb", "bassoon", "piano"]);
  });

  it("explains that a single line has nothing to harmonise", () => {
    const { score, report } = arrangeForEnsemble(load("trumpet-part.musicxml").score, { ensemble: "brass-trio" });
    expect(report.join(" ")).toMatch(/single line/);
    expect(printBars(score, 2, 0, 0)).toEqual(["bar 1: R(f)"]);
  });

  it("is available to the assistant", () => {
    const run = runTool(SCORE_TOOLS, "arrange", { ensemble: "brass-quartet" }, pianoPiece());
    expect(run.error).toBeUndefined();
    expect(run.result).toMatch(/^Arranged for Brass quartet\. Parts now: P1 "Trumpet 1 in Bb", P2 "Trumpet 2 in Bb", P3 "Horn in F", P4 "Trombone"\./);
    expect(run.score!.parts).toHaveLength(4);
  });
});
