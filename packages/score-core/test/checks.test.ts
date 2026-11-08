import { describe, expect, it } from "vitest";
import { buildPerformance, checkScore, describeBeats, exportMidi, frac, playbackOrder, type MeasureInfo } from "../src";
import { importText, load } from "./helpers";

const part = (bars: string, name = "Trumpet in Bb", time = "<time><beats>4</beats><beat-type>4</beat-type></time>") => `<?xml version="1.0"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>${name}</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>4</divisions><key><fifths>0</fifths></key>${time}<clef><sign>G</sign><line>2</line></clef></attributes>
${bars}</part></score-partwise>`;

const note = (step: string, octave: number, divs: number, type: string) =>
  `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${divs}</duration><type>${type}</type></note>`;

describe("checks", () => {
  it("reports bars that don't add up", () => {
    const bars =
      `${note("C", 5, 16, "whole")}</measure>` +
      `<measure number="2">${note("C", 5, 4, "quarter")}${note("D", 5, 4, "quarter")}${note("E", 5, 4, "quarter")}</measure>` +
      `<measure number="3">${note("C", 5, 16, "whole")}${note("D", 5, 4, "quarter")}</measure>` +
      `<measure number="4">${note("C", 5, 16, "whole")}</measure>`;
    const { score } = importText(part(bars));
    const issues = checkScore(score);
    expect(issues.map((i) => [i.code, i.measureIndex])).toEqual([
      ["bar-too-short", 1],
      ["bar-too-long", 2],
    ]);
    expect(issues[0]!.message).toContain("3 beats instead of 4 beats, a quarter note missing");
    expect(issues[1]!.message).toContain("a quarter note too many");
  });

  it("treats a short first bar as a pickup, unless pickups are switched off (scanned pages)", () => {
    const bars = `${note("G", 4, 4, "quarter")}</measure><measure number="2">${note("C", 5, 16, "whole")}</measure><measure number="3">${note("C", 5, 16, "whole")}</measure>`;
    const { score } = importText(part(bars));
    expect(score.measures[0]!.implicit).toBe(true);
    expect(checkScore(score, { comfortableRange: false })).toEqual([]);
    const scanned = importText(part(bars), { detectPickups: false }).score;
    expect(checkScore(scanned, { comfortableRange: false }).map((i) => i.code)).toEqual(["bar-too-short"]);
  });

  it("reports notes outside the instrument's range", () => {
    const { score } = importText(part(`${note("C", 7, 16, "whole")}</measure><measure number="2">${note("A", 5, 16, "whole")}</measure>`));
    const issues = checkScore(score);
    expect(issues.map((i) => [i.code, i.severity])).toEqual([
      ["out-of-range", "error"],
      ["uncomfortable-range", "info"],
    ]);
    expect(checkScore(score, { comfortableRange: false })).toHaveLength(1);
  });

  it("flags a bass clef in a trumpet part (typical recognition error)", () => {
    const { score } = importText(
      part(`${note("C", 5, 8, "half")}<attributes><clef><sign>F</sign><line>4</line></clef></attributes>${note("C", 3, 8, "half")}</measure>`),
    );
    const issues = checkScore(score, { comfortableRange: false });
    expect(issues.some((i) => i.code === "unusual-clef")).toBe(true);
  });

  it("is quiet on a correct score", () => {
    expect(checkScore(load("trumpet-part.musicxml").score, { comfortableRange: false })).toEqual([]);
    expect(checkScore(load("piano.musicxml").score)).toEqual([]);
  });

  it("describes beats readably", () => {
    expect(describeBeats(frac(15, 16), 4)).toBe("3¾ beats");
    expect(describeBeats(frac(1, 4), 4)).toBe("1 beat");
  });
});

describe("playback", () => {
  it("follows repeats and first/second endings", () => {
    const m = (extra: Partial<MeasureInfo>): MeasureInfo => ({ id: "m", number: "", ...extra });
    const measures = [
      m({}),
      m({ repeatStart: true }),
      m({}),
      m({ ending: { number: "1", start: true, stop: true }, repeatEnd: {} }),
      m({ ending: { number: "2", start: true, stop: true, open: true } }),
      m({}),
    ];
    expect(playbackOrder(measures)).toEqual([0, 1, 2, 3, 1, 2, 4, 5]);
    expect(playbackOrder([m({ repeatEnd: { times: 3 } }), m({})])).toEqual([0, 0, 0, 1]);
  });

  it("merges tied notes and applies tempo and repeats", () => {
    const { score } = load("trumpet-part.musicxml");
    const perf = buildPerformance(score);
    // Bars 1–4, 5 (first ending), 4 again, 6 (second ending), 7, 8.
    expect(perf.measures.map((p) => p.measureIndex)).toEqual([0, 1, 2, 3, 4, 3, 5, 6, 7]);
    expect(perf.tempos[0]!.quarterBpm).toBe(112);
    // The tied A4 (quarter + eighth) sounds once.
    const bar2 = perf.notes.filter((n) => n.measureIndex === 1);
    expect(bar2.map((n) => n.midi)).toEqual([67, 62, 67, 68, 70]);
    expect(bar2[2]!.noteIds).toHaveLength(2);
    expect(perf.duration).toBeCloseTo((9 * 4 * 60) / 112, 5);
  });

  it("writes a valid MIDI file", () => {
    const midi = exportMidi(load("piano.musicxml").score);
    expect(String.fromCharCode(...midi.slice(0, 4))).toBe("MThd");
    expect(midi[9]).toBe(1); // format 1
    expect(midi[11]).toBe(2); // conductor track + one part
    const tracks = String.fromCharCode(...midi).split("MTrk").length - 1;
    expect(tracks).toBe(2);
  });
});
