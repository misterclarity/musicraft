/** Helpers for scores that came from optical music recognition. */
import { produce } from "immer";
import { cmp, ZERO, type Fraction } from "./fraction";
import {
  emptyPartMeasure,
  measureLengths,
  renumberMeasures,
  voiceLength,
  type MeasureInfo,
  type NoteEvent,
  type Part,
  type Score,
} from "./model";
import { samePitch } from "./pitch";
import { setStaffCount } from "./transpose";

const sameTime = (a: MeasureInfo["time"], b: MeasureInfo["time"]) => !!a && !!b && a.beats === b.beats && a.beatType === b.beatType;
const sameKey = (a: MeasureInfo["key"], b: MeasureInfo["key"]) => !!a && !!b && a.fifths === b.fifths;

export interface MergedScore {
  score: Score;
  /** First and last measure index of each input score in the result. */
  ranges: [number, number][];
}

/**
 * Join scores recognised from consecutive pages into one. Parts are matched by position; time and
 * key signatures that merely repeat the previous page's are dropped.
 */
export function mergeScores(scores: Score[]): MergedScore {
  if (scores.length === 0) throw new Error("Nothing to merge.");
  const ranges: [number, number][] = [];
  const merged = produce(scores[0]!, (draft) => {
    ranges.push([0, draft.measures.length - 1]);
    let time = draft.measures.find((m) => m.time)?.time;
    let key = draft.measures.find((m) => m.key)?.key;
    for (const m of draft.measures) {
      time = m.time ?? time;
      key = m.key ?? key;
    }
    for (const next of scores.slice(1)) {
      const offset = draft.measures.length;
      for (const info of next.measures) {
        const copy: MeasureInfo = { ...info };
        if (copy.time && sameTime(copy.time, time)) delete copy.time;
        if (copy.key && sameKey(copy.key, key)) delete copy.key;
        time = copy.time ?? time;
        key = copy.key ?? key;
        draft.measures.push(copy);
      }
      const partCount = Math.max(draft.parts.length, next.parts.length);
      for (let p = 0; p < partCount; p++) {
        const incoming = next.parts[p];
        let target = draft.parts[p] as Part | undefined;
        if (!target && incoming) {
          target = { ...incoming, measures: Array.from({ length: offset }, () => emptyPartMeasure(incoming.staves)) };
          draft.parts.push(target);
          continue;
        }
        if (!target) continue;
        if (incoming && incoming.staves > target.staves) setStaffCount(target, incoming.staves);
        const measures = incoming?.measures ?? next.measures.map(() => emptyPartMeasure(target!.staves));
        for (const pm of measures) target.measures.push(pm);
      }
      ranges.push([offset, draft.measures.length - 1]);
    }
    if (draft.meta.title === "Untitled" || !draft.meta.title) {
      const titled = scores.find((s) => s.meta.title && s.meta.title !== "Untitled");
      if (titled) draft.meta.title = titled.meta.title;
    }
    renumberMeasures(draft);
  });
  return { score: merged, ranges };
}

/** Mark a short first bar as a pickup (upbeat) when every part agrees on its length. */
export function markPickup(score: Score): Score {
  const lengths = measureLengths(score);
  const first = lengths[0];
  if (!first || score.measures[0]?.implicit) return score;
  let common: Fraction | undefined;
  for (const part of score.parts) {
    const pm = part.measures[0];
    if (!pm) return score;
    let longest = ZERO;
    for (const voice of pm.voices) {
      const len = voiceLength(voice, first);
      if (cmp(len, longest) > 0) longest = len;
    }
    if (cmp(longest, ZERO) === 0 || cmp(longest, first) >= 0) return score;
    if (common && cmp(common, longest) !== 0) return score;
    common = longest;
  }
  return produce(score, (draft) => {
    draft.measures[0]!.implicit = true;
    renumberMeasures(draft);
  });
}

/** Fix habits of recognition engines: a slur between two identical notes is really a tie. */
export function cleanupRecognized(score: Score): Score {
  return produce(score, (draft) => {
    for (const part of draft.parts) {
      const lastNote = new Map<string, NoteEvent>();
      for (const pm of part.measures) {
        for (const voice of pm.voices) {
          const key = `${voice.staff}/${voice.voice}`;
          for (const event of voice.events) {
            if (event.kind !== "note" || event.grace) continue;
            const previous = lastNote.get(key);
            if (
              previous &&
              previous.slurs?.some((s) => s.type === "start") &&
              event.slurs?.some((s) => s.type === "stop") &&
              previous.notes.length === event.notes.length &&
              previous.notes.every((n, i) => samePitch(n.pitch, event.notes[i]!.pitch))
            ) {
              previous.slurs = previous.slurs.filter((s) => s.type !== "start");
              event.slurs = event.slurs.filter((s) => s.type !== "stop");
              if (!previous.slurs.length) delete previous.slurs;
              if (!event.slurs.length) delete event.slurs;
              previous.notes.forEach((n) => (n.tie = { ...n.tie, start: true }));
              event.notes.forEach((n) => (n.tie = { ...n.tie, stop: true }));
            }
            lastNote.set(key, event);
          }
        }
      }
    }
  });
}
