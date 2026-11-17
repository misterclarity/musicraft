import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { printBars } from "@musicraft/score-core";
import { chooseReading, readPage } from "./readings";

function repo(...parts: string[]): string {
  // Tests run from the package folder or the repository root.
  const root = process.cwd().endsWith(join("apps", "web")) ? join(process.cwd(), "..", "..") : process.cwd();
  return join(root, ...parts);
}

const clean = readFileSync(repo("packages/score-core/test/fixtures/trumpet-part.musicxml"), "utf8");
// The same page with the rest at the end of bar 1 missed.
const missing = clean.replace("<note><rest/><duration>12</duration><type>quarter</type></note>", "");
const staffs = [{ x: 0.1, y: 0.1, width: 0.8, height: 0.05 }];

describe("choosing between two readings of a page", () => {
  it("keeps the reading whose bars add up", () => {
    const chosen = chooseReading(
      [
        { readBy: "homr 0.8", musicxml: missing, staffs },
        { readBy: "homr 0.7.0", musicxml: clean, staffs: [{ ...staffs[0]!, y: 0.2 }] },
      ],
      "trumpet-bb",
      "page.png",
    );
    expect(chosen.reading.readBy).toBe("homr 0.7.0");
    expect(chosen.reading.staffs[0]!.y).toBe(0.2);
    expect(chosen.note).toBe("page.png: kept the second reading (homr 0.7.0): 7 of 7 bars with notes add up, against 6 of 7 in the first (homr 0.8).");
  });

  it("keeps the first reading on a tie, and uses whatever can be read", () => {
    const tie = chooseReading([{ musicxml: clean, staffs }, { musicxml: clean, staffs }], "trumpet-bb", "p");
    expect(tie.note).toBe("p: kept the first reading: 7 of 7 bars with notes add up, against 7 of 7 in the second.");
    const one = chooseReading([{ musicxml: "not music", staffs }, { readBy: "homr 0.7.0", musicxml: clean, staffs }], "trumpet-bb", "p");
    expect(one.note).toBe("p: only the second reading (homr 0.7.0) could be used.");
    expect(chooseReading([{ musicxml: clean, staffs }], "trumpet-bb", "p").note).toBeUndefined();
    expect(() => chooseReading([{ musicxml: "not music", staffs }], "trumpet-bb", "p")).toThrow();
  });
});

// A page of three lines, two bars each (divisions = 1); `fifths` is the key signature as printed.
const n = (step: string, beats = 1, type = "quarter") => `<note><pitch><step>${step}</step><octave>5</octave></pitch><duration>${beats}</duration><type>${type}</type></note>`;
const bar = (...steps: string[]) => steps.map((s) => n(s)).join("");
function page(lines: string[][]): string {
  const measures = lines.flatMap((line, l) =>
    line.map((content, b) => (l > 0 && b === 0 ? `<print new-system="yes"/>` : "") + (l === 0 && b === 0 ? `<attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>` : "") + content),
  );
  return `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Trumpet in Bb</part-name></score-part></part-list><part id="P1">${measures
    .map((m, i) => `<measure number="${i + 1}">${m}</measure>`)
    .join("")}</part></score-partwise>`;
}
const right = [
  [bar("C", "D", "E", "F"), bar("G", "A", "G", "F")],
  [bar("E", "D", "C", "D"), bar("E", "E", "E", "E")],
  [bar("D", "D", "E", "D"), n("C", 4, "whole")],
];

describe("reading a page line by line", () => {
  // The first engine lost a beat in line 2; the second read a wrong note in line 1 and lost a beat in line 3.
  const first = { readBy: "engine A", musicxml: page([right[0]!, [bar("E", "D", "C"), right[1]![1]!], right[2]!]), staffs: [staffs[0]!, staffs[0]!, staffs[0]!] };
  const second = { readBy: "engine B", musicxml: page([[bar("C", "D", "E", "G"), right[0]![1]!], right[1]!, [right[2]![0]!, n("C", 2, "half")]]), staffs };

  it("takes each line from the reading in which it adds up, and says so", () => {
    const result = readPage([first, second], "trumpet-bb", "p");
    expect(result.lineEngines).toEqual(["engine A", "engine B", "engine A"]);
    expect(result.imported.systemStarts).toEqual([0, 2, 4]);
    expect(printBars(result.imported.score, 0, 2, 2, "written")).toEqual(["bar 3: E5/4 D5/4 C5/4 D5/4"]);
    expect(result.note).toBe("p: line 2 from the second reading (engine B), the rest from the first (engine A): 6 of 6 bars with notes add up, against 5 and 5 in either alone.");
    // The first reading's three staff boxes, one per line.
    expect(result.staffs).toHaveLength(3);
  });

  it("lists the bars the other engine read differently, with its version", () => {
    const result = readPage([first, second], "trumpet-bb", "p");
    const ids = result.imported.score.measures.map((m) => m.id);
    // Bar 3 lost a note in the first reading: another melody, so other pitches.
    expect(result.disagreements.map((d) => [ids.indexOf(d.measureId), d.kind, d.readBy])).toEqual([
      [0, "pitch", "engine B"],
      [2, "pitch", "engine A"],
      [5, "rhythm", "engine B"],
    ]);
    expect(result.disagreements[0]!.bar!.voices[0]!.events).toHaveLength(4);
  });

  it("keeps a reading whole when the readings found different lines, and still compares them", () => {
    const merged = { readBy: "engine B", musicxml: page([[...right[0]!, right[1]![0]!], [right[1]![1]!], right[2]!]).replace(bar("D", "D", "E", "D"), bar("D", "D", "E", "F")), staffs };
    const twoLines = { ...merged, musicxml: merged.musicxml.replace(`<print new-system="yes"/>${right[1]![1]!}`, right[1]![1]!) };
    // The second engine ran lines 1 and 2 together and read a wrong note in bar 5, but all its bars add up.
    const result = readPage([first, twoLines], "trumpet-bb", "p");
    expect(result.lineEngines).toEqual(["engine B", "engine B"]);
    const ids = result.imported.score.measures.map((m) => m.id);
    expect(result.disagreements.map((d) => [ids.indexOf(d.measureId), d.kind, d.readBy])).toEqual([
      [2, "pitch", "engine A"],
      [4, "pitch", "engine A"],
    ]);
  });
});
