import type { Score } from "@musicraft/score-core";
import type { MeasureMark } from "../components/ScoreView";

/** Bars of a draft that differ from the original, per part (new parts and bars count as changed). */
export function changedBars(base: Score, draft: Score): MeasureMark[] {
  const marks: MeasureMark[] = [];
  const baseMeasure = new Map(base.measures.map((m, i) => [m.id, i]));
  draft.parts.forEach((part) => {
    const original = base.parts.find((p) => p.id === part.id);
    part.measures.forEach((pm, m) => {
      const info = draft.measures[m]!;
      const index = baseMeasure.get(info.id);
      let changed = !original || index === undefined;
      if (!changed) {
        const before = original!.measures[index!];
        const infoBefore = base.measures[index!];
        changed =
          (before !== pm && JSON.stringify(before) !== JSON.stringify(pm)) ||
          (infoBefore !== info && JSON.stringify({ ...infoBefore, number: "" }) !== JSON.stringify({ ...info, number: "" })) ||
          original!.instrument !== part.instrument;
      }
      if (changed) marks.push({ measureIndex: m, partId: part.id, color: "green", label: "Changed by the assistant" });
    });
  });
  return marks;
}
