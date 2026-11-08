/** Score-level operations: creating scores, managing parts, metadata. All return new scores. */
import { produce } from "immer";
import { getInstrument } from "./instruments";
import { newId } from "./ids";
import {
  emptyPartMeasure,
  SCORE_SCHEMA_VERSION,
  type Id,
  type MeasureInfo,
  type Part,
  type Score,
  type ScoreMeta,
  type Tempo,
  type TimeSignature,
} from "./model";
import type { KeySignature } from "./pitch";

export interface NewScoreOptions {
  title?: string;
  composer?: string;
  parts: { instrument: string; name?: string }[];
  measures?: number;
  time?: TimeSignature;
  /** Concert key. */
  key?: KeySignature;
  tempo?: Tempo;
}

export function newPart(instrumentId: string, measureCount: number, name?: string): Part {
  const instrument = getInstrument(instrumentId);
  return {
    id: newId("p"),
    name: name ?? instrument.name,
    abbreviation: instrument.abbreviation,
    instrument: instrument.id,
    staves: instrument.staves,
    clefs: instrument.clefs.map((c) => ({ ...c })),
    measures: Array.from({ length: measureCount }, () => emptyPartMeasure(instrument.staves)),
  };
}

export function newScore(options: NewScoreOptions): Score {
  const count = Math.max(1, options.measures ?? 16);
  const measures: MeasureInfo[] = Array.from({ length: count }, (_, i) => ({ id: newId("m"), number: String(i + 1) }));
  measures[0]!.time = options.time ?? { beats: 4, beatType: 4 };
  measures[0]!.key = options.key ?? { fifths: 0, mode: "major" };
  if (options.tempo) measures[0]!.tempo = options.tempo;
  measures[count - 1]!.barline = "final";
  return {
    id: newId("s"),
    schemaVersion: SCORE_SCHEMA_VERSION,
    meta: { title: options.title ?? "Untitled", ...(options.composer ? { composer: options.composer } : {}) },
    measures,
    parts: options.parts.map((p) => newPart(p.instrument, count, p.name)),
  };
}

export function setMeta(score: Score, meta: Partial<ScoreMeta>): Score {
  return produce(score, (draft) => {
    Object.assign(draft.meta, meta);
  });
}

export function addPart(score: Score, instrumentId: string, options: { name?: string; index?: number } = {}): Score {
  const part = newPart(instrumentId, score.measures.length, options.name);
  return produce(score, (draft) => {
    const index = options.index ?? draft.parts.length;
    draft.parts.splice(Math.max(0, Math.min(index, draft.parts.length)), 0, part);
  });
}

export function removePart(score: Score, partId: Id): Score {
  if (score.parts.length <= 1) throw new Error("A score needs at least one part.");
  return produce(score, (draft) => {
    draft.parts = draft.parts.filter((p) => p.id !== partId);
  });
}

export function movePart(score: Score, partId: Id, toIndex: number): Score {
  return produce(score, (draft) => {
    const from = draft.parts.findIndex((p) => p.id === partId);
    if (from < 0) return;
    const [part] = draft.parts.splice(from, 1);
    draft.parts.splice(Math.max(0, Math.min(toIndex, draft.parts.length)), 0, part!);
  });
}

export function renamePart(score: Score, partId: Id, name: string, abbreviation?: string): Score {
  return produce(score, (draft) => {
    const part = draft.parts.find((p) => p.id === partId);
    if (!part) return;
    part.name = name;
    if (abbreviation !== undefined) part.abbreviation = abbreviation;
  });
}

/** Keep only some parts (e.g. to make a single-part score). */
export function extractParts(score: Score, partIds: Id[]): Score {
  return produce(score, (draft) => {
    draft.parts = draft.parts.filter((p) => partIds.includes(p.id));
  });
}
