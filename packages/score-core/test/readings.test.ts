import { describe, expect, it } from "vitest";
import {
  alignBars,
  alterNotes,
  canCombine,
  combineReadings,
  concertKeys,
  deleteMeasures,
  harmoniseKeys,
  insertMeasures,
  lineQuality,
  printBars,
  readingDisagreements,
  readingLines,
  scanAccuracy,
  type PageReading,
} from "../src";
import { importText } from "./helpers";

// divisions = 1: a quarter lasts 1.
const n = (step: string, octave = 5, beats = 1, type = "quarter") => `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${beats}</duration><type>${type}</type></note>`;
const bar = (...steps: string[]) => steps.map((s) => n(s)).join("");
const attributes = (fifths: number, clef = "G2") =>
  `<attributes><divisions>1</divisions><key><fifths>${fifths}</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>${clef[0]}</sign><line>${clef[1]}</line></clef></attributes>`;
const newLine = `<print new-system="yes"/>`;

/** A reading of a page with three lines of two bars each; `lines` gives each line's bars. */
function reading(lines: string[][], fifths = 2, clef = "G2"): PageReading {
  const measures = lines.flatMap((line, l) => line.map((content, b) => (l > 0 && b === 0 ? newLine : "") + (l === 0 && b === 0 ? attributes(fifths, clef) : "") + content));
  const xml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Trumpet in Bb</part-name></score-part></part-list><part id="P1">${measures
    .map((m, i) => `<measure number="${i + 1}">${m}</measure>`)
    .join("")}</part></score-partwise>`;
  // As recognition writes it: the notes the key signature raises or lowers carry their alteration.
  const steps = fifths >= 0 ? "FCGDAEB".slice(0, fifths) : "BEADGCF".slice(0, -fifths);
  const keyed = [...steps].reduce((text, step) => text.replaceAll(`<step>${step}</step>`, `<step>${step}</step><alter>${Math.sign(fifths)}</alter>`), xml);
  const imported = importText(keyed, { instruments: ["trumpet-bb"], detectPickups: false, sequentialVoices: true });
  return { score: imported.score, systemStarts: imported.systemStarts };
}

const right = [
  [bar("C", "D", "E", "F"), bar("G", "A", "G", "F")],
  [bar("E", "D", "C", "D"), bar("E", "E", "E", "E")],
  [bar("D", "D", "E", "D"), n("C", 5, 4, "whole")],
];

describe("combining two readings line by line", () => {
  // The first engine lost a beat in line 2; the second missed the key signature and a note in lines 1 and 3.
  const first = reading([right[0]!, [bar("E", "D", "C"), right[1]![1]!], right[2]!]);
  const second = reading([[bar("C", "D", "E"), right[0]![1]!], right[1]!, [right[2]![0]!, n("C", 5, 2, "half")]], 0);

  it("finds the lines and how well each holds together", () => {
    expect(readingLines(first)).toEqual([
      [0, 2],
      [2, 4],
      [4, 6],
    ]);
    expect(canCombine(first, second)).toBe(true);
    expect(lineQuality(first.score, 2, 4)).toEqual({ fitting: 1, withNotes: 2 });
    expect(lineQuality(second.score, 2, 4)).toEqual({ fitting: 2, withNotes: 2 });
  });

  it("takes each line from one reading, and writes out the key where the readings differ", () => {
    const combined = combineReadings([first, second], [0, 1, 0]);
    expect(combined.systemStarts).toEqual([0, 2, 4]);
    expect(combined.lines.map((l) => l.source)).toEqual([0, 1, 0]);
    expect(combined.score.measures.map((m) => m.number)).toEqual(["1", "2", "3", "4", "5", "6"]);
    // Line 2 comes from the reading without the key signature, line 3 has the two sharps again.
    expect(combined.score.measures.map((m) => m.key !== undefined)).toEqual([true, false, true, false, true, false]);
    expect(printBars(combined.score, 0, 2, 3, "written")).toEqual(["bar 3: E5/4 D5/4 C5/4 D5/4", "bar 4: E5/4 E5/4 E5/4 E5/4"]);
    // Bars keep their ids, so whatever is attached to them still finds them.
    expect(combined.score.measures[2]!.id).toBe(second.score.measures[2]!.id);
  });

  it("first gives the reading that missed the key signature the other's, with its notes", () => {
    const [a, b] = harmoniseKeys([first, second]);
    expect(a).toBe(first);
    expect(concertKeys(b.score).map((k) => k.fifths)).toEqual(concertKeys(first.score).map((k) => k.fifths));
    const combined = combineReadings([a, b], [0, 1, 0]);
    expect(combined.score.measures.map((m) => m.key !== undefined)).toEqual([true, false, false, false, false, false]);
    expect(printBars(combined.score, 0, 2, 3, "written")).toEqual(["bar 3: E5/4 D5/4 C#5/4 D5/4", "bar 4: E5/4 E5/4 E5/4 E5/4"]);
    expect(printBars(combined.score, 0, 0, 1, "written")[0]).toBe("bar 1: C#5/4 D5/4 E5/4 F#5/4");
  });

  it("writes out a clef where a line follows one read with another clef", () => {
    const bass = reading([right[0]!, right[1]!, right[2]!], 2, "F4");
    const combined = combineReadings([first, bass], [0, 1, 0]);
    const changes = combined.score.parts[0]!.measures.map((m) => m.clefChanges?.map((c) => c.clef.sign).join() ?? "");
    expect(changes).toEqual(["", "", "F", "", "G", ""]);
  });

  it("lists where the reading not chosen differs: pitches, rhythm, or a bar it doesn't have", () => {
    const other = reading([[bar("C", "D", "E", "G"), right[0]![1]!], [right[1]![0]!, n("E", 5, 2, "half") + n("E", 5, 2, "half")], [right[2]![0]!]]);
    const combined = combineReadings([first, other], [0, 0, 0]);
    expect(readingDisagreements([first, other], combined.lines)).toEqual([
      { kind: "pitch", measure: 0, other: { source: 1, measure: 0 } },
      { kind: "pitch", measure: 2, other: { source: 1, measure: 2 } },
      { kind: "rhythm", measure: 3, other: { source: 1, measure: 3 } },
      // The other reading has no last bar.
      { kind: "missing", measure: 5, other: { source: 1 } },
    ]);
  });
});

describe("pairing the bars of two readings", () => {
  it("pairs bars by their notes, whatever the lines, and leaves bars only one reading has unpaired", () => {
    const a = reading([right[0]!, right[1]!, right[2]!]);
    // Another reading merged lines 1 and 2, missed bar 3 and read bar 4 wrong.
    const b = reading([[right[0]![0]!, right[0]![1]!, bar("E", "E", "E", "F")], [right[2]![0]!, right[2]![1]!]]);
    expect(alignBars(a.score, b.score)).toEqual([
      [0, 0],
      [1, 1],
      [2, null],
      [3, 2],
      [4, 3],
      [5, 4],
    ]);
  });
});

describe("how well a scan was read", () => {
  it("counts the notes the scan had right, by group, once corrected", () => {
    const scan = reading([[bar("C", "D", "E", "G"), right[0]![1]!], right[1]!, right[2]!]).score;
    // Corrected: one pitch, the last bar deleted, and a bar the scan missed added.
    let corrected = alterNotes(scan, [scan.parts[0]!.measures[0]!.voices[0]!.events[3]!.id], -1);
    corrected = deleteMeasures(corrected, 5, 5);
    corrected = insertMeasures(corrected, 2, 1);
    const groups = new Map(scan.measures.map((m, i) => [m.id, i < 2 ? "first" : "second"]));
    const accuracy = scanAccuracy(scan, corrected, (id) => groups.get(id));
    // 4 + 4 + 4 + 4 + 4 notes in the bars kept, 19 of them right; the deleted bar's note was wrong.
    expect({ notes: accuracy.notes, right: accuracy.right, wrong: accuracy.wrong }).toEqual({ notes: 20, right: 19, wrong: 2 });
    expect(accuracy.groups.first).toEqual({ notes: 8, right: 7, wrong: 1 });
    expect(accuracy.groups.second).toEqual({ notes: 12, right: 12, wrong: 1 });
    expect(accuracy.changedBars).toBe(2);
  });
});
