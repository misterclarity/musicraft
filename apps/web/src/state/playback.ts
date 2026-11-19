/**
 * Playback, shared by the play bar and the stage: one player, its position, and the mix (which
 * parts are muted, solo, how loud, and where they sit).
 */
import { notifications } from "@mantine/notifications";
import { buildPerformance, playedRange, type Performance, type PerformanceNote, type Score } from "@musicraft/score-core";
import { create } from "zustand";
import { Player, samePlace, type Mix, type Room, type SpaceMode, type Stretch, type Vec3 } from "../audio/player";
import { loadSounds, soundsReady, wantedNotes } from "../audio/samples";

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
/** The bars being looped (score bar indexes), or null for the whole piece. */
let loopBars: { from: number; to: number } | null = null;
/** The speed each performance was built for. */
const speeds = new WeakMap<Performance, number>();

const player = new Player({
  onTick: (time, notes) => {
    for (const listener of frameListeners) listener({ time, notes });
    const now = Date.now();
    if (now - lastPositionUpdate > 200 || !notes.length) {
      lastPositionUpdate = now;
      usePlayback.setState({ position: time });
    }
  },
  onEnd: () => usePlayback.setState({ playing: false, position: 0, pass: 0 }),
  onPass: (pass, performance) => usePlayback.setState({ pass, performance, tempo: speeds.get(performance) ?? usePlayback.getState().tempo }),
});

/** Ways to practise: a click on every beat, a count-in, a loop, and a loop that gets faster. */
export interface Practice {
  metronome: boolean;
  /** Metronome volume, 0 to 1. */
  clickVolume: number;
  countIn: boolean;
  /** Repeat the selected bars (or the whole piece) until stopped. */
  loop: boolean;
  /** While looping: start at `start` speed and add `step` every pass, up to `target`. */
  trainer: boolean;
  start: number;
  step: number;
  target: number;
}

export const DEFAULT_PRACTICE: Practice = { metronome: false, clickVolume: 0.7, countIn: false, loop: false, trainer: false, start: 0.7, step: 0.05, target: 1 };
const PRACTICE_KEY = "musicraft.practice";
const SOUND_KEY = "musicraft.sound";

function storedRecorded(): boolean {
  try {
    return localStorage.getItem(SOUND_KEY) !== "simple";
  } catch {
    return true;
  }
}

/**
 * Download the recordings a score's notes need, and let go of the ones it no longer needs; tell the
 * user (once per play) if some failed.
 */
async function prepareSounds(score: Score, performance: Performance, tell: boolean): Promise<void> {
  const notes = wantedNotes(score, performance.notes);
  const waiting = tell && !soundsReady(notes);
  if (waiting) usePlayback.setState({ loadingSounds: true });
  try {
    const failed = await loadSounds(notes, { only: true });
    if (failed.length && tell) {
      notifications.show({
        color: "orange",
        message: "Some instrument sounds couldn't be downloaded, so those notes play with the simple synthesizer.",
      });
    }
  } finally {
    if (waiting) usePlayback.setState({ loadingSounds: false });
  }
}

function storedPractice(): Practice {
  try {
    const stored = JSON.parse(localStorage.getItem(PRACTICE_KEY) ?? "null") as Partial<Practice> | null;
    return { ...DEFAULT_PRACTICE, ...(stored && typeof stored === "object" ? stored : {}) };
  } catch {
    return DEFAULT_PRACTICE;
  }
}

/** The speed of pass `pass` of a loop with the speed trainer (pass 0 is the first time through). */
export function trainerSpeed(practice: Pick<Practice, "start" | "step" | "target">, pass: number): number {
  const speed = practice.start + practice.step * pass;
  return Math.round(Math.min(Math.max(practice.start, practice.target), speed) * 100) / 100;
}

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
  practice: Practice;
  /** How many times a loop has come round (0 the first time through). */
  pass: number;
  /** Recorded instrument notes, or the simple synthesizer. */
  recorded: boolean;
  /** The recorded notes are being downloaded before playing. */
  loadingSounds: boolean;

  /** Use this score (keeps the mix while it's the same score, e.g. the assistant's draft of it). */
  load(score: Score): void;
  setTempo(tempo: number): void;
  /** Play from a time (by default where it stopped); a loop repeats `bars` (score bar indexes), or the whole piece. */
  play(from?: number, bars?: { from: number; to: number }): Promise<void>;
  setPractice(changes: Partial<Practice>): void;
  setRecorded(on: boolean): void;
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
  const performance = buildPerformance(score, { tempoScale: tempo });
  speeds.set(performance, tempo);
  return performance;
}

/** Where the loop lies in a performance: the looped bars, or all of it. */
function loopRange(performance: Performance): { start: number; end: number } | null {
  if (!loopBars) return performance.duration > 0 ? { start: 0, end: performance.duration } : null;
  return playedRange(performance, loopBars.from, loopBars.to);
}

/** The next pass of a loop: at the speed trainer's next speed, or again as it was. */
function nextPass(pass: number): Stretch | null {
  const state = usePlayback.getState();
  if (!loadedScore || !state.performance) return null;
  const speed = state.practice.trainer ? trainerSpeed(state.practice, pass) : (speeds.get(state.performance) ?? state.tempo);
  const performance = speeds.get(state.performance) === speed ? state.performance : perform(loadedScore, speed);
  const range = loopRange(performance);
  return range ? { performance, from: range.start, to: range.end } : null;
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
  practice: storedPractice(),
  pass: 0,
  recorded: storedRecorded(),
  loadingSounds: false,

  load(score) {
    if (score === loadedScore) return;
    const sameScore = get().scoreId === score.id;
    if (!sameScore) player.stop(false);
    loadedScore = score;
    const performance = perform(score, get().tempo);
    // Fetch the recordings now, so that playing starts at once.
    if (get().recorded) void prepareSounds(score, performance, false);
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
    const previous = get().performance;
    if (!loadedScore || !previous) return;
    const performance = perform(loadedScore, tempo);
    // Carry on from the same place in the music, which is at another time at another speed.
    const at = samePlace(previous, performance, player.position);
    player.load(loadedScore, performance);
    set({ performance, position: at });
    if (get().playing) {
      const range = get().practice.loop ? loopRange(performance) : null;
      void player.play(at, range ? { to: range.end, next: nextPass } : {});
    } else {
      player.seek(at);
    }
  },

  async play(from, bars) {
    const state = get();
    if (!loadedScore || !state.performance) return;
    const { practice } = state;
    loopBars = practice.loop ? (bars ?? null) : null;
    let performance = state.performance;
    let range = practice.loop ? loopRange(performance) : null;
    let start = from ?? player.position;
    const inLoop = !!range && start >= range.start && start < range.end - 1e-3;
    if (range && !inLoop) start = range.start;
    // The speed trainer starts slow, unless carrying on inside the loop.
    if (range && practice.trainer && (from !== undefined || !inLoop || start === range.start)) {
      const speed = trainerSpeed(practice, 0);
      if (speed !== speeds.get(performance)) {
        performance = perform(loadedScore, speed);
        player.load(loadedScore, performance);
        range = loopRange(performance);
        start = range?.start ?? 0;
        set({ performance, tempo: speed });
      }
    }
    player.setMetronome(practice.metronome, practice.clickVolume);
    if (state.recorded) await prepareSounds(loadedScore, performance, true);
    player.setRecordedSounds(get().recorded);
    await player.play(start, { countIn: practice.countIn, ...(range ? { to: range.end, next: nextPass } : {}) });
    set({ playing: true, pass: 0, position: player.position });
  },

  setRecorded(on) {
    set({ recorded: on });
    player.setRecordedSounds(on);
    const performance = get().performance;
    if (on && loadedScore && performance) void prepareSounds(loadedScore, performance, false);
    try {
      localStorage.setItem(SOUND_KEY, on ? "recorded" : "simple");
    } catch {
      // Not remembered in this browser.
    }
  },

  setPractice(changes) {
    const practice = { ...get().practice, ...changes };
    // The speed trainer works on a loop.
    if (changes.trainer) practice.loop = true;
    if (changes.loop === false) practice.trainer = false;
    set({ practice });
    player.setMetronome(practice.metronome, practice.clickVolume);
    try {
      localStorage.setItem(PRACTICE_KEY, JSON.stringify(practice));
    } catch {
      // Not remembered in this browser.
    }
  },

  pause() {
    player.pause();
    set({ playing: false, position: player.position });
  },

  stop() {
    player.stop(false);
    player.reset();
    set({ playing: false, position: 0, pass: 0 });
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
