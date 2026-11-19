/**
 * A score made from separately printed parts: each part is scanned (or imported) on its own and
 * joins the score bar by bar. The score's bars stay as they are (time and key signatures, repeats,
 * rehearsal marks); the part brings its notes, and its own bars where it is longer. What doesn't
 * line up (a different number of bars, time signatures, keys, landmarks such as rehearsal marks) is
 * reported, as a bar too many or too few in the part shifts everything after it.
 */
import { aiBarLabels } from "./ai/notation";
import { newId } from "./ids";
import { concertKeys, emptyPartMeasure, timeSignatures, type Id, type MeasureInfo, type PartMeasure, type Score } from "./model";

export interface AddPartResult {
  score: Score;
  /** The parts added (their ids in the score). */
  partIds: Id[];
  /** For each bar of the added part, the id of the score's bar it went to. */
  measureIds: Id[];
  /** What the user should know: bars added or left empty, and where the two don't line up. */
  notes: string[];
}

/** Bar labels, shortened after a few: "12, 13, 20 and 3 more". */
function listBars(labels: string[]): string {
  if (labels.length <= 4) return labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}` : (labels[0] ?? "");
  return `${labels.slice(0, 3).join(", ")} and ${labels.length - 3} more`;
}

/** What makes a bar recognisable across parts: rehearsal marks, repeats, double bar lines, endings. */
function landmark(info: MeasureInfo | undefined): string | null {
  if (!info) return null;
  const marks = [
    info.rehearsal ? `mark ${info.rehearsal.trim().toUpperCase()}` : "",
    info.repeatStart ? "repeat start" : "",
    info.repeatEnd ? "repeat end" : "",
    info.ending?.start ? `ending ${info.ending.number}` : "",
    info.barline === "double" || info.barline === "final" ? "double bar" : "",
  ].filter(Boolean);
  return marks.length ? marks.join(", ") : null;
}

/**
 * Add the parts of `scanned` (usually one, read from its own pages) to `score`, its first bar at
 * score bar index `at`. Bars before `at`, and after the part ends, are rests in the new part; bars
 * past the end of the score are added to every part.
 */
export function addScannedPart(score: Score, scanned: Score, options: { at?: number } = {}): AddPartResult {
  const at = Math.max(0, Math.min(score.measures.length, Math.round(options.at ?? 0)));
  const length = scanned.measures.length;
  const total = Math.max(score.measures.length, at + length);
  const next: Score = structuredClone(score);
  const notes: string[] = [];

  // Bars the score doesn't have yet take the part's bar information, numbered on from the last.
  const added = total - score.measures.length;
  const lastNumber = Number(score.measures[score.measures.length - 1]?.number);
  for (let i = score.measures.length; i < total; i++) {
    const info: MeasureInfo = { ...structuredClone(scanned.measures[i - at]!), id: newId("m") };
    delete info.implicit;
    info.number = Number.isFinite(lastNumber) ? String(lastNumber + 1 + (i - score.measures.length)) : String(i + 1);
    next.measures.push(info);
    for (const part of next.parts) part.measures.push(emptyPartMeasure(part.staves));
  }
  if (added > 0 && score.measures.length) {
    notes.push(`The part is ${added} bar${added === 1 ? "" : "s"} longer than the score: the other parts rest in the ${added === 1 ? "bar" : `${added} bars`} added at the end.`);
  }

  const labels = aiBarLabels(next);
  const taken = new Set(next.parts.map((p) => p.id));
  const names = new Set(next.parts.map((p) => p.name));
  const partIds: Id[] = [];
  for (const part of scanned.parts) {
    const id = taken.has(part.id) ? newId("p") : part.id;
    taken.add(id);
    let name = part.name;
    for (let n = 2; names.has(name); n++) name = `${part.name} ${n}`;
    names.add(name);
    const measures: PartMeasure[] = Array.from({ length: total }, (_, i) => {
      const own = part.measures[i - at];
      return own && i >= at ? structuredClone(own) : emptyPartMeasure(part.staves);
    });
    next.parts.push({ ...structuredClone(part), id, name, measures });
    partIds.push(id);
  }

  if (at > 0) notes.push(`The part starts at bar ${labels[at]}: it rests before that.`);
  const end = at + length;
  if (end < score.measures.length) {
    const rest = score.measures.length - end;
    notes.push(`The part has ${rest} bar${rest === 1 ? "" : "s"} fewer than the score: it rests from bar ${labels[end]} to the end.`);
  }

  // Where the two don't agree on the bars they share.
  const shared = Math.min(length, score.measures.length - at);
  const times = timeSignatures(score);
  const partTimes = timeSignatures(scanned);
  const keys = concertKeys(score);
  const partKeys = concertKeys(scanned);
  const otherTime: string[] = [];
  const otherKey: string[] = [];
  const landmarks: { label: string; mine: boolean; theirs: boolean }[] = [];
  for (let j = 0; j < shared; j++) {
    const i = at + j;
    const [a, b] = [times[i]!, partTimes[j]!];
    if (a.beats !== b.beats || a.beatType !== b.beatType) otherTime.push(labels[i]!);
    if (keys[i]!.fifths !== partKeys[j]!.fifths) otherKey.push(labels[i]!);
    const mine = !!landmark(score.measures[i]);
    const theirs = !!landmark(scanned.measures[j]);
    if (mine || theirs) landmarks.push({ label: labels[i]!, mine, theirs });
  }
  if (shared > 0 && !!scanned.measures[0]?.implicit !== !!score.measures[at]?.implicit) {
    notes.push(
      scanned.measures[0]?.implicit
        ? `The part starts with a pickup bar where the score has a full bar (${labels[at]}).`
        : `The score has a pickup bar (${labels[at]}) where the part has a full bar: start the part one bar later if it has no pickup.`,
    );
  }
  if (otherTime.length) {
    notes.push(`The part's time signature differs from the score's in bar${otherTime.length === 1 ? "" : "s"} ${listBars(otherTime)}: those bars may not add up.`);
  }
  if (otherKey.length) {
    notes.push(`The part's key differs from the score's in bar${otherKey.length === 1 ? "" : "s"} ${listBars(otherKey)}: check its accidentals there.`);
  }
  // Only when both have landmarks (a score typed in without rehearsal marks says nothing).
  if (landmarks.some((l) => l.mine) && landmarks.some((l) => l.theirs)) {
    const missed = landmarks.filter((l) => l.mine !== l.theirs).map((l) => l.label);
    notes.push(
      missed.length
        ? `Rehearsal marks, repeats and double bar lines don't line up at bar${missed.length === 1 ? "" : "s"} ${listBars(missed)}: the part may have a bar too many or too few before ${missed.length === 1 ? "it" : "the first"}.`
        : `Rehearsal marks, repeats and double bar lines line up (${landmarks.length} of ${landmarks.length}).`,
    );
  }

  return { score: next, partIds, measureIds: Array.from({ length }, (_, j) => next.measures[at + j]!.id), notes };
}
