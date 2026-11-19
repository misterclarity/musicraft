import {
  countInClicks,
  getInstrument,
  metronomeClicks,
  type Click,
  type Performance,
  type PerformanceNote,
  type Score,
} from "@musicraft/score-core";
import { Synth, type Room, type Sound, type SpaceMode, type Vec3 } from "./synth";

export type { Room, SpaceMode, Vec3 } from "./synth";

const LOOKAHEAD = 0.35;
const TICK_MS = 60;

export interface PlayerCallbacks {
  /** Called every animation frame while playing, with the score time and the notes sounding then. */
  onTick?: (time: number, notes: PerformanceNote[]) => void;
  onEnd?: () => void;
  /** A loop began another pass, playing this performance (its speed may have changed). */
  onPass?: (pass: number, performance: Performance) => void;
}

/** Which parts are heard, and how loud: muted parts are silent; if any part is solo, only solo parts play. */
export interface Mix {
  muted: ReadonlySet<string>;
  solo: ReadonlySet<string>;
  /** Volume per part, 1 = as written. */
  volumes: ReadonlyMap<string, number>;
}

export const EMPTY_MIX: Mix = { muted: new Set(), solo: new Set(), volumes: new Map() };

export function isAudible(mix: Mix, partId: string): boolean {
  return !mix.muted.has(partId) && (mix.solo.size === 0 || mix.solo.has(partId));
}

/** The gain of a part's channel: its volume, or nothing when it isn't heard. */
export function channelGain(mix: Mix, partId: string): number {
  return isAudible(mix, partId) ? (mix.volumes.get(partId) ?? 1) : 0;
}

/**
 * The time in performance `to` at the same place in the music as `time` in performance `from`: the
 * same played bar, and as far into it. For a change of speed, or of the tempo marks.
 */
export function samePlace(from: Performance, to: Performance, time: number): number {
  const bars = from.measures;
  let i = bars.length - 1;
  while (i > 0 && bars[i]!.start > time) i--;
  const bar = bars[i];
  const target = to.measures[i];
  if (!bar || !target) return Math.max(0, Math.min(time, to.duration));
  const into = bar.duration > 0 ? Math.max(0, Math.min(1, (time - bar.start) / bar.duration)) : 0;
  return target.start + into * target.duration;
}

/** A stretch of a performance to play, in its seconds. */
export interface Stretch {
  performance: Performance;
  from: number;
  to: number;
}

export interface PlayOptions {
  /** Click a bar (or the beats before a pickup) before the music starts; only from the start of a bar. */
  countIn?: boolean;
  /** Where the first stretch ends (seconds); the end of the performance by default. */
  to?: number;
  /** What plays after a stretch, for a loop: pass 1 is the first repeat. Null stops there. */
  next?: (pass: number) => Stretch | null;
}

/** A stretch on the audio clock: performance second `from` sounds at context time `at`. */
interface Segment extends Stretch {
  at: number;
  pass: number;
  /** Another pass follows: notes are cut at `to`. */
  loops: boolean;
  clicks: Click[];
  nextNote: number;
  nextClick: number;
  /** Performance time up to which notes and clicks are scheduled. */
  scheduledTo: number;
}

interface Listener {
  position: Vec3;
  forward: Vec3;
}

function firstAtOrAfter<T>(items: T[], time: (item: T) => number, at: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (time(items[mid]!) < at - 1e-6) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Plays a Performance (timed notes) through the synthesizer, with lookahead scheduling: once, or a
 * stretch of it over and over (each pass may be another performance, e.g. a little faster), with a
 * metronome and a count-in if asked.
 */
export class Player {
  private synth: Synth | null = null;
  private score: Score | null = null;
  private performance: Performance = { notes: [], measures: [], tempos: [], timeSignatures: [], duration: 0 };
  private sounds = new Map<string, Sound>();
  private recordedSounds = true;
  private partIds: string[] = [];
  private mix: Mix = EMPTY_MIX;
  private positions = new Map<string, Vec3>();
  private space: { mode: SpaceMode; room: Room } = { mode: "stereo", room: "dry" };
  private listener: Listener = { position: { x: 0, y: 1.6, z: 1.5 }, forward: { x: 0, y: 0, z: -1 } };
  private metronome = false;
  private clickVolume = 0.7;
  private clicks = new WeakMap<Performance, Click[]>();
  private segments: Segment[] = [];
  private options: PlayOptions = {};
  private startOffset = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private playing = false;

  constructor(private callbacks: PlayerCallbacks = {}) {}

  /** Play these notes. While playing, the new notes take over where the old ones were scheduled to (an edit). */
  load(score: Score, performance: Performance) {
    const previous = this.performance;
    this.score = score;
    this.performance = performance;
    this.sounds = new Map(
      score.parts.map((p) => {
        const instrument = getInstrument(p.instrument);
        return [p.id, { family: instrument.family, program: instrument.midiProgram }];
      }),
    );
    this.partIds = score.parts.map((p) => p.id);
    this.applyMix();
    for (const segment of this.segments) {
      if (segment.performance !== previous) continue;
      const lastBar = !segment.loops && segment.to >= previous.duration - 1e-6;
      segment.performance = performance;
      if (lastBar) segment.to = performance.duration;
      segment.clicks = this.clicksOf(performance);
      segment.nextNote = firstAtOrAfter(performance.notes, (n) => n.start, segment.scheduledTo);
      segment.nextClick = firstAtOrAfter(segment.clicks, (c) => c.time, segment.scheduledTo);
    }
    if (!this.playing) this.startOffset = Math.max(0, Math.min(this.startOffset, performance.duration));
  }

  setMix(mix: Mix) {
    this.mix = mix;
    this.applyMix();
  }

  /** Recorded instruments where they are loaded, or always the simple synthesizer. */
  setRecordedSounds(on: boolean) {
    this.recordedSounds = on;
    if (this.synth) this.synth.useSamples = on;
  }

  /** Click on every beat (also while playing: from the next beat). */
  setMetronome(on: boolean, volume = this.clickVolume) {
    this.metronome = on;
    this.clickVolume = volume;
  }

  /** Where each part sits (see Synth.setChannelPosition). */
  setPositions(positions: ReadonlyMap<string, Vec3>) {
    this.positions = new Map(positions);
    if (this.synth) for (const [id, position] of this.positions) this.synth.setChannelPosition(id, position);
  }

  setSpace(mode: SpaceMode, room: Room) {
    this.space = { mode, room };
    this.synth?.setSpace(mode, room);
  }

  setListener(position: Vec3, forward: Vec3) {
    this.listener = { position, forward };
    this.synth?.setListener(position, forward);
  }

  get isPlaying() {
    return this.playing;
  }

  /** Where playback is, in seconds of the performance that is sounding now. */
  get position(): number {
    if (!this.playing || !this.synth) return this.startOffset;
    const now = this.synth.context.currentTime;
    const segment = this.current(now);
    if (!segment) return this.startOffset;
    return Math.min(segment.to, Math.max(segment.from, segment.from + (now - segment.at)));
  }

  private ensureSynth(): Synth {
    if (!this.synth) {
      this.synth = new Synth();
      this.synth.useSamples = this.recordedSounds;
      this.synth.setSpace(this.space.mode, this.space.room);
      this.synth.setListener(this.listener.position, this.listener.forward);
      for (const [id, position] of this.positions) this.synth.setChannelPosition(id, position);
      this.applyMix();
    }
    return this.synth;
  }

  /** Get the sound going (browsers only allow it in answer to a click or a key). */
  async wake() {
    const audio = this.ensureSynth().context as AudioContext;
    if (audio.state === "suspended") await audio.resume().catch(() => {});
  }

  /** Sound one note now through a part's channel: a key played on a MIDI keyboard. */
  async audition(midi: number, velocity: number, partId: string) {
    const synth = this.ensureSynth();
    const audio = synth.context as AudioContext;
    if (audio.state === "suspended") await audio.resume().catch(() => {});
    if (audio.state !== "running") return;
    synth.note(audio.currentTime + 0.005, 0.6, midi, velocity, this.sounds.get(partId) ?? { family: "other", program: 0 }, partId);
  }

  async play(from = 0, options: PlayOptions = {}) {
    this.stop(false);
    const synth = this.ensureSynth();
    const audio = synth.context as AudioContext;
    if (audio.state === "suspended") await audio.resume();
    const performance = this.performance;
    const start = Math.max(0, Math.min(from, performance.duration));
    this.options = options;
    this.startOffset = start;

    // A count-in, from the start of a bar only.
    let countIn: Click[] = [];
    const bar = performance.measures.findIndex((m) => Math.abs(m.start - start) < 1e-3);
    if (options.countIn && this.score && bar >= 0) countIn = countInClicks(this.score, performance, bar);
    const at = synth.context.currentTime + 0.08 + (countIn.length ? start - countIn[0]!.time : 0);
    for (const click of countIn) synth.click(at + (click.time - start), click.downbeat, this.clickVolume);

    const to = Math.max(start, Math.min(options.to ?? performance.duration, performance.duration));
    this.segments = [this.segment({ performance, from: start, to }, at, 0, !!options.next)];
    this.playing = true;
    this.schedule();
    this.timer = setInterval(() => this.schedule(), TICK_MS);
    const animate = () => {
      if (!this.playing || !this.synth) return;
      const now = this.synth.context.currentTime;
      // A new pass has begun: forget the one before.
      while (this.segments.length > 1 && this.segments[1]!.at <= now) {
        this.segments.shift();
        const segment = this.segments[0]!;
        this.performance = segment.performance;
        this.callbacks.onPass?.(segment.pass, segment.performance);
      }
      const segment = this.segments[0]!;
      if (this.segments.length === 1 && !segment.loops && now > segment.at + (segment.to - segment.from) + 0.3) {
        this.stop(true);
        return;
      }
      const t = this.position;
      this.callbacks.onTick?.(t, this.soundingAt(segment, t));
      this.frame = requestAnimationFrame(animate);
    };
    this.frame = requestAnimationFrame(animate);
  }

  /** Stop playback; the position is kept so play(position) resumes. */
  pause() {
    const position = this.position;
    this.stop(false);
    this.startOffset = position;
  }

  stop(notifyEnd = false) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    cancelAnimationFrame(this.frame);
    const wasPlaying = this.playing;
    const position = this.position;
    this.playing = false;
    this.segments = [];
    this.synth?.stopAll();
    if (wasPlaying) this.callbacks.onTick?.(position, []);
    if (notifyEnd) {
      this.startOffset = 0;
      this.callbacks.onEnd?.();
    }
  }

  /** Go back to the start (when stopped). */
  reset() {
    if (!this.playing) this.startOffset = 0;
  }

  /** Move to a time (when stopped, the next play starts there). */
  seek(time: number) {
    if (!this.playing) this.startOffset = Math.max(0, Math.min(time, this.performance.duration));
  }

  dispose() {
    this.stop(false);
    void (this.synth?.context as AudioContext | undefined)?.close();
    this.synth = null;
  }

  private applyMix() {
    if (!this.synth) return;
    for (const id of this.partIds) this.synth.setChannelGain(id, channelGain(this.mix, id));
  }

  private clicksOf(performance: Performance): Click[] {
    let clicks = this.clicks.get(performance);
    if (!clicks) {
      clicks = this.score ? metronomeClicks(this.score, performance) : [];
      this.clicks.set(performance, clicks);
    }
    return clicks;
  }

  private segment(stretch: Stretch, at: number, pass: number, loops: boolean): Segment {
    const clicks = this.clicksOf(stretch.performance);
    return {
      ...stretch,
      at,
      pass,
      loops,
      clicks,
      nextNote: firstAtOrAfter(stretch.performance.notes, (n) => n.start, stretch.from),
      nextClick: firstAtOrAfter(clicks, (c) => c.time, stretch.from),
      scheduledTo: stretch.from,
    };
  }

  /** The stretch sounding now (during a count-in, the first one). */
  private current(now: number): Segment | undefined {
    let found = this.segments[0];
    for (const segment of this.segments) if (segment.at <= now) found = segment;
    return found;
  }

  private schedule() {
    const synth = this.synth;
    if (!synth || !this.playing) return;
    const now = synth.context.currentTime;
    const horizon = now + LOOKAHEAD;
    let segment = this.segments[this.segments.length - 1];
    while (segment) {
      const until = Math.min(segment.to, segment.from + (horizon - segment.at));
      const notes = segment.performance.notes;
      while (segment.nextNote < notes.length && notes[segment.nextNote]!.start < until) {
        const note = notes[segment.nextNote++]!;
        if (!isAudible(this.mix, note.partId)) continue;
        const when = segment.at + (note.start - segment.from);
        if (when < now - 0.05) continue;
        const duration = segment.loops ? Math.min(note.duration, segment.to - note.start) : note.duration;
        synth.note(Math.max(when, now), duration, note.midi, note.velocity, this.sounds.get(note.partId) ?? { family: "other", program: 0 }, note.partId);
      }
      while (segment.nextClick < segment.clicks.length && segment.clicks[segment.nextClick]!.time < until) {
        const click = segment.clicks[segment.nextClick++]!;
        const when = segment.at + (click.time - segment.from);
        // Switched off, the pointer still moves on, so switching on doesn't play the missed clicks.
        if (this.metronome && when >= now - 0.02) synth.click(Math.max(when, now), click.downbeat, this.clickVolume);
      }
      segment.scheduledTo = Math.max(segment.scheduledTo, until);
      // The next pass of a loop, once its start is within reach.
      if (until >= segment.to && segment.loops) {
        const next = this.options.next?.(segment.pass + 1) ?? null;
        if (!next) {
          segment.loops = false;
          break;
        }
        const following = this.segment(next, segment.at + (segment.to - segment.from), segment.pass + 1, true);
        this.segments.push(following);
        segment = following;
        continue;
      }
      break;
    }
  }

  private soundingAt(segment: Segment, t: number): PerformanceNote[] {
    const sounding: PerformanceNote[] = [];
    const notes = segment.performance.notes;
    // Notes are sorted by start; look back a little from the scheduling pointer.
    for (let i = Math.min(notes.length, segment.nextNote) - 1; i >= 0; i--) {
      const n = notes[i]!;
      if (n.start + 8 < t) break;
      if (n.start <= t && t < n.start + Math.max(n.duration, 0.12) && isAudible(this.mix, n.partId)) sounding.push(n);
    }
    return sounding;
  }
}
