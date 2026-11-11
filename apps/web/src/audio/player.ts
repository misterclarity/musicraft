import { getInstrument, type InstrumentFamily, type Performance, type PerformanceNote, type Score } from "@musicraft/score-core";
import { Synth, type Room, type SpaceMode, type Vec3 } from "./synth";

export type { Room, SpaceMode, Vec3 } from "./synth";

const LOOKAHEAD = 0.35;
const TICK_MS = 60;

export interface PlayerCallbacks {
  /** Called every animation frame while playing, with the score time and the notes sounding then. */
  onTick?: (time: number, notes: PerformanceNote[]) => void;
  onEnd?: () => void;
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

interface Listener {
  position: Vec3;
  forward: Vec3;
}

/** Plays a Performance (timed notes) through the synthesizer, with lookahead scheduling. */
export class Player {
  private synth: Synth | null = null;
  private notes: PerformanceNote[] = [];
  private families = new Map<string, InstrumentFamily>();
  private partIds: string[] = [];
  private mix: Mix = EMPTY_MIX;
  private positions = new Map<string, Vec3>();
  private space: { mode: SpaceMode; room: Room } = { mode: "stereo", room: "dry" };
  private listener: Listener = { position: { x: 0, y: 1.6, z: 1.5 }, forward: { x: 0, y: 0, z: -1 } };
  private duration = 0;
  private startContextTime = 0;
  private startOffset = 0;
  private nextIndex = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private playing = false;

  constructor(private callbacks: PlayerCallbacks = {}) {}

  load(score: Score, performance: Performance) {
    this.notes = performance.notes;
    this.duration = performance.duration;
    this.families = new Map(score.parts.map((p) => [p.id, getInstrument(p.instrument).family]));
    this.partIds = score.parts.map((p) => p.id);
    this.applyMix();
  }

  setMix(mix: Mix) {
    this.mix = mix;
    this.applyMix();
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

  get position(): number {
    if (!this.playing || !this.synth) return this.startOffset;
    return this.startOffset + (this.synth.context.currentTime - this.startContextTime);
  }

  async play(from = 0) {
    this.stop(false);
    if (!this.synth) {
      this.synth = new Synth();
      this.synth.setSpace(this.space.mode, this.space.room);
      this.synth.setListener(this.listener.position, this.listener.forward);
      for (const [id, position] of this.positions) this.synth.setChannelPosition(id, position);
      this.applyMix();
    }
    if (this.synth.context.state === "suspended") await this.synth.context.resume();
    this.startOffset = Math.max(0, Math.min(from, this.duration));
    this.startContextTime = this.synth.context.currentTime + 0.08;
    this.nextIndex = this.notes.findIndex((n) => n.start >= this.startOffset);
    if (this.nextIndex < 0) this.nextIndex = this.notes.length;
    this.playing = true;
    this.schedule();
    this.timer = setInterval(() => this.schedule(), TICK_MS);
    const animate = () => {
      if (!this.playing) return;
      const t = this.position;
      if (t > this.duration + 0.3) {
        this.stop(true);
        return;
      }
      this.callbacks.onTick?.(t, this.soundingAt(t));
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
    this.playing = false;
    this.synth?.stopAll();
    if (wasPlaying) this.callbacks.onTick?.(this.position, []);
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
    if (!this.playing) this.startOffset = Math.max(0, Math.min(time, this.duration));
  }

  dispose() {
    this.stop(false);
    void this.synth?.context.close();
    this.synth = null;
  }

  private applyMix() {
    if (!this.synth) return;
    for (const id of this.partIds) this.synth.setChannelGain(id, channelGain(this.mix, id));
  }

  private schedule() {
    if (!this.synth || !this.playing) return;
    const ctx = this.synth.context;
    const horizon = ctx.currentTime + LOOKAHEAD - this.startContextTime + this.startOffset;
    while (this.nextIndex < this.notes.length && this.notes[this.nextIndex]!.start < horizon) {
      const note = this.notes[this.nextIndex++]!;
      if (!isAudible(this.mix, note.partId)) continue;
      const when = this.startContextTime + (note.start - this.startOffset);
      if (when < ctx.currentTime - 0.05) continue;
      this.synth.note(Math.max(when, ctx.currentTime), note.duration, note.midi, note.velocity, this.families.get(note.partId) ?? "other", note.partId);
    }
  }

  private soundingAt(t: number): PerformanceNote[] {
    const sounding: PerformanceNote[] = [];
    // Notes are sorted by start; look back a little from the scheduling pointer.
    for (let i = Math.max(0, this.nextIndex - 1); i >= 0; i--) {
      const n = this.notes[i]!;
      if (n.start + 8 < t) break;
      if (n.start <= t && t < n.start + Math.max(n.duration, 0.12) && isAudible(this.mix, n.partId)) sounding.push(n);
    }
    return sounding;
  }
}
