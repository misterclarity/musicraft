import { buildPerformance, enterNote, newScore, type Score } from "@musicraft/score-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channelGain, EMPTY_MIX, isAudible, Player, samePlace, type Mix } from "./player";

// A synthesizer without sound: a clock the test moves on, and a record of the notes played.
vi.mock("./synth", () => ({
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

      player.load(score, slow);
      await player.play(samePlace(normal, slow, at));
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

interface FakeSynth {
  context: { currentTime: number };
  note: ReturnType<typeof vi.fn>;
  click: ReturnType<typeof vi.fn>;
  stopAll: ReturnType<typeof vi.fn>;
}

describe("practising", () => {
  let frame: FrameRequestCallback | null = null;
  beforeEach(() => {
    frame = null;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frame = callback;
        return 1;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  /** Four bars of whole notes (C, D, E, F) at quarter = 120: two seconds a bar. */
  function march(): Score {
    let s = newScore({ title: "T", parts: [{ instrument: "trumpet-bb" }], measures: 4, tempo: { bpm: 120, beatUnit: "quarter" } });
    (["C", "D", "E", "F"] as const).forEach((step, bar) => {
      s = enterNote(s, s.parts[0]!.measures[bar]!.voices[0]!.events[0]!.id, step, { inputDuration: { type: "whole", dots: 0 } }).score;
    });
    return s;
  }
  const synthOf = (player: Player) => (player as unknown as { synth: FakeSynth }).synth;
  /** Move the audio clock on, letting the player schedule and draw every 50 ms as it would. */
  const advance = (player: Player, seconds: number) => {
    const context = synthOf(player).context;
    const end = context.currentTime + seconds;
    while (context.currentTime < end - 1e-9) {
      context.currentTime = Math.min(end, context.currentTime + 0.05);
      (player as unknown as { schedule(): void }).schedule();
      frame?.(0);
    }
  };

  it("counts in a bar before the first note", async () => {
    const s = march();
    const performance = buildPerformance(s);
    const player = new Player();
    player.load(s, performance);
    await player.play(0, { countIn: true });
    const synth = synthOf(player);
    // Four clicks half a second apart, the first one louder; no note yet.
    expect(synth.click.mock.calls.map((call) => [Math.round(call[0] * 100) / 100, call[1]])).toEqual([
      [0.08, true],
      [0.58, false],
      [1.08, false],
      [1.58, false],
    ]);
    expect(synth.note).not.toHaveBeenCalled();
    expect(player.position).toBe(0);
    advance(player, 1.9);
    expect(synth.note.mock.calls.map((call) => Math.round(call[0] * 100) / 100)).toEqual([2.08]);
    player.stop();
  });

  it("clicks every beat while the metronome is on", async () => {
    const s = march();
    const player = new Player();
    player.load(s, buildPerformance(s));
    player.setMetronome(true);
    await player.play(0);
    advance(player, 1.8);
    const synth = synthOf(player);
    expect(synth.click.mock.calls.map((call) => call[1])).toEqual([true, false, false, false, true]);
    // Switched off, it stops at once and doesn't catch up when switched on again.
    player.setMetronome(false);
    advance(player, 1);
    player.setMetronome(true);
    synth.click.mockClear();
    advance(player, 0.5);
    expect(synth.click.mock.calls.map((call) => Math.round(call[0] * 100) / 100)).toEqual([3.58]);
    player.stop();
  });

  it("loops a stretch, each pass at the speed it asks for, and stops when there is no next pass", async () => {
    const s = march();
    const normal = buildPerformance(s);
    const slow = buildPerformance(s, { tempoScale: 0.5 });
    const onPass = vi.fn();
    const onEnd = vi.fn();
    const player = new Player({ onPass, onEnd });
    player.load(s, normal);
    // Bars 2–3 (2 s to 6 s); the first repeat at half speed (4 s to 12 s), then stop.
    const next = vi.fn((pass: number) => (pass === 1 ? { performance: slow, from: 4, to: 12 } : null));
    await player.play(2, { to: 6, next });
    const synth = synthOf(player);
    const played = () => synth.note.mock.calls.map((call) => [Math.round(call[0] * 100) / 100, call[2]]);
    advance(player, 3.6);
    expect(played()).toEqual([
      [0.08, normal.notes[1]!.midi],
      [2.08, normal.notes[2]!.midi],
    ]);
    expect(next).not.toHaveBeenCalled();
    // The repeat starts right where the first pass ends (4.08 s), at half speed.
    advance(player, 0.4);
    expect(next).toHaveBeenCalledWith(1);
    expect(played()[2]).toEqual([4.08, slow.notes[1]!.midi]);
    expect(onPass).not.toHaveBeenCalled();
    advance(player, 0.1);
    expect(onPass).toHaveBeenCalledWith(1, slow);
    expect(player.position).toBeCloseTo(4.02, 2);
    advance(player, 4);
    expect(played()[3]).toEqual([8.08, slow.notes[2]!.midi]);
    // No third pass: it ends after the second.
    advance(player, 4.5);
    expect(next).toHaveBeenCalledWith(2);
    expect(onEnd).toHaveBeenCalled();
    expect(player.isPlaying).toBe(false);
  });

  it("takes over an edit while playing without playing a note twice", async () => {
    const s = march();
    const player = new Player();
    player.load(s, buildPerformance(s));
    await player.play(0);
    advance(player, 0.5);
    const synth = synthOf(player);
    expect(synth.note).toHaveBeenCalledTimes(1);
    // The same music again (as after an edit elsewhere): bar 1's note is not played again.
    player.load(s, buildPerformance(s));
    advance(player, 2);
    expect(synth.note).toHaveBeenCalledTimes(2);
    player.stop();
  });
});
