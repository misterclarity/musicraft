import { describe, expect, it, vi } from "vitest";
import type { SampleSet } from "./samples";
import { Synth } from "./synth";

// A recorded trumpet (program 56) with a soft and a loud recording of MIDI 60 and 63, the loud 63
// ten cents sharp, and a piano (program 0) with one recording.
const soft = { duration: 2.4 } as AudioBuffer;
const loud = { duration: 2.4 } as AudioBuffer;
const note = (midi: number, buffer: AudioBuffer, cents = 0, loop = true) => ({
  midi,
  file: `${midi}.mp3`,
  loaded: { midi, buffer, start: 0.001, cents, ...(loop ? { loop: { start: 1.5, end: 2.3 } } : {}) },
});
const sets: Record<number, SampleSet> = {
  56: {
    name: "trumpet",
    sustains: true,
    layers: [
      { velocity: 60, notes: [note(60, soft), note(63, soft)] },
      { velocity: 105, notes: [note(60, loud), note(63, loud, 10)] },
    ],
  },
  0: { name: "piano", sustains: false, layers: [{ velocity: 80, notes: [note(60, soft, 0, false)] }] },
  // A clarinet whose recordings are not loaded yet, but for one at MIDI 50.
  71: {
    name: "clarinet",
    sustains: true,
    layers: [{ velocity: 80, notes: [{ midi: 50, file: "50.mp3", loaded: note(50, soft).loaded }, { midi: 62, file: "62.mp3" }, { midi: 74, file: "74.mp3" }] }],
  },
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
  it("plays the recording of the note's dynamic at the right pitch, in tune, looping while it is held", () => {
    const { context, sources, oscillators } = fakeContext();
    const synth = new Synth(context);
    synth.note(1, 4, 62, 90, { family: "brass", program: 56 }, "part");
    expect(oscillators).toHaveLength(0);
    const source = sources[0] as { buffer: AudioBuffer; playbackRate: { value: number }; loop: boolean; loopStart: number; loopEnd: number; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> };
    // f (90) takes the loud recording; MIDI 62 from the one at 63, which is ten cents sharp: 110 cents down.
    expect(source.buffer).toBe(loud);
    expect(source.playbackRate.value).toBeCloseTo(2 ** (-1.1 / 12));
    expect([source.loop, source.loopStart, source.loopEnd]).toEqual([true, 1.5, 2.3]);
    expect(source.start).toHaveBeenCalledWith(1, 0.001);
    expect(source.stop.mock.calls[0]![0]).toBeCloseTo(5.2);
  });

  it("plays the soft recording for quiet notes", () => {
    const { context, sources } = fakeContext();
    new Synth(context).note(0, 1, 60, 50, { family: "brass", program: 56 }, "part");
    expect((sources[0] as { buffer: AudioBuffer; playbackRate: { value: number } }).buffer).toBe(soft);
    expect((sources[0] as { playbackRate: { value: number } }).playbackRate.value).toBeCloseTo(1);
  });

  it("stands in a loaded recording within a fifth while the right one is downloaded, otherwise the simple sound", () => {
    const { context, sources, oscillators } = fakeContext();
    const synth = new Synth(context);
    // The right recording for MIDI 56 is the one at 50 (loaded); for 62 it's at 62 (not loaded): 50 stands in.
    synth.note(0, 1, 56, 80, { family: "woodwind", program: 71 }, "clarinet");
    synth.note(0, 1, 57, 80, { family: "woodwind", program: 71 }, "clarinet");
    expect((sources[1] as { playbackRate: { value: number } }).playbackRate.value).toBeCloseTo(2 ** (7 / 12));
    expect(sources).toHaveLength(2);
    // MIDI 74 is more than a fifth from the only loaded recording.
    synth.note(0, 1, 74, 80, { family: "woodwind", program: 71 }, "clarinet");
    expect(sources).toHaveLength(2);
    expect(oscillators.length).toBeGreaterThan(0);
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
