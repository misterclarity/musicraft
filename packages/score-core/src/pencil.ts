/**
 * Pencil marks: what a player writes on their part (fingerings, bowings, breaths, words, their own
 * rehearsal letters, highlighted bars). They are not part of the printed music: drawn in grey, left
 * out of a PDF when asked, and kept with their bar and note through edits (the mark of a note or bar
 * that is gone is dropped).
 */
import { produce } from "immer";
import { newId } from "./ids";
import { locate, type Id, type Part, type Score } from "./model";

export type PencilKind = "fingering" | "up-bow" | "down-bow" | "breath" | "text" | "rehearsal" | "highlight";

export interface PencilMark {
  id: Id;
  kind: PencilKind;
  /** The bar, by id. */
  measureId: Id;
  /** The note (event) it is written at; a bar's mark has none. */
  eventId?: Id;
  /** A fingering ("3", "1-2"), words, or a rehearsal letter. */
  text?: string;
}

/** The grey pencil marks are drawn in. */
export const PENCIL_COLOR = "#7c838c";

/** The marks of a part whose bar (and note) are still in the score. */
export function pencilMarks(score: Score, part: Part): PencilMark[] {
  if (!part.pencil?.length) return [];
  const bars = new Set(score.measures.map((m) => m.id));
  return part.pencil.filter((mark) => bars.has(mark.measureId) && (!mark.eventId || locate(score, mark.eventId)?.partIndex === score.parts.indexOf(part)));
}

const samePlace = (a: Pick<PencilMark, "measureId" | "eventId">, b: Pick<PencilMark, "measureId" | "eventId">) => a.measureId === b.measureId && a.eventId === b.eventId;
/** Marks that can't be in the same place together (a bowing is up or down). */
const rivals = (kind: PencilKind): PencilKind[] => (kind === "up-bow" || kind === "down-bow" ? ["up-bow", "down-bow"] : [kind]);

/**
 * Write a mark on a part, in place of one of the same kind at the same place (an up-bow replaces a
 * down-bow). A fingering, words or letter left empty rubs the mark out.
 */
export function setPencilMark(score: Score, partId: Id, mark: Omit<PencilMark, "id">): Score {
  const index = score.parts.findIndex((p) => p.id === partId);
  if (index < 0) return score;
  const text = mark.text?.trim();
  const needsText = mark.kind === "fingering" || mark.kind === "text" || mark.kind === "rehearsal";
  return produce(score, (draft) => {
    const part = draft.parts[index]!;
    const kept = (part.pencil ?? []).filter((m) => !(samePlace(m, mark) && rivals(mark.kind).includes(m.kind)));
    if (!needsText || text) kept.push({ ...mark, id: newId("d"), ...(needsText ? { text } : {}) });
    if (kept.length) part.pencil = kept;
    else delete part.pencil;
  });
}

/** Whether a part has a mark of this kind at a place. */
export function hasPencilMark(score: Score, partId: Id, place: Pick<PencilMark, "measureId" | "eventId">, kind: PencilKind): PencilMark | undefined {
  return score.parts.find((p) => p.id === partId)?.pencil?.find((m) => m.kind === kind && samePlace(m, place));
}

/** Put a mark there, or rub it out if it is there already (bowings, breaths, highlights). */
export function togglePencilMark(score: Score, partId: Id, place: Pick<PencilMark, "measureId" | "eventId">, kind: PencilKind): Score {
  if (hasPencilMark(score, partId, place, kind)) return removePencilMarks(score, partId, place, kind);
  return setPencilMark(score, partId, { ...place, kind });
}

/** Rub out a part's marks at a bar or a note (all of them, or of one kind). */
export function removePencilMarks(score: Score, partId: Id, place: Pick<PencilMark, "measureId" | "eventId">, kind?: PencilKind): Score {
  const index = score.parts.findIndex((p) => p.id === partId);
  const marks = score.parts[index]?.pencil;
  if (!marks?.some((m) => samePlace(m, place) && (!kind || m.kind === kind))) return score;
  return produce(score, (draft) => {
    const part = draft.parts[index]!;
    const kept = marks.filter((m) => !(samePlace(m, place) && (!kind || m.kind === kind)));
    if (kept.length) part.pencil = kept;
    else delete part.pencil;
  });
}

/** The letter after the last rehearsal letter before a bar, printed or pencilled: A, B, … Z, AA. */
export function nextRehearsalLetter(score: Score, partId: Id, measureIndex: number): string {
  const part = score.parts.find((p) => p.id === partId);
  const pencilled = new Map((part ? pencilMarks(score, part) : []).filter((m) => m.kind === "rehearsal").map((m) => [m.measureId, m.text ?? ""]));
  let last = "";
  for (let i = 0; i < measureIndex && i < score.measures.length; i++) {
    const info = score.measures[i]!;
    const letter = pencilled.get(info.id) ?? info.rehearsal ?? "";
    if (/^[A-Z]+$/i.test(letter.trim())) last = letter.trim().toUpperCase();
  }
  if (!last) return "A";
  const chars = last.split("");
  for (let i = chars.length - 1; i >= 0; i--) {
    if (chars[i] !== "Z") {
      chars[i] = String.fromCharCode(chars[i]!.charCodeAt(0) + 1);
      return chars.join("");
    }
    chars[i] = "A";
  }
  return `A${chars.join("")}`;
}
