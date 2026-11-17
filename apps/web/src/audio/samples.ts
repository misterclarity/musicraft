/**
 * Recorded instrument notes (see public/samples/LICENSE.txt), loaded only for the instruments a
 * score uses: real recordings (VSCO 2 and VCSL, both public domain) and, where those have no such
 * instrument or note, notes rendered from a soundfont. Each set has a soft and a loud recording of
 * a note every two to four semitones; the synthesizer plays the nearest one of the right dynamic at
 * the right pitch, looping sustained notes for as long as they last.
 */
import { getInstrument, type Score } from "@musicraft/score-core";

interface ManifestNote {
  midi: number;
  file: string;
  /** Where the note starts in the recording (seconds). */
  onset: number;
  /** How far the recording is from the note's pitch, in cents (+ is sharp). */
  cents?: number;
  /** The stretch repeated while a sustained note is held (seconds). */
  loop?: [number, number];
}

export interface Manifest {
  version: number;
  sets: Record<string, { program: number; sustains: boolean; sources?: string[]; layers: { velocity: number; notes: ManifestNote[] }[] }>;
}

export interface SampledNote {
  midi: number;
  buffer: AudioBuffer;
  /** Where the attack starts in the buffer (seconds). */
  start: number;
  /** How sharp the recording is, in cents. */
  cents: number;
  loop?: { start: number; end: number };
}

/** The notes of one dynamic: soft recordings stand for up to mf, loud ones for f and more. */
export interface SampleLayer {
  velocity: number;
  /** Lowest first. */
  notes: SampledNote[];
}

export interface SampleSet {
  name: string;
  /** Wind, strings, organ and voices sustain (and loop); piano and guitar die away. */
  sustains: boolean;
  /** Softest first. */
  layers: SampleLayer[];
}

const base = () => `${import.meta.env.BASE_URL}samples/`;
let manifestRequest: Promise<Manifest> | null = null;
const loading = new Map<string, Promise<SampleSet | null>>();
const loaded = new Map<number, SampleSet>();
/** Decoded recordings by file (sets of related instruments share some). */
const buffers = new Map<string, Promise<AudioBuffer>>();
let decoder: BaseAudioContext | null = null;

/** The recorded notes for a General MIDI program, once loaded. */
export function sampleSet(program: number): SampleSet | undefined {
  return loaded.get(program);
}

/** The layer for a loudness: the one whose velocity is nearest (the louder one when as near). */
export function layerFor<T extends { velocity: number }>(layers: T[], velocity: number): T {
  let best = layers[0]!;
  for (const layer of layers) {
    const distance = Math.abs(layer.velocity - velocity);
    const bestDistance = Math.abs(best.velocity - velocity);
    if (distance < bestDistance || (distance === bestDistance && layer.velocity > best.velocity)) best = layer;
  }
  return best;
}

/** The recorded note to play for a pitch: the nearest, or the one above when two are as near (shifting down sounds more natural). */
export function nearestNote<T extends { midi: number }>(notes: T[], midi: number): T {
  let best = notes[0]!;
  for (const note of notes) {
    const distance = Math.abs(note.midi - midi);
    const bestDistance = Math.abs(best.midi - midi);
    if (distance < bestDistance || (distance === bestDistance && note.midi > best.midi)) best = note;
  }
  return best;
}

/**
 * Where the sound starts: the first sample above 1% of the loudest in the first second. The
 * manifest's onsets are measured the same way (scripts/build-samples.py, app_onset), so a decoder
 * that left the encoder's delay in shows up as a recording that starts late.
 */
export function onsetOf(samples: Float32Array, rate: number): number {
  const window = samples.subarray(0, Math.min(samples.length, rate));
  let peak = 0;
  for (const v of window) peak = Math.max(peak, Math.abs(v));
  const threshold = peak * 0.01;
  for (let i = 0; i < window.length; i++) if (Math.abs(window[i]!) > threshold) return i / rate;
  return 0;
}

function loadManifest(): Promise<Manifest> {
  manifestRequest ??= fetch(`${base()}manifest.json`).then(async (response) => {
    if (!response.ok) throw new Error(`The instrument sounds aren't there (${response.status}).`);
    return (await response.json()) as Manifest;
  });
  manifestRequest.catch(() => {
    manifestRequest = null;
  });
  return manifestRequest;
}

function decodeFile(file: string): Promise<AudioBuffer> {
  let request = buffers.get(file);
  if (!request) {
    decoder ??= new OfflineAudioContext(1, 1, 44100);
    const context = decoder;
    request = fetch(`${base()}${file}`).then(async (response) => {
      if (!response.ok) throw new Error(`${file}: ${response.status}`);
      return context.decodeAudioData(await response.arrayBuffer());
    });
    request.catch(() => buffers.delete(file));
    buffers.set(file, request);
  }
  return request;
}

/**
 * The MP3 encoder puts 1105 samples before the sound; decoders that read its header (browsers do)
 * take them out again. One that doesn't leaves everything this much later.
 */
export const ENCODER_DELAY = 1105 / 44100;

/**
 * How much later than the manifest says a decoded recording starts: the encoder's delay if the
 * decoder left it in, otherwise nothing (the codec blurs an attack by a millisecond or two, which
 * must not move the loop).
 */
export function decoderDelay(found: number, expected: number): number {
  return found - expected > ENCODER_DELAY / 2 ? ENCODER_DELAY : 0;
}

async function loadNote(note: ManifestNote): Promise<SampledNote> {
  const buffer = await decodeFile(note.file);
  const shift = decoderDelay(onsetOf(buffer.getChannelData(0), buffer.sampleRate), note.onset);
  return {
    midi: note.midi,
    buffer,
    start: Math.max(0, note.onset + shift - 0.002),
    cents: note.cents ?? 0,
    ...(note.loop ? { loop: { start: note.loop[0] + shift, end: Math.min(buffer.duration, note.loop[1] + shift) } } : {}),
  };
}

async function loadSet(name: string, entry: Manifest["sets"][string]): Promise<SampleSet> {
  const layers = await Promise.all(
    entry.layers.map(async (layer) => ({
      velocity: layer.velocity,
      notes: (await Promise.all(layer.notes.map(loadNote))).sort((a, b) => a.midi - b.midi),
    })),
  );
  return { name, sustains: entry.sustains, layers: layers.sort((a, b) => a.velocity - b.velocity) };
}

/** The General MIDI programs a score's instruments play with. */
export function programsOf(score: Score): number[] {
  return [...new Set(score.parts.map((p) => getInstrument(p.instrument).midiProgram))];
}

/**
 * Load the recorded notes of a score's instruments (each set once). Resolves to the instruments
 * that couldn't be loaded (they keep the simple synthesizer's sound).
 */
export async function loadSounds(programs: number[]): Promise<string[]> {
  let manifest: Manifest;
  try {
    manifest = await loadManifest();
  } catch {
    return programs.map(String);
  }
  const failed: string[] = [];
  await Promise.all(
    programs.map(async (program) => {
      if (loaded.has(program)) return;
      const name = Object.keys(manifest.sets).find((key) => manifest.sets[key]!.program === program);
      if (!name) return;
      let request = loading.get(name);
      if (!request) {
        request = loadSet(name, manifest.sets[name]!).then(
          (set) => {
            loaded.set(program, set);
            return set;
          },
          () => {
            loading.delete(name);
            return null;
          },
        );
        loading.set(name, request);
      }
      if (!(await request)) failed.push(name);
    }),
  );
  return failed;
}
