import { describe, expect, it } from "vitest";
import { buildPerformance, countInClicks, metronomeClicks, newScore, playedRange, setBarline } from "../src";
import { importText } from "./helpers";

const quarter120 = { bpm: 120, beatUnit: "quarter" as const };

/** A one-part score in a time signature, at quarter = 120 (a quarter lasts half a second). */
function score(beats: number, beatType: number, bars = 2) {
  return newScore({ title: "T", parts: [{ instrument: "trumpet-bb" }], measures: bars, time: { beats, beatType }, tempo: quarter120 });
}

const times = (clicks: { time: number }[]) => clicks.map((c) => Math.round(c.time * 1000) / 1000);
const accents = (clicks: { downbeat: boolean }[]) => clicks.map((c) => (c.downbeat ? "1" : "."));

describe("metronome", () => {
  it("clicks every beat and accents the first of each bar", () => {
    const s = score(4, 4);
    const clicks = metronomeClicks(s, buildPerformance(s));
    expect(times(clicks)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]);
    expect(accents(clicks).join("")).toBe("1...1...");
  });

  it("counts compound time in dotted quarters and cut time in halves", () => {
    const sixEight = score(6, 8);
    expect(times(metronomeClicks(sixEight, buildPerformance(sixEight)))).toEqual([0, 0.75, 1.5, 2.25]);
    const cut = score(2, 2);
    expect(times(metronomeClicks(cut, buildPerformance(cut)))).toEqual([0, 1, 2, 3]);
    const fiveEight = score(5, 8, 1);
    expect(accents(metronomeClicks(fiveEight, buildPerformance(fiveEight))).join("")).toBe("1....");
  });

  it("follows the speed of playback", () => {
    const s = score(4, 4, 1);
    expect(times(metronomeClicks(s, buildPerformance(s, { tempoScale: 0.5 })))).toEqual([0, 1, 2, 3]);
  });

  it("gives a pickup the last beats of a bar, and counts in before it", () => {
    const xml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Trumpet in Bb</part-name></score-part></part-list><part id="P1">
<measure number="0" implicit="yes"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes><direction><sound tempo="120"/></direction><note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note></measure>
<measure number="1"><note><pitch><step>D</step><octave>5</octave></pitch><duration>4</duration><type>whole</type></note></measure>
</part></score-partwise>`;
    const s = importText(xml).score;
    const performance = buildPerformance(s);
    const clicks = metronomeClicks(s, performance);
    expect(times(clicks)).toEqual([0, 0.5, 1, 1.5, 2]);
    expect(accents(clicks).join("")).toBe(".1...");
    // "1, 2, 3" and the pickup comes on 4.
    const countIn = countInClicks(s, performance, 0);
    expect(times(countIn)).toEqual([-1.5, -1, -0.5]);
    expect(accents(countIn).join("")).toBe("1..");
  });

  it("counts in a full bar before a bar that starts on the beat", () => {
    const s = score(3, 4, 3);
    const performance = buildPerformance(s);
    const countIn = countInClicks(s, performance, 1);
    expect(times(countIn)).toEqual([0, 0.5, 1]);
    expect(accents(countIn).join("")).toBe("1..");
    // Two beats a bar is too short a count-in: two bars of 2/2.
    const cut = score(2, 2);
    expect(accents(countInClicks(cut, buildPerformance(cut), 0)).join("")).toBe("1.1.");
  });
});

describe("loops", () => {
  it("finds where selected bars play, the first time through a repeat", () => {
    let s = score(4, 4, 4);
    s = setBarline(s, 1, { repeatStart: true });
    s = setBarline(s, 2, { repeatEnd: {} });
    const performance = buildPerformance(s);
    // Bars 1, 2, 3, 2, 3, 4: bars 2–3 play first at 2 s, until 6 s.
    expect(performance.measures.map((m) => m.measureIndex)).toEqual([0, 1, 2, 1, 2, 3]);
    expect(playedRange(performance, 1, 2)).toEqual({ start: 2, end: 6, firstBar: 1, lastBar: 2 });
    expect(playedRange(performance, 3, 3)).toEqual({ start: 10, end: 12, firstBar: 5, lastBar: 5 });
    expect(playedRange(performance, 9, 9)).toBeNull();
  });
});
