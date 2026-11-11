/**
 * What the React side tells the 3D components about each player and the score (A-Frame components
 * only get short strings as attributes, so they look the rest up here by part id).
 */
import type { Performance, Score } from "@musicraft/score-core";
import type { PartRange } from "./ranges";

export interface PlayerInfo {
  partId: string;
  instrument: string;
  /** Name card text. */
  label: string;
  /** Family colour (glow and name card). */
  color: string;
  selected: boolean;
  hovered: boolean;
  /** Heard with the current mix (not muted, and solo if any part is solo). */
  audible: boolean;
  solo: boolean;
  showName: boolean;
  showMeter: boolean;
  range: PartRange;
}

export const players = new Map<string, PlayerInfo>();

export const stageState: {
  score: Score | null;
  performance: Performance | null;
  /** The listener follows the camera. */
  spatial: boolean;
  /** Dragging players around instead of looking around. */
  moving: boolean;
} = { score: null, performance: null, spatial: true, moving: false };
