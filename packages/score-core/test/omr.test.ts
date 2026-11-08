import { describe, expect, it } from "vitest";
import { cleanupRecognized, concertKeys, formatPitch, mergeScores, type NoteEvent } from "../src";
import { importText } from "./helpers";

const page = (notes: string, extraAttributes = "") => `<?xml version="1.0"?>
<score-partwise version="4.0"><work><work-title>1st Bb TRUMPET</work-title></work>
<part-list><score-part id="P1"><part-name>Voice</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key>
<time><beats>2</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef>${extraAttributes}</attributes>
${notes}</measure>
<measure number="2"><print new-system="yes"/><note><pitch><step>G</step><octave>5</octave></pitch><duration>2</duration><type>half</type></note></measure>
</part></score-partwise>`;

const n = (step: string, slur?: "start" | "stop") =>
  `<note><pitch><step>${step}</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type>${slur ? `<notations><slur type="${slur}"/></notations>` : ""}</note>`;

describe("recognised pages", () => {
  it("records where systems start", () => {
    expect(importText(page(n("C") + n("D"))).systemStarts).toEqual([0, 1]);
  });

  it("merges pages, dropping repeated key and time signatures", () => {
    const options = { instruments: ["trumpet-bb"], detectPickups: false };
    const a = importText(page(n("C") + n("D")), options).score;
    const b = importText(page(n("E") + n("F")), options).score;
    const { score, ranges } = mergeScores([a, b]);
    expect(score.measures).toHaveLength(4);
    expect(ranges).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(score.measures.map((m) => m.number)).toEqual(["1", "2", "3", "4"]);
    expect(score.measures[2]!.time).toBeUndefined();
    expect(score.measures[2]!.key).toBeUndefined();
    expect(concertKeys(score).map((k) => k.fifths)).toEqual([-2, -2, -2, -2]);
    expect(score.parts[0]!.name).toBe("Trumpet in Bb");
    expect(score.meta.title).toBe("1st Bb TRUMPET");
  });

  it("keeps a real key change between pages", () => {
    const a = importText(page(n("C") + n("D"))).score;
    const b = importText(page(n("E") + n("F")).replace("<fifths>0</fifths>", "<fifths>2</fifths>")).score;
    const { score } = mergeScores([a, b]);
    expect(score.measures[2]!.key?.fifths).toBe(2);
  });

  it("turns slurs between identical notes into ties", () => {
    const score = importText(page(n("A", "start") + n("A", "stop"))).score;
    const cleaned = cleanupRecognized(score);
    const events = cleaned.parts[0]!.measures[0]!.voices[0]!.events as NoteEvent[];
    expect(events[0]!.slurs).toBeUndefined();
    expect(events[0]!.notes[0]!.tie).toEqual({ start: true });
    expect(events[1]!.notes[0]!.tie).toEqual({ stop: true });
    expect(formatPitch(events[1]!.notes[0]!.pitch)).toBe("A5");
    // A real slur between different notes stays.
    const slurred = cleanupRecognized(importText(page(n("A", "start") + n("B", "stop"))).score);
    expect((slurred.parts[0]!.measures[0]!.voices[0]!.events[0] as NoteEvent).slurs).toEqual([{ type: "start" }]);
  });
});

describe("engine quirks", () => {
  // Two staves written in time order where the engine forgot one <backup> (homr 0.7.0 does this).
  const note = (step: string, octave: number, divs: number, type: string, voice: number, staff: number) =>
    `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${divs}</duration><voice>${voice}</voice><type>${type}</type><staff>${staff}</staff></note>`;
  const missingBackup = `<?xml version="1.0"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>4</divisions><key><fifths>0</fifths></key>
<time><beats>2</beats><beat-type>4</beat-type></time><staves>2</staves>
<clef number="1"><sign>G</sign><line>2</line></clef><clef number="2"><sign>F</sign><line>4</line></clef></attributes>
<note><rest/><duration>1</duration><voice>1</voice><type>16th</type><staff>1</staff></note>
<backup><duration>1</duration></backup>${note("C", 3, 2, "eighth", 5, 2)}
<backup><duration>1</duration></backup>${note("D", 5, 1, "16th", 1, 1)}${note("E", 5, 2, "eighth", 1, 1)}
${note("D", 3, 2, "eighth", 5, 2)}${note("E", 3, 4, "quarter", 5, 2)}
<backup><duration>4</duration></backup>${note("F", 5, 4, "quarter", 1, 1)}
</measure></part></score-partwise>`;

  it("keeps rhythms intact when backups are missing", async () => {
    const { checkScore } = await import("../src");
    const strict = importText(missingBackup).score;
    expect(checkScore(strict).some((i) => i.code === "bar-too-long")).toBe(true);
    const sequential = importText(missingBackup, { sequentialVoices: true }).score;
    expect(checkScore(sequential)).toEqual([]);
  });

  it("marks a short first bar as a pickup", async () => {
    const { markPickup } = await import("../src");
    const score = importText(page(n("C")), { detectPickups: false }).score;
    expect(score.measures[0]!.implicit).toBeUndefined();
    const marked = markPickup(score);
    expect(marked.measures[0]!.implicit).toBe(true);
    expect(marked.measures.map((m) => m.number)).toEqual(["0", "1"]);
  });
});

describe("merging pages with different parts", () => {
  const twoParts = `<?xml version="1.0"?>
<score-partwise version="4.0"><part-list>
<score-part id="P1"><part-name>Trumpet</part-name></score-part><score-part id="P2"><part-name>Trombone</part-name></score-part></part-list>
<part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
<note><pitch><step>C</step><octave>5</octave></pitch><duration>2</duration><type>half</type></note></measure></part>
<part id="P2"><measure number="1"><attributes><divisions>1</divisions><time><beats>2</beats><beat-type>4</beat-type></time><clef><sign>F</sign><line>4</line></clef></attributes>
<note><pitch><step>C</step><octave>3</octave></pitch><duration>2</duration><type>half</type></note></measure></part></score-partwise>`;

  it("keeps the music of a part that only starts on a later page", () => {
    const a = importText(page(n("C") + n("D"))).score;
    const b = importText(twoParts).score;
    const { score } = mergeScores([a, b]);
    expect(score.measures).toHaveLength(3);
    expect(score.parts).toHaveLength(2);
    for (const part of score.parts) expect(part.measures).toHaveLength(3);
    const lastBar = score.parts[1]!.measures[2]!.voices[0]!.events[0] as NoteEvent;
    expect(formatPitch(lastBar.notes[0]!.pitch)).toBe("C3");
    expect(score.parts[1]!.measures[0]!.voices.every((v) => v.events.every((e) => e.kind === "rest"))).toBe(true);
  });
});
