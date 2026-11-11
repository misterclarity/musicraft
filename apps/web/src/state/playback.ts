/**
 * Playback, shared by the play bar and the stage: one player, its position, and the mix (which
 * parts are muted, solo, how loud, and where they sit).
 */
import { buildPerformance, type Performance, type PerformanceNote, type Score } from "@musicraft/score-core";
import { create } from "zustand";
import { Player, type Mix, type Room, type SpaceMode, type Vec3 } from "../audio/player";

export interface PlaybackFrame {
  /** Seconds from the start of the performance. */
  time: number;
  /** The notes sounding now (only parts that are heard). */
  notes: PerformanceNote[];
}

type FrameListener = (frame: PlaybackFrame) => void;
const frameListeners = new Set<FrameListener>();

/**
 * Follow playback frame by frame (every animation frame while playing, and once with no notes when
 * it stops), without re-rendering React. Returns the function that stops following.
 */
export function onPlaybackFrame(listener: FrameListener): () => void {
  frameListeners.add(listener);
  return () => frameListeners.delete(listener);
}

let lastPositionUpdate = 0;
let loadedScore: Score | null = null;

const player = new Player({
  onTick: (time, notes) => {
    for (const listener of frameListeners) listener({ time, notes });
    const now = Date.now();
    if (now - lastPositionUpdate > 200 || !notes.length) {
      lastPositionUpdate = now;
      usePlayback.setState({ position: time });
    }
  },
  onEnd: () => usePlayback.setState({ playing: false, position: 0 }),
});

interface PlaybackState {
  scoreId: string | null;
  performance: Performance | null;
  /** 1 = as written, 0.5 = half speed. */
  tempo: number;
  playing: boolean;
  /** Seconds, updated a few times a second (use onPlaybackFrame for every frame). */
  position: number;
  muted: string[];
  solo: string[];
  /** Volume per part id, 1 = as written. */
  volumes: Record<string, number>;

  /** Use this score (keeps the mix while it's the same score, e.g. the assistant's draft of it). */
  load(score: Score): void;
  setTempo(tempo: number): void;
  play(from?: number): Promise<void>;
  pause(): void;
  stop(): void;
  /** Where the next play starts, in seconds (while stopped). */
  seek(time: number): void;
  toggleMute(partId: string): void;
  toggleSolo(partId: string): void;
  setVolume(partId: string, volume: number): void;
  /** Hear every part again, at its own volume. */
  resetMix(): void;
  /** Where each part sits (metres; see Synth.setChannelPosition). */
  setSeats(positions: ReadonlyMap<string, Vec3>): void;
  setSpace(mode: SpaceMode, room: Room): void;
  setListener(position: Vec3, forward: Vec3): void;
}

function mixOf(state: Pick<PlaybackState, "muted" | "solo" | "volumes">): Mix {
  return { muted: new Set(state.muted), solo: new Set(state.solo), volumes: new Map(Object.entries(state.volumes)) };
}

function perform(score: Score, tempo: number): Performance {
  return buildPerformance(score, { tempoScale: tempo });
}

export const usePlayback = create<PlaybackState>()((set, get) => ({
  scoreId: null,
  performance: null,
  tempo: 1,
  playing: false,
  position: 0,
  muted: [],
  solo: [],
  volumes: {},

  load(score) {
    if (score === loadedScore) return;
    const sameScore = get().scoreId === score.id;
    if (!sameScore) player.stop(false);
    loadedScore = score;
    const performance = perform(score, get().tempo);
    player.load(score, performance);
    if (sameScore) {
      set({ performance });
    } else {
      player.reset();
      set({ scoreId: score.id, performance, playing: false, position: 0, muted: [], solo: [], volumes: {} });
      player.setMix(mixOf(get()));
    }
  },

  setTempo(tempo) {
    set({ tempo });
    if (!loadedScore) return;
    const performance = perform(loadedScore, tempo);
    player.load(loadedScore, performance);
    set({ performance });
  },

  async play(from) {
    await player.play(from ?? player.position);
    set({ playing: true });
  },

  pause() {
    player.pause();
    set({ playing: false, position: player.position });
  },

  stop() {
    player.stop(false);
    player.reset();
    set({ playing: false, position: 0 });
  },

  seek(time) {
    player.seek(time);
    if (!get().playing) set({ position: player.position });
  },

  toggleMute(partId) {
    const muted = get().muted.includes(partId) ? get().muted.filter((id) => id !== partId) : [...get().muted, partId];
    set({ muted });
    player.setMix(mixOf(get()));
  },

  toggleSolo(partId) {
    const solo = get().solo.includes(partId) ? get().solo.filter((id) => id !== partId) : [...get().solo, partId];
    set({ solo });
    player.setMix(mixOf(get()));
  },

  setVolume(partId, volume) {
    set({ volumes: { ...get().volumes, [partId]: Math.max(0, Math.min(2, volume)) } });
    player.setMix(mixOf(get()));
  },

  resetMix() {
    set({ muted: [], solo: [], volumes: {} });
    player.setMix(mixOf(get()));
  },

  setSeats(positions) {
    player.setPositions(positions);
  },

  setSpace(mode, room) {
    player.setSpace(mode, room);
  },

  setListener(position, forward) {
    player.setListener(position, forward);
  },
}));

/** Whether a part is heard with the current mix. */
export function partAudible(state: Pick<PlaybackState, "muted" | "solo">, partId: string): boolean {
  return !state.muted.includes(partId) && (state.solo.length === 0 || state.solo.includes(partId));
}
