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

describe("repairing recognised scores", () => {
  // divisions = 2: an eighth is 1, a quarter 2.
  const note = (step: string, octave: number, divs: number, type: string, dots = 0, extra = "") =>
    `<note><pitch><step>${step}</step><octave>${octave}</octave></pitch><duration>${divs}</duration><type>${type}</type>${"<dot/>".repeat(dots)}${extra}</note>`;
  const rest = (divs: number, type: string, dots = 0) => `<note><rest/><duration>${divs}</duration><type>${type}</type>${"<dot/>".repeat(dots)}</note>`;
  const fourFour = note("C", 5, 2, "quarter") + note("D", 5, 2, "quarter") + note("E", 5, 4, "half");
  // A 12/8 bar: dotted quarter, three eighths, dotted half.
  const twelveEight = note("D", 5, 3, "quarter", 1) + note("D", 5, 1, "eighth") + note("G", 4, 1, "eighth") + note("D", 5, 1, "eighth") + note("D", 5, 6, "half", 1);
  const doc = (title: string, measures: string[], instrument = "Trumpet in Bb") => `<?xml version="1.0"?>
<score-partwise version="4.0"><work><work-title>${title}</work-title></work>
<part-list><score-part id="P1"><part-name>${instrument}</part-name></score-part></part-list>
<part id="P1">${measures.map((m, i) => `<measure number="${i + 1}">${m}</measure>`).join("\n")}</part></score-partwise>`;
  const start = (time = "4/4", clef = "<clef><sign>G</sign><line>2</line></clef>") =>
    `<attributes><divisions>2</divisions><key><fifths>0</fifths></key><time><beats>${time.split("/")[0]}</beats><beat-type>${time.split("/")[1]}</beat-type></time>${clef}</attributes>`;
  const doubleBar = `<barline location="right"><bar-style>light-light</bar-style></barline>`;
  const time = (t: string) => `<attributes><time><beats>${t.split("/")[0]}</beats><beat-type>${t.split("/")[1]}</beat-type></time></attributes>`;
  const recognise = (xml: string, instrument = "trumpet-bb") => importText(xml, { instruments: [instrument], detectPickups: false, sequentialVoices: true }).score;

  it("needs three bars that agree before it changes a time signature", async () => {
    const { inferTimeSignatures, timeSignatures } = await import("../src");
    const threeBeats = note("C", 5, 2, "quarter") + note("D", 5, 2, "quarter") + note("E", 5, 2, "quarter");
    // After a double barline, bars that each miss a beat: two of them are more likely misread notes.
    const two = recognise(doc("Short", [start() + fourFour, fourFour + doubleBar, threeBeats, threeBeats]));
    expect(inferTimeSignatures(two).notes).toEqual([]);
    const three = recognise(doc("Longer", [start() + fourFour, fourFour + doubleBar, threeBeats, threeBeats, threeBeats]));
    expect(timeSignatures(inferTimeSignatures(three).score)[2]).toEqual({ beats: 3, beatType: 4 });
  });

  it("corrects a time signature that the bars don't add up to, and keeps the rest of the piece", async () => {
    const { repairRecognized, timeSignatures, checkScore } = await import("../src");
    const xml = doc("March", [
      start() + fourFour,
      fourFour + doubleBar,
      // 12/8 misread as 2/2, as homr does.
      time("2/2") + twelveEight,
      twelveEight,
      // A whole rest in 12/8 rests for the whole bar.
      rest(8, "whole"),
      note("G", 5, 2, "quarter") + note("A", 5, 1, "eighth") + note("B", 5, 3, "quarter", 1) + note("G", 5, 6, "half", 1) + doubleBar,
      time("4/4") + fourFour,
    ]);
    const before = recognise(xml);
    expect(checkScore(before).filter((i) => i.code.startsWith("bar-too")).length).toBe(3);
    const { score, notes } = repairRecognized(before);
    expect(timeSignatures(score).map((t) => `${t.beats}/${t.beatType}`)).toEqual(["4/4", "4/4", "12/8", "12/8", "12/8", "12/8", "4/4"]);
    expect(checkScore(score).filter((i) => i.code.startsWith("bar-"))).toEqual([]);
    expect(notes).toEqual(["Bars 3–6 add up to 12/8, not 2/2: the time signature was corrected."]);
  });

  it("chooses simple time when the rhythm moves in quarters, and leaves sections that mostly fit alone", async () => {
    const { repairRecognized, timeSignatures } = await import("../src");
    const waltz = note("C", 5, 2, "quarter") + note("E", 5, 2, "quarter") + note("G", 5, 2, "quarter");
    const threeFour = repairRecognized(recognise(doc("Waltz", [start() + waltz, waltz, waltz])));
    expect(timeSignatures(threeFour.score).map((t) => `${t.beats}/${t.beatType}`)).toEqual(["3/4", "3/4", "3/4"]);
    // Two bars of 4/4 and one odd bar: a recognition error in one bar, not a different time signature.
    const odd = repairRecognized(recognise(doc("Song", [start() + fourFour, waltz, fourFour])));
    expect(odd.notes).toEqual([]);
    expect(odd.score.measures[0]!.time).toEqual({ beats: 4, beatType: 4 });
  });

  it("drops a tempo mark read as the title", async () => {
    const { repairRecognized, plausibleTitle } = await import("../src");
    const { score, notes } = repairRecognized(recognise(doc("(d=112)", [start() + fourFour])));
    expect(score.meta.title).toBe("Untitled");
    expect(notes[0]).toContain('"(d=112)" is not a title');
    expect(plausibleTitle("1st Bb TRUMPET")).toBe(true);
    expect(plausibleTitle("♩ = 120")).toBe(false);
    expect(plausibleTitle("12")).toBe(false);
    expect(plausibleTitle("x")).toBe(false);
    expect(plausibleTitle("春")).toBe(true);
    expect(plausibleTitle("(♩=60) 春")).toBe(false);
  });

  it("reads notes after a bass clef that a trumpet never uses in the treble clef", async () => {
    const { repairRecognized, printBars } = await import("../src");
    const bass = `<attributes><clef><sign>F</sign><line>4</line></clef></attributes>`;
    const treble = `<attributes><clef><sign>G</sign><line>2</line></clef></attributes>`;
    // In G major. Read in the bass clef, the treble clef's D5 E5 F#5 G5 come out as F3 G3 A3 B3.
    const xml = doc("Finale", [
      start().replace("<fifths>0</fifths>", "<fifths>1</fifths>") + fourFour,
      fourFour,
      fourFour,
      bass + note("F", 3, 2, "quarter") + note("G", 3, 2, "quarter") + note("A", 3, 2, "quarter") + note("B", 3, 1, "eighth") + note("C", 3, 1, "eighth", 0, "<accidental>sharp</accidental>").replace("<octave>3</octave>", "<alter>1</alter><octave>3</octave>"),
      treble + fourFour,
    ]);
    const { score, notes } = repairRecognized(recognise(xml));
    expect(printBars(score, 0, 3, 4, "written")).toEqual(["bar 4: D5/4 E5/4 F#5/4 G5/8 A#4/8", "bar 5: C5/4 D5/4 E5/2"]);
    expect(score.parts[0]!.measures.some((pm) => pm.clefChanges?.length)).toBe(false);
    expect(notes).toEqual(["Bar 4: the bass clef read in this Trumpet in Bb part was removed and its notes read in the treble clef."]);
    // A trombone does read the bass clef.
    const trombone = repairRecognized(recognise(xml.replace("Trumpet in Bb", "Trombone"), "trombone"));
    expect(trombone.notes).toEqual([]);
  });

  it("adds the bars of a multi-bar rest that only its first bar was written for", async () => {
    const { isRestBar } = await import("../src");
    const multi = (bars: number) => `<attributes><measure-style><multiple-rest>${bars}</multiple-rest></measure-style></attributes>${rest(8, "whole")}`;
    // homr 0.7 writes one bar per multi-bar rest.
    const short = importText(doc("Rests", [start() + fourFour, multi(3), multi(2), `<print new-system="yes"/>` + fourFour]));
    expect(short.score.measures.map((m) => m.number)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
    expect([1, 2, 3, 4, 5].every((m) => isRestBar(short.score, m))).toBe(true);
    expect(short.systemStarts).toEqual([0, 6]);
    // A double barline printed after the rest comes after its last bar.
    const barred = importText(doc("Rests", [start() + fourFour, multi(3) + doubleBar, fourFour]));
    expect(barred.score.measures.map((m) => m.barline ?? "")).toEqual(["", "", "", "double", ""]);
    // Standard MusicXML writes all of them: nothing to add.
    const full = importText(doc("Rests", [start() + fourFour, multi(3), rest(8, "whole"), rest(8, "whole"), fourFour]));
    expect(full.score.measures).toHaveLength(5);
  });
});

describe("correcting key signatures", () => {
  it("adds a missed key signature and respells the notes that follow the key", async () => {
    const { correctKeySignature, concertKeys, newScore, printBars, writeBars } = await import("../src");
    let score = newScore({ title: "T", parts: [{ instrument: "trumpet-bb" }], measures: 4, key: { fifths: -2 } });
    // Bar 2 on was read without its three flats (written Eb major); the printed F sharp stays.
    score = writeBars(score, 0, "bar 1: C5/4 E5/4 G5/4 B4/4\nbar 2: A4/4 A5/4 F#5/4 E4/4\nbar 3: E5/1\nbar 4: E5/1", "written").score;
    score = { ...score, measures: score.measures.map((m, i) => (i === 3 ? { ...m, key: { fifths: -2, mode: "major" as const } } : m)) };
    const fixed = correctKeySignature(score, 1, { fifths: -5, mode: "major" });
    expect(concertKeys(fixed).map((k) => k.fifths)).toEqual([-2, -5, -5, -2]);
    expect(printBars(fixed, 0, 0, 3, "written")).toEqual([
      "bar 1: C5/4 E5/4 G5/4 B4/4",
      "bar 2: Ab4/4 Ab5/4 F#5/4 Eb4/4",
      "bar 3: Eb5/1",
      "bar 4: E5/1",
    ]);
  });
});

describe("comparing readings", () => {
  it("counts the bars with notes that add up", async () => {
    const { readingQuality, newScore, writeBars } = await import("../src");
    let score = newScore({ title: "T", parts: [{ instrument: "trumpet-bb" }], measures: 4 });
    score = writeBars(score, 0, "bar 1: C5/1\nbar 2: D5/2 E5/2", "written").score;
    expect(readingQuality(score)).toEqual({ fitting: 2, withNotes: 2 });
    // A bar a quarter short.
    const short = { ...score, parts: score.parts.map((p) => ({ ...p, measures: p.measures.map((pm, i) => (i === 1 ? { ...pm, voices: pm.voices.map((v) => ({ ...v, events: v.events.slice(1) })) } : pm)) })) };
    expect(readingQuality(short)).toEqual({ fitting: 1, withNotes: 2 });
  });
});
