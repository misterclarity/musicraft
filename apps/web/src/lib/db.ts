import Dexie, { type EntityTable } from "dexie";
import type { PartMeasure, Score } from "@musicraft/score-core";

export type ProjectSource = "musicxml" | "scan" | "new" | "project-file";
export type VersionAuthor = "you" | "ai" | "import" | "recognition";

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  source: ProjectSource;
  /** The current score. */
  score: Score;
  /** The 3D stage: venue and the places players were moved to. */
  stage?: StageSettings;
}

export interface StageSettings {
  venue: "hall" | "bandstand";
  /** Where the user moved players, by part id (metres; see stage/layout.ts). */
  seats: Record<string, { x: number; z: number }>;
}

export interface VersionRecord {
  id?: number;
  projectId: string;
  createdAt: number;
  label: string;
  author: VersionAuthor;
  /** gzip-compressed JSON of the score. */
  data: Uint8Array;
}

/** Original page images of recognised scores, kept for the side-by-side review. */
export interface PageRecord {
  id?: number;
  projectId: string;
  index: number;
  name: string;
  blob: Blob;
  width: number;
  height: number;
  /** Staff boxes (normalised 0–1) and note positions reported by the recognition service. */
  layout?: PageLayout;
  /** When two engines read the page: who read each line, and where they disagree. */
  recognition?: PageRecognition;
  /** The part these pages hold alone (scanned from its own printed part); the whole score when absent. */
  partId?: string;
}

export interface PageRecognition {
  /** The engine that read each line (in the order of layout.systemStartIds). */
  lineEngines: (string | null)[];
  /** Bars the other engine read differently. */
  disagreements: ReadingDisagreement[];
}

export interface ReadingDisagreement {
  /** The bar, by id (it keeps it through edits). */
  measureId: string;
  /** Other pitches, the same melody in another rhythm, or no such bar in the other reading. */
  kind: "pitch" | "rhythm" | "missing";
  /** The engine of the other reading. */
  readBy: string | null;
  /** The other reading's version of the bar (one part), when it has one. */
  bar?: PartMeasure;
}

export interface PageLayout {
  /** Staff boxes, normalised 0–1, top to bottom. */
  staffs: { x: number; y: number; width: number; height: number; grand?: boolean }[];
  /** Staves per system (2 for piano), to group staff boxes into lines of music. */
  staffsPerSystem?: number;
  /** First and last measure index of the score that came from this page. */
  measureRange?: [number, number];
  /** Where each system starts, as measure indexes relative to the page's first measure. */
  systemStarts?: number[];
  /**
   * Id of each system's first bar. Lines follow these ids, so they stay aligned when bars are added
   * or removed later (see lib/pageLayout.ts).
   */
  systemStartIds?: string[];
  /** Approximate note positions in image pixels, by event id. */
  notePositions?: Record<string, { x: number; y: number }>;
}

class MusicraftDB extends Dexie {
  projects!: EntityTable<ProjectRecord, "id">;
  versions!: EntityTable<VersionRecord, "id">;
  pages!: EntityTable<PageRecord, "id">;

  constructor() {
    super("musicraft");
    this.version(1).stores({
      projects: "id, updatedAt",
      versions: "++id, projectId, createdAt",
      pages: "++id, projectId, [projectId+index]",
    });
  }
}

export const db = new MusicraftDB();
