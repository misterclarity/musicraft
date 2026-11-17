import { describe, expect, it, vi } from "vitest";
import type { SampleSet } from "./samples";
import { Synth } from "./synth";

// One recorded instrument: a sustained note at MIDI 60 and 63 (program 56) and a piano note (program 0).
const buffer = { duration: 2.4 } as AudioBuffer;
const sets: Record<number, SampleSet> = {
  56: {
    name: "trumpet",
    sustains: true,
    notes: [
      { midi: 60, buffer, start: 0.001, loop: { start: 1.5, end: 2.3 } },
      { midi: 63, buffer, start: 0.001, loop: { start: 1.5, end: 2.3 } },
    ],
  },
  0: { name: "piano", sustains: false, notes: [{ midi: 60, buffer, start: 0.001 }] },
};
vi.mock("./samples", async (original) => ({
  ...(await original<typeof import("./samples")>()),
  sampleSet: (program: number) => sets[program],
}));

/** Just enough of an AudioContext to see what the synthesizer builds. */
function fakeContext() {
  const param = () => ({ value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), setTargetAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() });
  const node = () => {
    const n: Record<string, unknown> = { connect: vi.fn((target: unknown) => target), disconnect: vi.fn() };
    return n;
  };
  const sources: Record<string, unknown>[] = [];
  const oscillators: unknown[] = [];
  const context = {
    currentTime: 0,
    sampleRate: 44100,
    destination: node(),
    listener: { setPosition: vi.fn(), setOrientation: vi.fn() },
    createGain: () => ({ ...node(), gain: param() }),
    createDynamicsCompressor: () => ({ ...node(), threshold: param(), ratio: param() }),
    createConvolver: () => ({ ...node(), buffer: null }),
    createBiquadFilter: () => ({ ...node(), type: "", Q: param(), frequency: param() }),
    createPanner: () => ({ ...node(), setPosition: vi.fn() }),
    createBuffer: (channels: number, length: number) => ({ getChannelData: () => new Float32Array(length), numberOfChannels: channels }),
    createBufferSource: () => {
      const source = { ...node(), buffer: null, loop: false, loopStart: 0, loopEnd: 0, playbackRate: param(), start: vi.fn(), stop: vi.fn() };
      sources.push(source);
      return source;
    },
    createOscillator: () => {
      const oscillator = { ...node(), type: "", frequency: param(), detune: param(), start: vi.fn(), stop: vi.fn() };
      oscillators.push(oscillator);
      return oscillator;
    },
  };
  return { context: context as unknown as BaseAudioContext, sources, oscillators };
}

describe("synthesizer", () => {
  it("plays a recorded note at the right pitch, looping while it is held", () => {
    const { context, sources, oscillators } = fakeContext();
    const synth = new Synth(context);
    synth.note(1, 4, 62, 90, { family: "brass", program: 56 }, "part");
    expect(oscillators).toHaveLength(0);
    const source = sources[0] as { playbackRate: { value: number }; loop: boolean; loopStart: number; loopEnd: number; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    // MIDI 62 from the recording at 63: a semitone down.
    expect(source.playbackRate.value).toBeCloseTo(2 ** (-1 / 12));
    expect([source.loop, source.loopStart, source.loopEnd]).toEqual([true, 1.5, 2.3]);
    expect(source.start).toHaveBeenCalledWith(1, 0.001);
    expect(source.stop.mock.calls[0]![0]).toBeCloseTo(5.2);
  });

  it("lets a piano note die away, and keeps the simple sound when told to or when nothing is recorded", () => {
    const { context, sources, oscillators } = fakeContext();
    const synth = new Synth(context);
    synth.note(0, 1, 60, 90, { family: "keyboard", program: 0 }, "piano");
    expect((sources[0] as { loop: boolean }).loop).toBe(false);
    synth.note(0, 1, 60, 90, { family: "woodwind", program: 73 }, "flute");
    expect(sources).toHaveLength(1);
    expect(oscillators.length).toBeGreaterThan(0);
    synth.useSamples = false;
    synth.note(0, 1, 60, 90, { family: "brass", program: 56 }, "trumpet");
    expect(sources).toHaveLength(1);
  });
});
