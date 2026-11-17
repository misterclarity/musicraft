import { newScore } from "@musicraft/score-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PRACTICE, trainerSpeed, usePlayback } from "./playback";

vi.mock("../audio/synth", () => ({
  Synth: class {
    context = { currentTime: 0, state: "running", resume: async () => {}, close: async () => {} };
    note = vi.fn();
    click = vi.fn();
    stopAll = vi.fn();
    setSpace() {}
    setListener() {}
    setChannelPosition() {}
    setChannelGain() {}
  },
}));

const fourBars = () => newScore({ title: "T", parts: [{ instrument: "trumpet-bb" }], measures: 4 });

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  usePlayback.getState().setPractice(DEFAULT_PRACTICE);
  // No downloads here: the simple synthesizer.
  usePlayback.getState().setRecorded(false);
});
afterEach(() => {
  usePlayback.getState().stop();
  usePlayback.getState().setTempo(1);
  vi.unstubAllGlobals();
});

describe("playback speed", () => {
  it("keeps the place in the music when the speed changes while stopped", () => {
    const score = fourBars();
    const playback = usePlayback.getState();
    playback.load(score);
    const bar3 = usePlayback.getState().performance!.measures[2]!.start;
    playback.seek(bar3);
    playback.setTempo(0.5);
    const slow = usePlayback.getState().performance!;
    expect(slow.measures[2]!.start).toBeCloseTo(bar3 * 2);
    expect(usePlayback.getState().position).toBeCloseTo(slow.measures[2]!.start);
    usePlayback.getState().setTempo(1);
    expect(usePlayback.getState().position).toBeCloseTo(bar3);
  });
});

describe("practising", () => {
  it("remembers the settings, and the speed trainer needs a loop", () => {
    usePlayback.getState().setPractice({ trainer: true });
    expect(usePlayback.getState().practice.loop).toBe(true);
    expect(JSON.parse(localStorage.getItem("musicraft.practice")!)).toMatchObject({ trainer: true, loop: true });
    usePlayback.getState().setPractice({ loop: false });
    expect(usePlayback.getState().practice.trainer).toBe(false);
  });

  it("raises the speed each time round, up to its target", () => {
    expect([0, 1, 2, 6, 7].map((pass) => trainerSpeed({ start: 0.7, step: 0.05, target: 1 }, pass))).toEqual([0.7, 0.75, 0.8, 1, 1]);
  });

  it("starts a speed-trainer loop slowly, at its first bar", async () => {
    usePlayback.getState().load(fourBars());
    usePlayback.getState().setPractice({ trainer: true, start: 0.6 });
    // Bars 2–3 are selected; playing from bar 3 still starts the loop at bar 2.
    const normal = usePlayback.getState().performance!;
    await usePlayback.getState().play(normal.measures[2]!.start, { from: 1, to: 2 });
    const state = usePlayback.getState();
    expect(state.playing).toBe(true);
    expect(state.tempo).toBe(0.6);
    expect(state.performance!.measures[1]!.start).toBeCloseTo(normal.measures[1]!.start / 0.6);
    expect(state.position).toBeCloseTo(state.performance!.measures[1]!.start);
  });
});
