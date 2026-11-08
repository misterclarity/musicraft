import { getInstrument, type InstrumentFamily, type Performance, type PerformanceNote, type Score } from "@musicraft/score-core";
import { Synth } from "./synth";

const LOOKAHEAD = 0.35;
const TICK_MS = 60;

export interface PlayerCallbacks {
  /** Called every animation frame while playing, with the score time and the sounding note ids. */
  onTick?: (time: number, noteIds: string[]) => void;
  onEnd?: () => void;
}

/** Plays a Performance (timed notes) through the synthesizer, with lookahead scheduling. */
export class Player {
  private synth: Synth | null = null;
  private notes: PerformanceNote[] = [];
  private families = new Map<string, InstrumentFamily>();
  private muted = new Set<string>();
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
  }

  setMuted(partIds: Iterable<string>) {
    this.muted = new Set(partIds);
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
    this.synth ??= new Synth();
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

  dispose() {
    this.stop(false);
    void this.synth?.context.close();
    this.synth = null;
  }

  private schedule() {
    if (!this.synth || !this.playing) return;
    const ctx = this.synth.context;
    const horizon = ctx.currentTime + LOOKAHEAD - this.startContextTime + this.startOffset;
    while (this.nextIndex < this.notes.length && this.notes[this.nextIndex]!.start < horizon) {
      const note = this.notes[this.nextIndex++]!;
      if (this.muted.has(note.partId)) continue;
      const when = this.startContextTime + (note.start - this.startOffset);
      if (when < ctx.currentTime - 0.05) continue;
      this.synth.note(Math.max(when, ctx.currentTime), note.duration, note.midi, note.velocity, this.families.get(note.partId) ?? "other");
    }
  }

  private soundingAt(t: number): string[] {
    const ids: string[] = [];
    // Notes are sorted by start; look back a little from the scheduling pointer.
    for (let i = Math.max(0, this.nextIndex - 1); i >= 0; i--) {
      const n = this.notes[i]!;
      if (n.start + 8 < t) break;
      if (n.start <= t && t < n.start + Math.max(n.duration, 0.12) && !this.muted.has(n.partId)) ids.push(...n.noteIds);
    }
    return ids;
  }
}
