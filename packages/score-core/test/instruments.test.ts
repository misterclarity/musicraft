import { describe, expect, it } from "vitest";
import { ENSEMBLES, getInstrument, INSTRUMENTS, matchInstrument, midiNumber, parseInterval, prettyName } from "../src";

describe("instrument catalog", () => {
  it("has consistent ranges and clefs", () => {
    for (const i of INSTRUMENTS) {
      expect(midiNumber(i.range.low), i.id).toBeLessThan(midiNumber(i.range.high));
      expect(midiNumber(i.comfortable.low), i.id).toBeGreaterThanOrEqual(midiNumber(i.range.low));
      expect(midiNumber(i.comfortable.high), i.id).toBeLessThanOrEqual(midiNumber(i.range.high));
      expect(i.clefs.length, i.id).toBe(i.staves);
      expect(i.midiProgram, i.id).toBeGreaterThanOrEqual(0);
      expect(i.midiProgram, i.id).toBeLessThan(128);
    }
    expect(new Set(INSTRUMENTS.map((i) => i.id)).size).toBe(INSTRUMENTS.length);
  });

  it("transposes the usual instruments correctly", () => {
    expect(getInstrument("trumpet-bb").transposition).toEqual(parseInterval("-M2"));
    expect(getInstrument("clarinet-bb").transposition).toEqual(parseInterval("-M2"));
    expect(getInstrument("horn-f").transposition).toEqual(parseInterval("-P5"));
    expect(getInstrument("alto-sax").transposition).toEqual(parseInterval("-M6"));
    expect(getInstrument("tenor-sax").transposition).toEqual(parseInterval("-M9"));
    expect(getInstrument("trumpet-c").transposition).toEqual({ diatonic: 0, chromatic: 0 });
  });

  it("recognises instruments from part names", () => {
    const id = (name: string) => matchInstrument(name)?.id;
    expect(id("1st Bb TRUMPET")).toBe("trumpet-bb");
    expect(id("Trumpet in B♭ 2")).toBe("trumpet-bb");
    expect(id("Trumpet in C")).toBe("trumpet-c");
    expect(id("Pno.")).toBe("piano");
    expect(id("Piano")).toBe("piano");
    expect(id("Clarinet in A")).toBe("clarinet-a");
    expect(id("Bb Clarinet")).toBe("clarinet-bb");
    expect(id("Alto Saxophone")).toBe("alto-sax");
    expect(id("Baritone Sax")).toBe("baritone-sax");
    expect(id("Baritone")).toBe("baritone-tc");
    expect(id("Horn in F")).toBe("horn-f");
    expect(id("Violoncello")).toBe("cello");
    expect(id("Bass Trombone")).toBe("bass-trombone");
    expect(id("Something else")).toBeUndefined();
  });

  it("uses the transposition to break ties", () => {
    expect(matchInstrument("Trumpet", parseInterval("-M2"))?.id).toBe("trumpet-bb");
    expect(matchInstrument("Trumpet", { diatonic: 0, chromatic: 0 })?.id).toBe("trumpet-c");
  });

  it("has brass ensemble templates built from known instruments", () => {
    const quintet = ENSEMBLES.find((e) => e.id === "brass-quintet")!;
    expect(quintet.parts.map((p) => p.instrument)).toEqual(["trumpet-bb", "trumpet-bb", "horn-f", "trombone", "tuba"]);
    for (const e of ENSEMBLES) for (const p of e.parts) expect(getInstrument(p.instrument).id).toBe(p.instrument);
  });

  it("formats names for display", () => {
    expect(prettyName("Trumpet in Bb")).toBe("Trumpet in B♭");
    expect(prettyName("Clarinet in Eb")).toBe("Clarinet in E♭");
    expect(prettyName("Bassoon")).toBe("Bassoon");
  });
});
