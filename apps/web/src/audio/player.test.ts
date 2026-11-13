import { buildPerformance, enterNote, newScore, type Score } from "@musicraft/score-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelGain, EMPTY_MIX, isAudible, Player, samePlace, type Mix } from "./player";

// A synthesizer without sound: a clock the test moves on, and a record of the notes played.
vi.mock("./synth", () => ({
  Synth: class {
    context = { currentTime: 0, state: "running", resume: async () => {}, close: async () => {} };
    note = vi.fn();
    stopAll = vi.fn();
    setSpace() {}
    setListener() {}
    setChannelPosition() {}
    setChannelGain() {}
  },
}));

/** A trumpet part with a whole note in each of four bars: C, D, E, F. */
function fourBars(): Score {
  let score = newScore({ title: "T", parts: [{ instrument: "trumpet-bb" }], measures: 4 });
  (["C", "D", "E", "F"] as const).forEach((step, bar) => {
    const event = score.parts[0]!.measures[bar]!.voices[0]!.events[0]!;
    score = enterNote(score, event.id, step, { inputDuration: { type: "whole", dots: 0 } }).score;
  });
  return score;
}

const mix = (parts: Partial<Mix>): Mix => ({ ...EMPTY_MIX, ...parts });

describe("the mix", () => {
  it("silences muted parts, and all but the solo parts when any is solo", () => {
    expect(isAudible(EMPTY_MIX, "a")).toBe(true);
    expect(isAudible(mix({ muted: new Set(["a"]) }), "a")).toBe(false);
    const solo = mix({ solo: new Set(["b"]) });
    expect(isAudible(solo, "a")).toBe(false);
    expect(isAudible(solo, "b")).toBe(true);
    // Muted wins over solo.
    expect(isAudible(mix({ solo: new Set(["b"]), muted: new Set(["b"]) }), "b")).toBe(false);
  });

  it("plays each part at its volume, and silent parts at none", () => {
    const volumes = new Map([["a", 0.5]]);
    expect(channelGain(mix({ volumes }), "a")).toBe(0.5);
    expect(channelGain(mix({ volumes }), "b")).toBe(1);
    expect(channelGain(mix({ volumes, muted: new Set(["a"]) }), "a")).toBe(0);
  });
});

describe("changing speed", () => {
  const score = fourBars();
  const normal = buildPerformance(score, { tempoScale: 1 });
  const slow = buildPerformance(score, { tempoScale: 0.5 });

  it("finds the same place in the music at another speed", () => {
    const bar = normal.measures[2]!;
    expect(samePlace(normal, slow, bar.start)).toBeCloseTo(slow.measures[2]!.start);
    expect(samePlace(normal, slow, bar.start + bar.duration / 4)).toBeCloseTo(slow.measures[2]!.start + slow.measures[2]!.duration / 4);
    expect(samePlace(normal, slow, 0)).toBe(0);
    expect(samePlace(normal, slow, normal.duration + 5)).toBeCloseTo(slow.duration);
  });

  describe("while playing", () => {
    beforeEach(() => {
      vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
      vi.stubGlobal("cancelAnimationFrame", vi.fn());
    });
    afterEach(() => vi.unstubAllGlobals());

    it("carries on from the same bar, with its notes", async () => {
      const player = new Player();
      player.load(score, normal);
      await player.play(normal.measures[2]!.start);
      const synth = (player as unknown as { synth: { context: { currentTime: number }; note: ReturnType<typeof vi.fn>; stopAll: ReturnType<typeof vi.fn> } }).synth;
      synth.context.currentTime += 0.08 + 0.5;
      const at = player.position;
      expect(at).toBeCloseTo(normal.measures[2]!.start + 0.5);

      player.load(score, slow, samePlace(normal, slow, at));
      expect(player.isPlaying).toBe(true);
      expect(synth.stopAll).toHaveBeenCalled();
      synth.context.currentTime += 0.08;
      // Half a second into bar 3 at full speed is a second into it at half speed.
      expect(player.position).toBeCloseTo(slow.measures[2]!.start + 1);
      // Bar 4's note comes when bar 4 starts at the new speed, not before and not twice.
      synth.note.mockClear();
      synth.context.currentTime += slow.measures[3]!.start - player.position - 0.2;
      (player as unknown as { schedule(): void }).schedule();
      expect(synth.note.mock.calls.map((call) => call[2])).toEqual([slow.notes[3]!.midi]);
      player.stop();
    });
  });
});
