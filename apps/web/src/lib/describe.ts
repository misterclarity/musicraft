import {
  durationLabel,
  formatPitch,
  locate,
  prettyName,
  toWrittenPitch,
  writtenContexts,
  type Score,
} from "@musicraft/score-core";
import type { Selection } from "../state/project";

const TYPE_NAMES: Record<string, string> = {
  breve: "breve",
  whole: "whole note",
  half: "half note",
  quarter: "quarter note",
  eighth: "eighth note",
  "16th": "16th note",
  "32nd": "32nd note",
  "64th": "64th note",
  "128th": "128th note",
};

/** A one-line description of the selection for the status bar. */
export function describeSelection(score: Score, selection: Selection, concert: boolean): string {
  if (selection.eventIds.length === 1) {
    const loc = locate(score, selection.eventIds[0]!);
    if (!loc) return "";
    const part = score.parts[loc.partIndex]!;
    const event = part.measures[loc.measureIndex]!.voices[loc.voiceIndex]!.events[loc.eventIndex]!;
    const bar = score.measures[loc.measureIndex]!.number;
    const typeName = TYPE_NAMES[event.duration.type] ?? durationLabel(event.duration);
    const dotted = event.duration.dots === 1 ? "dotted " : event.duration.dots === 2 ? "double-dotted " : "";
    const tuplet = event.duration.tuplet ? ` (${event.duration.tuplet.actual}:${event.duration.tuplet.normal})` : "";
    const where = `${prettyName(part.name)} · bar ${bar}`;
    if (event.kind === "rest") return `${where} · ${event.measureRest ? "whole-bar rest" : `${dotted}${typeName.replace("note", "rest")}${tuplet}`}`;
    const ctx = writtenContexts(score, part)[loc.measureIndex]!;
    const written = event.notes.map((n) => formatPitch(toWrittenPitch(n.pitch, ctx))).join(" ");
    const sounding = event.notes.map((n) => formatPitch(n.pitch)).join(" ");
    const pitchText = concert || written === sounding ? sounding : `${written} (sounds ${sounding})`;
    return `${where} · ${pitchText} · ${dotted}${typeName}${tuplet}`;
  }
  if (selection.eventIds.length > 1) return `${selection.eventIds.length} notes selected`;
  if (selection.measures) {
    const { from, to } = selection.measures;
    const bars = from === to ? `Bar ${score.measures[from]?.number}` : `Bars ${score.measures[from]?.number}–${score.measures[to]?.number}`;
    const parts = selection.partIds?.length
      ? selection.partIds.map((id) => prettyName(score.parts.find((p) => p.id === id)?.name ?? "")).join(", ")
      : "all parts";
    return `${bars} · ${parts}`;
  }
  return "";
}
