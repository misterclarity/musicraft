import { describe, expect, it } from "vitest";
import {
  beamGroupLength,
  computeBeams,
  concertKeys,
  eventOnsets,
  exportMusicXml,
  exportMxl,
  formatPitch,
  frac,
  importMxl,
  measureLengths,
  tupletGroups,
  voiceLength,
  type MusicEvent,
  type NoteEvent,
  type Score,
} from "../src";
import { importText, load, parser, texts, xmlDoc } from "./helpers";

function notesOf(score: Score, partIndex = 0): string[] {
  const out: string[] = [];
  for (const pm of score.parts[partIndex]!.measures) {
    for (const voice of pm.voices) {
      for (const e of voice.events) {
        if (e.kind === "note") out.push(e.notes.map((n) => formatPitch(n.pitch)).join("+"));
      }
    }
  }
  return out;
}

describe("MusicXML import: transposing trumpet part", () => {
  const { score, warnings } = load("trumpet-part.musicxml");
  const part = score.parts[0]!;

  it("recognises the instrument and reads metadata", () => {
    expect(warnings).toEqual([]);
    expect(score.meta.title).toBe("Test March");
    expect(score.meta.composer).toBe("Musicraft Tests");
    expect(part.instrument).toBe("trumpet-bb");
    expect(part.name).toBe("1st Bb Trumpet");
    expect(score.measures).toHaveLength(8);
  });

  it("stores concert pitch and concert keys", () => {
    // Written E5 for a Bb trumpet sounds D5; written C major is concert Bb major.
    expect(notesOf(score).slice(0, 2)).toEqual(["D5", "C5"]);
    expect(concertKeys(score).map((k) => k.fifths)).toEqual([-2, -2, -5, -3, -3, -3, -1, -1]);
  });

  it("reads tempo, rehearsal marks, dynamics and articulations", () => {
    expect(score.measures[0]!.tempo).toEqual({ bpm: 112, beatUnit: "quarter", text: "Marcia" });
    expect(score.measures[0]!.rehearsal).toBe("A");
    expect(part.measures[0]!.directions).toEqual([
      expect.objectContaining({ kind: "dynamic", value: "f", staff: 1, offset: frac(0) }),
    ]);
    const first = part.measures[0]!.voices[0]!.events[0] as NoteEvent;
    const second = part.measures[0]!.voices[0]!.events[1] as NoteEvent;
    expect(first.articulations).toEqual(["accent"]);
    expect(second.articulations).toEqual(["marcato"]);
  });

  it("reads ties, slurs, dots and triplets", () => {
    const bar2 = part.measures[1]!.voices[0]!.events as NoteEvent[];
    expect(bar2[0]!.duration).toEqual({ type: "eighth", dots: 1 });
    expect(bar2[0]!.slurs).toEqual([{ type: "start" }]);
    expect(bar2[2]!.notes[0]!.tie).toEqual({ start: true });
    expect(bar2[3]!.notes[0]!.tie).toEqual({ stop: true });
    const bar3 = part.measures[2]!.voices[0]!.events;
    expect(bar3[0]!.duration.tuplet).toEqual({ actual: 3, normal: 2 });
    const lengths = measureLengths(score);
    for (let m = 0; m < 8; m++) {
      expect(voiceLength(part.measures[m]!.voices[0]!, lengths[m]!)).toEqual(lengths[m]);
    }
  });

  it("reads repeats, endings and the final barline", () => {
    expect(score.measures[3]!.repeatStart).toBe(true);
    expect(score.measures[4]!.repeatEnd).toEqual({});
    expect(score.measures[4]!.ending).toEqual({ number: "1", start: true, stop: true });
    expect(score.measures[5]!.ending).toEqual({ number: "2", start: true, stop: true, open: true });
    expect(score.measures[7]!.barline).toBe("final");
    expect(part.measures[7]!.voices[0]!.events[0]).toMatchObject({ kind: "rest", measureRest: true });
  });
});

describe("MusicXML export", () => {
  const { score } = load("trumpet-part.musicxml");

  it("round-trips through written pitch", () => {
    const xml = exportMusicXml(score);
    const again = importText(xml).score;
    expect(again.parts[0]!.instrument).toBe("trumpet-bb");
    expect(notesOf(again)).toEqual(notesOf(score));
    expect(concertKeys(again)).toEqual(concertKeys(score));
    expect(again.measures.map((m) => m.tempo)).toEqual(score.measures.map((m) => m.tempo));
    expect(again.measures.map((m) => [m.repeatStart, m.repeatEnd, m.ending])).toEqual(
      score.measures.map((m) => [m.repeatStart, m.repeatEnd, m.ending]),
    );
  });

  it("writes the original written keys and a transpose element", () => {
    const doc = xmlDoc(exportMusicXml(score));
    expect(texts(doc, "fifths")).toEqual(["0", "-3", "-1", "1"]);
    expect(texts(doc, "diatonic")).toEqual(["-1"]);
    expect(texts(doc, "chromatic")).toEqual(["-2"]);
  });

  it("writes concert pitch when asked", () => {
    const doc = xmlDoc(exportMusicXml(score, { pitch: "concert" }));
    expect(texts(doc, "fifths")).toEqual(["-2", "-5", "-3", "-1"]);
    expect(doc.getElementsByTagName("transpose")).toHaveLength(0);
  });

  it("computes accidentals against the key and earlier notes in the bar", () => {
    const doc = xmlDoc(exportMusicXml(score));
    const measures = doc.getElementsByTagName("measure");
    const bar7 = measures[6]!;
    const accidentals = Array.from(bar7.getElementsByTagName("note")).map(
      (n) => n.getElementsByTagName("accidental")[0]?.textContent ?? "",
    );
    // G major: F#, F natural, F# again, G.
    expect(accidentals).toEqual(["", "natural", "sharp", ""]);
  });

  it("keeps element ids so rendered notes map back to the model", () => {
    const xml = exportMusicXml(score);
    const firstNote = score.parts[0]!.measures[0]!.voices[0]!.events[0] as NoteEvent;
    expect(xml).toContain(`id="${firstNote.notes[0]!.id}"`);
    expect(xml).toContain(`id="${score.measures[0]!.id}"`);
    expect(exportMusicXml(score, { includeIds: false })).not.toContain(`id="${firstNote.notes[0]!.id}"`);
  });

  it("writes tuplet brackets and beams", () => {
    const doc = xmlDoc(exportMusicXml(score));
    const tuplets = Array.from(doc.getElementsByTagName("tuplet")).map((t) => t.getAttribute("type"));
    expect(tuplets).toEqual(["start", "stop"]);
    expect(texts(doc, "beam").length).toBeGreaterThan(0);
  });

  it("round-trips compressed MusicXML", () => {
    const again = importMxl(exportMxl(score), { parser }).score;
    expect(notesOf(again)).toEqual(notesOf(score));
  });

  it("combines empty bars into multi-bar rests for parts", () => {
    const { score: s } = importText(`<?xml version="1.0"?>
<score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Trumpet in Bb</part-name></score-part></part-list>
<part id="P1">
  <measure number="1"><attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>G</sign><line>2</line></clef></attributes>
    <note><pitch><step>C</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note></measure>
  ${[2, 3, 4, 5].map((n) => `<measure number="${n}"><note><rest measure="yes"/><duration>4</duration></note></measure>`).join("")}
  <measure number="6"><note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note></measure>
</part></score-partwise>`);
    const doc = xmlDoc(exportMusicXml(s, { multiRests: true }));
    expect(texts(doc, "multiple-rest")).toEqual(["4"]);
  });
});

describe("MusicXML import: piano with voices, chords and clef changes", () => {
  const { score } = load("piano.musicxml");
  const piano = score.parts[0]!;

  it("reads two staves and voices", () => {
    expect(piano.instrument).toBe("piano");
    expect(piano.staves).toBe(2);
    expect(piano.clefs).toEqual([
      { sign: "G", line: 2 },
      { sign: "F", line: 4 },
    ]);
    const bar1 = piano.measures[0]!;
    expect(bar1.voices.map((v) => [v.staff, v.voice])).toEqual([
      [1, 1],
      [1, 2],
      [2, 5],
    ]);
    const chord = bar1.voices[0]!.events[0] as NoteEvent;
    expect(chord.notes.map((n) => formatPitch(n.pitch))).toEqual(["F4", "A4", "C5"]);
    expect(bar1.voices[0]!.events).toHaveLength(4);
    expect(bar1.directions?.[0]).toMatchObject({ kind: "dynamic", value: "p" });
  });

  it("places a clef change at its position in the bar", () => {
    expect(piano.measures[1]!.clefChanges).toEqual([{ staff: 2, offset: frac(1, 4), clef: { sign: "G", line: 2 } }]);
  });

  it("round-trips through export", () => {
    const again = importText(exportMusicXml(score)).score.parts[0]!;
    expect(again.staves).toBe(2);
    expect(again.measures[1]!.clefChanges).toEqual(piano.measures[1]!.clefChanges);
    expect(again.measures[0]!.voices.map((v) => v.events.length)).toEqual([4, 1, 1]);
    expect(notesOf(importText(exportMusicXml(score)).score)).toEqual(notesOf(score));
  });
});

describe("homr-style output", () => {
  const homr = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<score-partwise version="4.0"><work><work-title>1st Bb TRUMPET</work-title></work>
<part-list><score-part id="P1"><part-name>Voice</part-name><score-instrument id="P1-I1"><instrument-name>Voice</instrument-name><instrument-sound>voice</instrument-sound></score-instrument></score-part></part-list>
<part id="P1"><measure number="1">
<attributes><divisions>4</divisions></attributes>
<attributes><key><fifths>0</fifths></key><clef number="1"><sign>G</sign><line>2</line></clef></attributes>
<note><pitch><step>E</step><octave>5</octave></pitch><duration>16</duration><voice>1</voice><type>whole</type><staff>1</staff><!-- imgpos: 120, 340 --></note>
</measure></part></score-partwise>`;

  it("assumes 4/4 when no time signature is printed and keeps image positions", () => {
    const result = importText(homr);
    expect(result.score.measures[0]!.time).toEqual({ beats: 4, beatType: 4 });
    expect(result.warnings.some((w) => w.includes("4/4"))).toBe(true);
    const event = result.score.parts[0]!.measures[0]!.voices[0]!.events[0]!;
    expect(result.imagePositions[event.id]).toEqual({ x: 120, y: 340 });
  });

  it("reads notes as written pitch for the instrument chosen during import", () => {
    const result = importText(homr, { instruments: ["trumpet-bb"] });
    const part = result.score.parts[0]!;
    expect(part.instrument).toBe("trumpet-bb");
    expect(part.name).toBe("Trumpet in Bb");
    expect(notesOf(result.score)).toEqual(["D5"]);
    expect(concertKeys(result.score)[0]!.fifths).toBe(-2);
  });
});

describe("beams and tuplets", () => {
  const eighths = (n: number): MusicEvent[] =>
    Array.from({ length: n }, (_, i) => ({
      kind: "note" as const,
      id: `e${i}`,
      duration: { type: "eighth" as const, dots: 0 },
      notes: [{ id: `n${i}`, pitch: { step: "C" as const, alter: 0, octave: 5 } }],
    }));
  const onsetsOf = (events: MusicEvent[]) =>
    eventOnsets({ staff: 1, voice: 1, events }, frac(1));

  it("beams eighths by beat in 4/4 and by dotted quarter in 6/8", () => {
    const events = eighths(8);
    const beams = computeBeams(events, onsetsOf(events), beamGroupLength({ beats: 4, beatType: 4 }));
    expect([...beams.values()].map((b) => b[0])).toEqual(["begin", "end", "begin", "end", "begin", "end", "begin", "end"]);
    const compound = eighths(6);
    const b68 = computeBeams(compound, onsetsOf(compound), beamGroupLength({ beats: 6, beatType: 8 }));
    expect([...b68.values()].map((b) => b[0])).toEqual(["begin", "continue", "end", "begin", "continue", "end"]);
  });

  it("adds hooks for dotted rhythms", () => {
    const events: MusicEvent[] = [
      { kind: "note", id: "a", duration: { type: "eighth", dots: 1 }, notes: [{ id: "na", pitch: { step: "A", alter: 0, octave: 4 } }] },
      { kind: "note", id: "b", duration: { type: "16th", dots: 0 }, notes: [{ id: "nb", pitch: { step: "E", alter: 0, octave: 4 } }] },
    ];
    const beams = computeBeams(events, onsetsOf(events), frac(1, 4));
    expect(beams.get(0)).toEqual(["begin"]);
    expect(beams.get(1)).toEqual(["end", "backward hook"]);
  });

  it("groups tuplets by their unit", () => {
    const triplet = (type: "eighth" | "quarter", id: string): MusicEvent => ({
      kind: "note",
      id,
      duration: { type, dots: 0, tuplet: { actual: 3, normal: 2 } },
      notes: [{ id: `n${id}`, pitch: { step: "C", alter: 0, octave: 5 } }],
    });
    expect(tupletGroups([triplet("eighth", "a"), triplet("eighth", "b"), triplet("eighth", "c"), triplet("eighth", "d"), triplet("eighth", "e"), triplet("eighth", "f")])).toEqual([
      [0, 2],
      [3, 5],
    ]);
    expect(tupletGroups([triplet("quarter", "a"), triplet("eighth", "b")])).toEqual([[0, 1]]);
  });
});
