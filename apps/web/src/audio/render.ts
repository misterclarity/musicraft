/**
 * Audio files of a score: the same instruments, room and seating as playback, rendered faster
 * than real time with an OfflineAudioContext. A play-along leaves out the parts you play yourself.
 */
import { buildPerformance, countInClicks, getInstrument, metronomeClicks, type Score } from "@musicraft/score-core";
import { loadSounds, wantedNotes } from "./samples";
import { Synth, type Room, type Vec3 } from "./synth";

export interface RenderOptions {
  /** The parts to hear (all of them by default). */
  partIds?: string[];
  /** 1 = as written, 0.75 = slower. */
  speed?: number;
  /** A bar of clicks before the music starts. */
  countIn?: boolean;
  /** A click on every beat throughout. */
  metronome?: boolean;
  /** Recorded instruments (default), or the simple synthesizer. */
  recorded?: boolean;
  /** The concert hall's reverberation, or none. */
  room?: Extract<Room, "dry" | "hall">;
  /** Volume per part id, 1 = as written. */
  volumes?: Record<string, number>;
  /** Where each part sits, for the stereo picture (see Synth.setChannelPosition). */
  positions?: ReadonlyMap<string, Vec3>;
  sampleRate?: number;
  /** How far rendering has got, 0 to 1. */
  onProgress?: (fraction: number) => void;
}

/** Render a score to stereo audio. */
export async function renderAudio(score: Score, options: RenderOptions = {}): Promise<AudioBuffer> {
  const rate = options.sampleRate ?? 44100;
  const performance = buildPerformance(score, { tempoScale: options.speed ?? 1 });
  const included = new Set(options.partIds ?? score.parts.map((p) => p.id));
  const countIn = options.countIn ? countInClicks(score, performance, 0) : [];
  const lead = countIn.length ? -countIn[0]!.time : 0;
  const room = options.room ?? "hall";
  const tail = room === "hall" ? 2.8 : 1;
  const length = Math.max(1, Math.ceil((lead + performance.duration + tail) * rate));
  const context = new OfflineAudioContext(2, length, rate);

  const recorded = options.recorded ?? true;
  if (recorded) await loadSounds(wantedNotes(score, performance.notes, included));
  const synth = new Synth(context);
  synth.useSamples = recorded;
  synth.setSpace("stereo", room);
  for (const part of score.parts) {
    if (!included.has(part.id)) continue;
    synth.setChannelGain(part.id, options.volumes?.[part.id] ?? 1);
    const position = options.positions?.get(part.id);
    if (position) synth.setChannelPosition(part.id, position);
  }

  const sounds = new Map(
    score.parts.map((p) => {
      const instrument = getInstrument(p.instrument);
      return [p.id, { family: instrument.family, program: instrument.midiProgram }];
    }),
  );
  for (const note of performance.notes) {
    if (!included.has(note.partId)) continue;
    synth.note(lead + note.start, note.duration, note.midi, note.velocity, sounds.get(note.partId)!, note.partId);
  }
  for (const click of countIn) synth.click(lead + click.time, click.downbeat);
  if (options.metronome) for (const click of metronomeClicks(score, performance)) synth.click(lead + click.time, click.downbeat);

  // Report progress every few seconds of audio, where the browser can pause rendering.
  if (options.onProgress && typeof context.suspend === "function") {
    const seconds = length / rate;
    for (let t = 5; t < seconds; t += 5) {
      context
        .suspend(t)
        .then(() => {
          options.onProgress?.(t / seconds);
          return context.resume();
        })
        .catch(() => {
          // This browser can't pause offline rendering: no progress, just the result.
        });
    }
  }
  const buffer = await context.startRendering();
  options.onProgress?.(1);
  return buffer;
}

/** A 16-bit PCM WAV file of audio, turned down if it would clip. */
export function encodeWav(buffer: AudioBuffer): Blob {
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;
  const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c));
  let peak = 0;
  for (const channel of data) for (let i = 0; i < frames; i++) peak = Math.max(peak, Math.abs(channel[i]!));
  const scale = peak > 0.99 ? 0.99 / peak : 1;
  const bytes = new ArrayBuffer(44 + frames * channels * 2);
  const view = new DataView(bytes);
  const text = (at: number, s: string) => [...s].forEach((ch, i) => view.setUint8(at + i, ch.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + frames * channels * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frames * channels * 2, true);
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      const v = Math.max(-1, Math.min(1, data[c]![i]! * scale));
      view.setInt16(at, Math.round(v * 32767), true);
      at += 2;
    }
  }
  return new Blob([bytes], { type: "audio/wav" });
}
