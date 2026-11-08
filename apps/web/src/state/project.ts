import type { Score } from "@musicraft/score-core";
import { create } from "zustand";
import type { VersionAuthor } from "../lib/db";
import { addVersion, getProject, renameProject, saveScore } from "../lib/projects";

export interface Selection {
  /** Selected events (notes, chords, rests). */
  eventIds: string[];
  /** The chord tone clicked last, for single-note edits. */
  noteId?: string;
  /** A selected range of bars (measure indexes, inclusive). */
  measures?: { from: number; to: number };
  /** Parts the bar selection applies to; all parts when empty. */
  partIds?: string[];
}

export const EMPTY_SELECTION: Selection = { eventIds: [] };

interface HistoryEntry {
  score: Score;
  label: string;
}

interface ProjectState {
  id: string | null;
  name: string;
  score: Score | null;
  past: HistoryEntry[];
  future: HistoryEntry[];
  selection: Selection;
  concert: boolean;
  zoom: number;
  /** Bumped when versions are added, so the history panel can refresh. */
  versionsTick: number;

  open(id: string): Promise<boolean>;
  close(): void;
  rename(name: string): Promise<void>;
  /** Replace the score with a new one (from any operation), keeping undo history. */
  apply(next: Score, label: string, options?: { checkpoint?: boolean; author?: VersionAuthor }): void;
  undo(): void;
  redo(): void;
  select(selection: Selection): void;
  setConcert(concert: boolean): void;
  setZoom(zoom: number): void;
  saveVersion(label: string, author?: VersionAuthor): Promise<void>;
}

const MAX_UNDO = 100;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(id: string, score: Score) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void saveScore(id, score);
  }, 500);
}

export const useProject = create<ProjectState>()((set, get) => ({
  id: null,
  name: "",
  score: null,
  past: [],
  future: [],
  selection: EMPTY_SELECTION,
  concert: false,
  zoom: 1,
  versionsTick: 0,

  async open(id) {
    const project = await getProject(id);
    if (!project) return false;
    set({
      id,
      name: project.name,
      score: project.score,
      past: [],
      future: [],
      selection: EMPTY_SELECTION,
    });
    return true;
  },

  close() {
    const { id, score } = get();
    if (saveTimer && id && score) {
      clearTimeout(saveTimer);
      saveTimer = null;
      void saveScore(id, score);
    }
    set({ id: null, name: "", score: null, past: [], future: [], selection: EMPTY_SELECTION });
  },

  async rename(name) {
    const id = get().id;
    if (!id) return;
    set({ name });
    await renameProject(id, name);
  },

  apply(next, label, options = {}) {
    const { id, score, past } = get();
    if (!id || !score || next === score) return;
    set({
      score: next,
      past: [...past, { score, label }].slice(-MAX_UNDO),
      future: [],
    });
    scheduleSave(id, next);
    if (options.checkpoint) {
      void addVersion(id, next, label, options.author ?? "you").then(() => set({ versionsTick: get().versionsTick + 1 }));
    }
  },

  undo() {
    const { id, score, past, future } = get();
    const previous = past[past.length - 1];
    if (!id || !score || !previous) return;
    set({
      score: previous.score,
      past: past.slice(0, -1),
      future: [{ score, label: previous.label }, ...future],
      selection: EMPTY_SELECTION,
    });
    scheduleSave(id, previous.score);
  },

  redo() {
    const { id, score, past, future } = get();
    const next = future[0];
    if (!id || !score || !next) return;
    set({
      score: next.score,
      past: [...past, { score, label: next.label }],
      future: future.slice(1),
      selection: EMPTY_SELECTION,
    });
    scheduleSave(id, next.score);
  },

  select(selection) {
    set({ selection });
  },

  setConcert(concert) {
    set({ concert });
  },

  setZoom(zoom) {
    set({ zoom: Math.min(2.5, Math.max(0.4, Math.round(zoom * 100) / 100)) });
  },

  async saveVersion(label, author = "you") {
    const { id, score } = get();
    if (!id || !score) return;
    await addVersion(id, score, label, author);
    set({ versionsTick: get().versionsTick + 1 });
  },
}));
