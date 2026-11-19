import { afterEach, describe, expect, it, vi } from "vitest";
import { CHORD_WINDOW, ChordGatherer, parseMidi } from "./midi";

describe("MIDI keyboards", () => {
  afterEach(() => vi.useRealTimers());

  it("reads key presses and releases from MIDI messages, on any channel", () => {
    expect(parseMidi([0x90, 60, 100])).toEqual({ on: true, note: 60, velocity: 100 });
    expect(parseMidi([0x93, 64, 30])).toEqual({ on: true, note: 64, velocity: 30 });
    // A press with velocity 0 is a release, as many keyboards send it.
    expect(parseMidi([0x90, 60, 0])).toEqual({ on: false, note: 60, velocity: 0 });
    expect(parseMidi([0x80, 60, 64])).toEqual({ on: false, note: 60, velocity: 0 });
    // Pedals, pitch bend, clock: not keys.
    expect(parseMidi([0xb0, 64, 127])).toBeNull();
    expect(parseMidi([0xf8])).toBeNull();
  });

  it("gathers keys pressed together into a chord, and the next key into the next", () => {
    vi.useFakeTimers();
    const chords: [number[], number][] = [];
    const gatherer = new ChordGatherer((notes, velocity) => chords.push([notes, velocity]));
    gatherer.press(60, 80);
    vi.advanceTimersByTime(10);
    gatherer.press(64, 100);
    gatherer.press(67, 90);
    vi.advanceTimersByTime(CHORD_WINDOW * 1000);
    expect(chords).toEqual([[[60, 64, 67], 100]]);
    gatherer.press(72, 50);
    vi.advanceTimersByTime(CHORD_WINDOW * 1000);
    expect(chords[1]).toEqual([[72], 50]);
    gatherer.press(74, 50);
    gatherer.dispose();
    vi.advanceTimersByTime(1000);
    expect(chords).toHaveLength(2);
  });
});
