/**
 * Recorded instrument notes (see public/samples/LICENSE.txt), loaded only for the instruments a
 * score uses. Each set has a note every three semitones; the synthesizer plays the nearest one at
 * the right pitch, looping sustained notes for as long as they last.
 */
import { getInstrument, type Score } from "@musicraft/score-core";

interface ManifestNote {
  midi: number;
  file: string;
  /** Where the note starts in the recording (seconds). */
  onset: number;
  /** The stretch repeated while a sustained note is held (seconds). */
  loop?: [number, number];
}

export interface Manifest {
  version: number;
  sets: Record<string, { program: number; sustains: boolean; notes: ManifestNote[] }>;
}

export interface SampledNote {
  midi: number;
  buffer: AudioBuffer;
  /** Where the attack starts in the buffer (seconds). */
  start: number;
  loop?: { start: number; end: number };
}

export interface SampleSet {
  name: string;
  /** Wind, strings, organ and voices sustain (and loop); piano and guitar die away. */
  sustains: boolean;
  /** Lowest first. */
  notes: SampledNote[];
}

const base = () => `${import.meta.env.BASE_URL}samples/`;
let manifestRequest: Promise<Manifest> | null = null;
const loading = new Map<string, Promise<SampleSet | null>>();
const loaded = new Map<number, SampleSet>();
let decoder: BaseAudioContext | null = null;

/** The recorded notes for a General MIDI program, once loaded. */
export function sampleSet(program: number): SampleSet | undefined {
  return loaded.get(program);
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

/** Where the sound starts: the first sample above 1% of the loudest in the first second. */
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

async function loadSet(name: string, entry: Manifest["sets"][string]): Promise<SampleSet> {
  decoder ??= new OfflineAudioContext(1, 1, 44100);
  const context = decoder;
  const notes = await Promise.all(
    entry.notes.map(async (note): Promise<SampledNote> => {
      const response = await fetch(`${base()}${note.file}`);
      if (!response.ok) throw new Error(`${note.file}: ${response.status}`);
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      // Some decoders keep the MP3 encoder's delay at the start: move everything by what they add.
      const onset = onsetOf(buffer.getChannelData(0), buffer.sampleRate);
      const shift = onset - note.onset;
      return {
        midi: note.midi,
        buffer,
        start: Math.max(0, onset - 0.002),
        ...(note.loop ? { loop: { start: note.loop[0] + shift, end: Math.min(buffer.duration, note.loop[1] + shift) } } : {}),
      };
    }),
  );
  return { name, sustains: entry.sustains, notes: notes.sort((a, b) => a.midi - b.midi) };
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
