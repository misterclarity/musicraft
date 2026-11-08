import { describe, expect, it } from "vitest";
import {
  add,
  cmp,
  durationFromValue,
  durationValue,
  formatPitch,
  frac,
  intervalBetween,
  intervalFifths,
  intervalName,
  keyAlterations,
  keyName,
  midiNumber,
  parseInterval,
  parseKey,
  parsePitch,
  splitValue,
  sub,
  transposeKey,
  transposePitch,
} from "../src";

describe("fractions", () => {
  it("reduce and compare", () => {
    expect(frac(2, 4)).toEqual({ n: 1, d: 2 });
    expect(frac(3, -6)).toEqual({ n: -1, d: 2 });
    expect(add(frac(1, 4), frac(1, 8))).toEqual(frac(3, 8));
    expect(sub(frac(1, 4), frac(1, 3))).toEqual(frac(-1, 12));
    expect(cmp(frac(1, 3), frac(2, 6))).toBe(0);
    expect(() => frac(1, 0)).toThrow();
  });
});

describe("pitches", () => {
  it("parse and format", () => {
    expect(parsePitch("C4")).toEqual({ step: "C", alter: 0, octave: 4 });
    expect(parsePitch("f#5")).toEqual({ step: "F", alter: 1, octave: 5 });
    expect(parsePitch("Bb3")).toEqual({ step: "B", alter: -1, octave: 3 });
    expect(parsePitch("E♭4")).toEqual({ step: "E", alter: -1, octave: 4 });
    expect(formatPitch(parsePitch("Ebb2"))).toBe("Ebb2");
    expect(() => parsePitch("H4")).toThrow();
  });

  it("MIDI numbers", () => {
    expect(midiNumber(parsePitch("C4"))).toBe(60);
    expect(midiNumber(parsePitch("A4"))).toBe(69);
    expect(midiNumber(parsePitch("Cb4"))).toBe(59);
    expect(midiNumber(parsePitch("B#3"))).toBe(60);
  });

  it("transposes with correct spelling", () => {
    const up = (p: string, iv: string) => formatPitch(transposePitch(parsePitch(p), parseInterval(iv)));
    expect(up("C5", "-M2")).toBe("Bb4");
    expect(up("F#4", "M2")).toBe("G#4");
    expect(up("Bb4", "M2")).toBe("C5");
    expect(up("D5", "-P5")).toBe("G4");
    expect(up("E4", "M9")).toBe("F#5");
    expect(up("C4", "-M13")).toBe("Eb2");
    expect(up("B3", "d3")).toBe("Db4");
  });

  it("parses and names intervals", () => {
    for (const name of ["P1", "M2", "m3", "P4", "A4", "d5", "P5", "m6", "M7", "P8", "M9", "-M2", "-P5", "M13", "AA1"]) {
      expect(intervalName(parseInterval(name))).toBe(name);
    }
    expect(parseInterval("M2")).toEqual({ diatonic: 1, chromatic: 2 });
    expect(parseInterval("-P5")).toEqual({ diatonic: -4, chromatic: -7 });
    expect(intervalBetween(parsePitch("C4"), parsePitch("E5"))).toEqual(parseInterval("M10"));
    expect(() => parseInterval("P3")).toThrow();
    expect(() => parseInterval("M5")).toThrow();
  });

  it("measures intervals on the circle of fifths", () => {
    expect(intervalFifths(parseInterval("P5"))).toBe(1);
    expect(intervalFifths(parseInterval("M2"))).toBe(2);
    expect(intervalFifths(parseInterval("m3"))).toBe(-3);
    expect(intervalFifths(parseInterval("P8"))).toBe(0);
  });
});

describe("keys", () => {
  it("names and parses keys", () => {
    expect(keyName({ fifths: -2 })).toBe("Bb major");
    expect(keyName({ fifths: 3, mode: "minor" })).toBe("F# minor");
    expect(parseKey("Eb major")).toEqual({ fifths: -3, mode: "major" });
    expect(parseKey("c minor")).toEqual({ fifths: -3, mode: "minor" });
    expect(parseKey("F#m")).toEqual({ fifths: 3, mode: "minor" });
  });

  it("knows the alterations of a key", () => {
    expect(keyAlterations(2)).toEqual({ C: 1, D: 0, E: 0, F: 1, G: 0, A: 0, B: 0 });
    expect(keyAlterations(-3)).toEqual({ C: 0, D: 0, E: -1, F: 0, G: 0, A: -1, B: -1 });
  });

  it("respells extreme keys when transposing", () => {
    // B major for a Bb instrument: written C# major (7 sharps) becomes Db major (5 flats).
    const result = transposeKey({ fifths: 5 }, parseInterval("M2"));
    expect(result.key.fifths).toBe(-5);
    expect(formatPitch(transposePitch(parsePitch("B3"), result.interval))).toBe("Db4");
    // E major → F# major stays (6 sharps is fine).
    expect(transposeKey({ fifths: 4 }, parseInterval("M2")).key.fifths).toBe(6);
    // Concert C for a Bb trumpet → written D major.
    expect(transposeKey({ fifths: 0 }, parseInterval("M2")).key.fifths).toBe(2);
  });
});

describe("durations", () => {
  it("values with dots and tuplets", () => {
    expect(durationValue({ type: "quarter", dots: 1 })).toEqual(frac(3, 8));
    expect(durationValue({ type: "half", dots: 2 })).toEqual(frac(7, 8));
    expect(durationValue({ type: "eighth", dots: 0, tuplet: { actual: 3, normal: 2 } })).toEqual(frac(1, 12));
  });

  it("finds a single note for a value", () => {
    expect(durationFromValue(frac(3, 8))).toEqual({ type: "quarter", dots: 1 });
    expect(durationFromValue(frac(5, 8))).toBeUndefined();
  });

  it("splits awkward values into tied notes", () => {
    expect(splitValue(frac(5, 8))).toEqual([
      { type: "half", dots: 0 },
      { type: "eighth", dots: 0 },
    ]);
    const triplet = splitValue(frac(1, 12));
    expect(triplet).toHaveLength(1);
    expect(triplet[0]!.tuplet).toEqual({ actual: 3, normal: 2 });
  });
});

describe("key to key", () => {
  it("finds the interval between key tonics", async () => {
    const { intervalToKey, intervalName, keyTonic } = await import("../src");
    expect(keyTonic({ fifths: -2 })).toEqual({ step: "B", alter: -1 });
    expect(keyTonic({ fifths: 3, mode: "minor" })).toEqual({ step: "F", alter: 1 });
    expect(intervalName(intervalToKey({ fifths: -2 }, { fifths: 0 }))).toBe("M2");
    expect(intervalName(intervalToKey({ fifths: 0 }, { fifths: -2 }))).toBe("-M2");
    expect(intervalName(intervalToKey({ fifths: 0 }, { fifths: -2 }, "up"))).toBe("m7");
    expect(intervalName(intervalToKey({ fifths: 0 }, { fifths: 1 }, "down"))).toBe("-P4");
  });
});
