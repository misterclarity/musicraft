/**
 * Recorded instrument notes (see public/samples/LICENSE.txt): real recordings (VSCO 2 and VCSL, both
 * public domain) and, where those have no such instrument or note, notes rendered from a soundfont.
 * Each set has a soft and a loud recording of a note every two to four semitones; the synthesizer
 * plays the nearest one of the right dynamic at the right pitch, looping sustained notes for as long
 * as they last. Only the recordings a score's notes need are downloaded and decoded (a decoded
 * recording takes about half a megabyte of memory), and those it no longer needs are let go.
 */
import { getInstrument, type PerformanceNote, type Score } from "@musicraft/score-core";

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

/** A decoded recording, ready to play. */
export interface SampledNote {
  midi: number;
  buffer: AudioBuffer;
  /** Where the attack starts in the buffer (seconds). */
  start: number;
  /** How sharp the recording is, in cents. */
  cents: number;
  loop?: { start: number; end: number };
}

/** One recording of a set, as the manifest lists it; `loaded` once it is decoded. */
export interface Recording {
  midi: number;
  file: string;
  loaded?: SampledNote;
}

/** The recordings of one dynamic: soft ones stand for up to mf, loud ones for f and more. */
export interface SampleLayer {
  velocity: number;
  /** Lowest first. */
  notes: Recording[];
}

export interface SampleSet {
  name: string;
  /** Wind, strings, organ and voices sustain (and loop); piano and guitar die away. */
  sustains: boolean;
  /** Softest first. */
  layers: SampleLayer[];
}

/** A note to be played with a recording: its instrument (General MIDI program), pitch and loudness. */
export interface WantedNote {
  program: number;
  midi: number;
  velocity: number;
}

const base = () => `${import.meta.env.BASE_URL}samples/`;
let manifestRequest: Promise<Manifest> | null = null;
/** The sets by General MIDI program, once the manifest is in. */
const sets = new Map<number, SampleSet>();
/** Where each recording starts and loops, as the manifest says. */
const listed = new Map<Recording, ManifestNote>();
/** Recordings being downloaded and decoded. */
const loading = new Map<Recording, Promise<void>>();
/** Decoded recordings by file (sets of related instruments share some). */
const buffers = new Map<string, Promise<AudioBuffer>>();
let decoder: BaseAudioContext | null = null;

/** The recordings for a General MIDI program (known once the manifest is in; played once loaded). */
export function sampleSet(program: number): SampleSet | undefined {
  return sets.get(program);
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

/** The recording to play a note with: of its dynamic, nearest its pitch (whether loaded or not). */
export function recordingFor(set: SampleSet, midi: number, velocity: number): Recording {
  return nearestNote(layerFor(set.layers, velocity).notes, midi);
}

/** How far a recording may be shifted when the right one isn't loaded (yet). */
const STAND_IN_RANGE = 7;

/**
 * The loaded recording that plays a note: the right one, or while that is not loaded, the nearest
 * loaded one within a fifth (of the same dynamic if possible). None: play the simple sound.
 */
export function playable(set: SampleSet, midi: number, velocity: number): SampledNote | undefined {
  const layer = layerFor(set.layers, velocity);
  const right = nearestNote(layer.notes, midi).loaded;
  if (right) return right;
  for (const layers of [[layer], set.layers.filter((l) => l !== layer)]) {
    let best: SampledNote | undefined;
    for (const recording of layers.flatMap((l) => l.notes)) {
      const loaded = recording.loaded;
      if (loaded && Math.abs(loaded.midi - midi) <= STAND_IN_RANGE && (!best || Math.abs(loaded.midi - midi) < Math.abs(best.midi - midi))) best = loaded;
    }
    if (best) return best;
  }
  return undefined;
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

async function decodeNote(note: ManifestNote): Promise<SampledNote> {
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

/** The sets of the manifest, without anything loaded yet. */
function readManifest(manifest: Manifest) {
  if (sets.size) return;
  for (const [name, entry] of Object.entries(manifest.sets)) {
    const layers = entry.layers
      .map((layer) => ({
        velocity: layer.velocity,
        notes: layer.notes
          .map((note) => {
            const recording: Recording = { midi: note.midi, file: note.file };
            listed.set(recording, note);
            return recording;
          })
          .sort((a, b) => a.midi - b.midi),
      }))
      .sort((a, b) => a.velocity - b.velocity);
    sets.set(entry.program, { name, sustains: entry.sustains, layers });
  }
}

/** The notes a performance plays with each part's instrument (each pitch and loudness once). */
export function wantedNotes(score: Score, notes: readonly PerformanceNote[], partIds?: ReadonlySet<string>): WantedNote[] {
  const programs = new Map(score.parts.map((p) => [p.id, getInstrument(p.instrument).midiProgram]));
  const wanted = new Map<string, WantedNote>();
  for (const note of notes) {
    const program = programs.get(note.partId);
    if (program === undefined || (partIds && !partIds.has(note.partId))) continue;
    wanted.set(`${program} ${note.midi} ${note.velocity}`, { program, midi: note.midi, velocity: note.velocity });
  }
  return [...wanted.values()];
}

function load(recording: Recording): Promise<void> {
  let request = loading.get(recording);
  if (!request) {
    request = decodeNote(listed.get(recording)!).then((note) => {
      recording.loaded = note;
    });
    void request.finally(() => loading.delete(recording)).catch(() => {});
    loading.set(recording, request);
  }
  return request;
}

/** Let go of every decoded recording except these (and of files no recording plays any more). */
function keepOnly(needed: ReadonlySet<Recording>) {
  for (const set of sets.values()) {
    for (const recording of set.layers.flatMap((l) => l.notes)) if (recording.loaded && !needed.has(recording)) recording.loaded = undefined;
  }
  const files = new Set<string>();
  for (const set of sets.values()) for (const recording of set.layers.flatMap((l) => l.notes)) if (recording.loaded || loading.has(recording)) files.add(recording.file);
  for (const file of buffers.keys()) if (!files.has(file)) buffers.delete(file);
}

/**
 * Download and decode the recordings that play these notes. With `only`, the recordings nothing
 * else needs are let go (for the score being played: what it doesn't play takes no memory).
 * Resolves to the sets some of whose recordings couldn't be loaded (those notes keep the simple
 * synthesizer's sound).
 */
export async function loadSounds(notes: readonly WantedNote[], options: { only?: boolean } = {}): Promise<string[]> {
  try {
    readManifest(await loadManifest());
  } catch {
    return [...new Set(notes.map((n) => String(n.program)))];
  }
  const needed = new Map<Recording, string>();
  for (const note of notes) {
    const set = sets.get(note.program);
    if (set) needed.set(recordingFor(set, note.midi, note.velocity), set.name);
  }
  if (options.only) keepOnly(new Set(needed.keys()));
  const failed = new Set<string>();
  await Promise.all(
    [...needed].map(([recording, name]) =>
      recording.loaded
        ? undefined
        : load(recording).catch(() => {
            failed.add(name);
          }),
    ),
  );
  return [...failed];
}

/** Whether every recording these notes need is loaded. */
export function soundsReady(notes: readonly WantedNote[]): boolean {
  if (!manifestRequest || !sets.size) return false;
  return notes.every((note) => {
    const set = sets.get(note.program);
    return !set || !!recordingFor(set, note.midi, note.velocity).loaded;
  });
}
