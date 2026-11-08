import { describe, expect, it } from "vitest";
import {
  changeInstrument,
  getInstrument,
  renameKey,
  concertKeys,
  exportMusicXml,
  formatPitch,
  parseInterval,
  shiftOctaves,
  transposeDiatonic,
  transposeScore,
  type NoteEvent,
  type Score,
} from "../src";
import { load, texts, xmlDoc } from "./helpers";

function writtenNotes(xml: string): string[] {
  const doc = xmlDoc(xml);
  return Array.from(doc.getElementsByTagName("pitch")).map((p) => {
    const step = p.getElementsByTagName("step")[0]!.textContent;
    const alter = Number(p.getElementsByTagName("alter")[0]?.textContent ?? 0);
    const octave = p.getElementsByTagName("octave")[0]!.textContent;
    return `${step}${alter > 0 ? "#".repeat(alter) : "b".repeat(-alter)}${octave}`;
  });
}

function concertNotes(score: Score): string[] {
  return score.parts[0]!.measures.flatMap((pm) =>
    pm.voices.flatMap((v) => v.events.filter((e): e is NoteEvent => e.kind === "note").map((e) => formatPitch(e.notes[0]!.pitch))),
  );
}

describe("instrument changes on the trumpet part", () => {
  const { score } = load("trumpet-part.musicxml");
  const partId = score.parts[0]!.id;

  it("Bb trumpet → C trumpet: same sound, written a major second lower", () => {
    const c = changeInstrument(score, partId, "trumpet-c");
    expect(concertNotes(c)).toEqual(concertNotes(score));
    const doc = xmlDoc(exportMusicXml(c));
    // Written keys C, Eb, F, G become Bb, Db, Eb, F.
    expect(texts(doc, "fifths")).toEqual(["-2", "-5", "-3", "-1"]);
    expect(doc.getElementsByTagName("transpose")).toHaveLength(0);
    expect(writtenNotes(exportMusicXml(c)).slice(0, 3)).toEqual(["D5", "C5", "G4"]);
    expect(c.parts[0]!.name).toBe("1st C Trumpet"); // custom names keep their wording; only the pitch word follows
  });

  it("Bb trumpet → Bb clarinet: written notes stay the same", () => {
    const clarinet = changeInstrument(score, partId, "clarinet-bb", { name: "Clarinet in Bb" });
    expect(writtenNotes(exportMusicXml(clarinet))).toEqual(writtenNotes(exportMusicXml(score)));
    expect(clarinet.parts[0]!.name).toBe("Clarinet in Bb");
    expect(clarinet.parts[0]!.instrument).toBe("clarinet-bb");
  });

  it("Bb trumpet → horn in F: written a fourth higher than the trumpet part", () => {
    const horn = changeInstrument(score, partId, "horn-f");
    // Written E5 on Bb trumpet sounds D5; horn in F writes D5 a fifth up: A5.
    expect(writtenNotes(exportMusicXml(horn))[0]).toBe("A5");
  });

  it("keep-written mode reinterprets the notes for a new instrument", () => {
    // Pretend the part was imported as a C instrument by mistake.
    const asC = changeInstrument(score, partId, "trumpet-c", { mode: "keep-written" });
    // The written notes are unchanged, so the sound goes up a major second.
    expect(writtenNotes(exportMusicXml(asC))).toEqual(writtenNotes(exportMusicXml(score)));
    expect(concertNotes(asC)[0]).toBe("E5");
    expect(concertKeys(asC)[0]!.fifths).toBe(0);
  });
});

describe("transposition", () => {
  const { score } = load("trumpet-part.musicxml");

  it("moves keys and respells extreme ones", () => {
    const up = transposeScore(score, parseInterval("M2"));
    // Concert keys Bb, Db, Eb, F → C, Eb, F, G.
    expect(concertKeys(up).map((k) => k.fifths)).toEqual([0, 0, -3, -1, -1, -1, 1, 1]);
    expect(concertNotes(up)[0]).toBe("E5");
    const tritone = transposeScore(score, parseInterval("A4"));
    // Bb + A4 = E major (4 sharps), Db + A4 = G major …
    expect(concertKeys(tritone).map((k) => k.fifths)).toEqual([4, 4, 1, 3, 3, 3, 5, 5]);
  });

  it("shifts octaves and transposes within the key", () => {
    const down = shiftOctaves(score, -1);
    expect(concertNotes(down)[0]).toBe("D4");
    const third = transposeDiatonic(score, 2, { from: 0, to: 0 });
    // Concert Bb major: D5 → F5, C5 → Eb5 (stays in the key).
    expect(concertNotes(third).slice(0, 2)).toEqual(["F5", "Eb5"]);
  });

  it("does not change the original score", () => {
    const before = JSON.stringify(score);
    transposeScore(score, parseInterval("m3"));
    changeInstrument(score, score.parts[0]!.id, "horn-f");
    expect(JSON.stringify(score)).toBe(before);
  });
});

describe("score operations", () => {
  it("creates scores from ensemble templates and manages parts", async () => {
    const { newScore, addPart, removePart, movePart, ENSEMBLES, checkScore } = await import("../src");
    const quintet = ENSEMBLES.find((e) => e.id === "brass-quintet")!;
    let score = newScore({ title: "Quintet", parts: quintet.parts, measures: 8 });
    expect(score.parts.map((p) => p.instrument)).toEqual(["trumpet-bb", "trumpet-bb", "horn-f", "trombone", "tuba"]);
    expect(score.measures).toHaveLength(8);
    expect(checkScore(score)).toEqual([]);
    score = addPart(score, "piano", { index: 0 });
    expect(score.parts[0]!.staves).toBe(2);
    score = movePart(score, score.parts[0]!.id, 5);
    expect(score.parts[5]!.instrument).toBe("piano");
    score = removePart(score, score.parts[5]!.id);
    expect(score.parts).toHaveLength(5);
  });
});

describe("part names", () => {
  it("follows a change of pitch within an instrument family", () => {
    const bb = getInstrument("trumpet-bb");
    const c = getInstrument("trumpet-c");
    expect(renameKey("1st Bb Trumpet", bb, c)).toBe("1st C Trumpet");
    expect(renameKey("Trumpet in B♭ 2", bb, c)).toBe("Trumpet in C 2");
    expect(renameKey("Solo Cornet", bb, c)).toBe("Solo Cornet");
    expect(renameKey("1st Bb Trumpet", bb, getInstrument("clarinet-bb"))).toBe("1st Bb Trumpet");
  });
});
