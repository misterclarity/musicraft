import { notifications } from "@mantine/notifications";
import {
  addChordNote,
  alterNotes,
  copyMeasures,
  deleteMeasures,
  deleteNotes,
  EditError,
  enterMidi,
  hasPencilMark,
  nextRehearsalLetter,
  removePencilMarks,
  setPencilMark,
  togglePencilMark,
  enterNote,
  insertMeasures,
  locate,
  moveNotes,
  nextEventId,
  pasteMeasures,
  previousEventId,
  respellNotes,
  setDurations,
  setDynamic,
  toggleArticulation,
  toggleDots,
  toggleTies,
  type Articulation,
  type Duration,
  type Dynamic,
  type MeasureClipboard,
  type MusicEvent,
  type PencilKind,
  type PitchMove,
  type Score,
  type Step,
} from "@musicraft/score-core";
import { create } from "zustand";
import { previewActive } from "../ai/assistant";
import { modals } from "./modals";
import { useProject, type Selection } from "../state/project";

/** Editor state that is not part of the score: the length used for typed notes, and copied bars. */
export const useEditor = create<{
  inputDuration: Duration;
  clipboard: { data: MeasureClipboard; parts: number } | null;
  setInputDuration: (d: Duration) => void;
}>((set) => ({
  inputDuration: { type: "quarter", dots: 0 },
  clipboard: null,
  setInputDuration: (inputDuration) => set({ inputDuration }),
}));

function current() {
  const project = useProject.getState();
  return { project, score: project.score, selection: project.selection, view: project.concert ? ("concert" as const) : ("written" as const) };
}

function run(label: string, fn: (score: Score, selection: Selection) => Score | { score: Score; select?: Selection }) {
  const { project, score, selection } = current();
  if (!score) return;
  if (previewActive()) {
    notifications.show({ color: "orange", message: "Keep or discard the assistant's changes first." });
    return;
  }
  try {
    const result = fn(score, selection);
    const next = "parts" in result ? result : result.score;
    const select = "parts" in result ? undefined : result.select;
    if (next !== score) project.apply(next, label);
    if (select) project.select(select);
  } catch (error) {
    if (error instanceof EditError) notifications.show({ color: "orange", message: error.message });
    else notifications.show({ color: "red", title: "That didn't work", message: (error as Error).message });
  }
}

/** Selected event ids, or the chord tone when a single chord tone was clicked. */
function targets(selection: Selection): string[] {
  if (selection.eventIds.length === 1 && selection.noteId) return [selection.noteId];
  return selection.eventIds;
}

function eventById(score: Score, id: string): MusicEvent | undefined {
  const loc = locate(score, id);
  if (!loc) return undefined;
  return score.parts[loc.partIndex]!.measures[loc.measureIndex]!.voices[loc.voiceIndex]!.events[loc.eventIndex];
}

function selectEvent(score: Score, id: string | undefined): Selection | undefined {
  if (!id) return undefined;
  const loc = locate(score, id);
  if (!loc) return undefined;
  return { eventIds: [id], measures: { from: loc.measureIndex, to: loc.measureIndex }, partIds: [score.parts[loc.partIndex]!.id] };
}

type PencilPlace = { partId: string; measureId: string; eventId?: string };

/** Where pencil marks go: at the selected notes, or on the selected bars of one part. */
export function pencilPlaces(score: Score, selection: Selection, on: "note" | "bar"): PencilPlace[] {
  if (on === "note") {
    return selection.eventIds.flatMap((id) => {
      const loc = locate(score, id);
      return loc ? [{ partId: score.parts[loc.partIndex]!.id, measureId: score.measures[loc.measureIndex]!.id, eventId: id }] : [];
    });
  }
  const located = selection.eventIds[0] ? locate(score, selection.eventIds[0]) : undefined;
  const range = selection.measures ?? (located ? { from: located.measureIndex, to: located.measureIndex } : undefined);
  const partId = selection.partIds?.length === 1 ? selection.partIds[0] : located ? score.parts[located.partIndex]!.id : score.parts.length === 1 ? score.parts[0]!.id : undefined;
  if (!range || !partId) return [];
  return score.measures.slice(range.from, range.to + 1).map((m) => ({ partId, measureId: m.id }));
}

const PENCIL_NAMES: Record<PencilKind, string> = {
  fingering: "fingering",
  "up-bow": "up-bow",
  "down-bow": "down-bow",
  breath: "breath mark",
  text: "words",
  rehearsal: "rehearsal letter",
  highlight: "highlight",
};

export const editor = {
  enter(step: Step) {
    const { view } = current();
    run(`Enter ${step}`, (score, selection) => {
      const id = selection.eventIds[0];
      if (!id) throw new EditError("Select a note or rest first.");
      const result = enterNote(score, id, step, { view, inputDuration: useEditor.getState().inputDuration, noteId: selection.noteId });
      return { score: result.score, select: selectEvent(result.score, result.nextEventId ?? id) };
    });
  },

  /** Notes played on a MIDI keyboard: in place of the selected note (or onto the selected rest). */
  midi(notes: number[]) {
    const { view } = current();
    run("Play in notes", (score, selection) => {
      const id = selection.eventIds[0];
      if (!id) throw new EditError("Select a note or rest to play into.");
      const result = enterMidi(score, id, notes, { view, inputDuration: useEditor.getState().inputDuration, noteId: selection.noteId });
      return { score: result.score, select: selectEvent(result.score, result.nextEventId ?? id) };
    });
  },

  /** Pencil in (or rub out) a bowing or breath at the selected notes, or a highlight on the selected bars. */
  pencilToggle(kind: "up-bow" | "down-bow" | "breath" | "highlight") {
    run(`Pencil: ${PENCIL_NAMES[kind]}`, (score, selection) => {
      const places = pencilPlaces(score, selection, kind === "highlight" ? "bar" : "note");
      if (!places.length) throw new EditError(kind === "highlight" ? "Select a bar of one part first." : "Select a note first.");
      // All on, unless all are on already: then all off.
      const allOn = places.every((place) => hasPencilMark(score, place.partId, place, kind));
      return places.reduce((next, place) => (allOn || !hasPencilMark(next, place.partId, place, kind) ? togglePencilMark(next, place.partId, place, kind) : next), score);
    });
  },

  /** Pencil in a fingering or words at the selected note, or a rehearsal letter or words on the selected bar. */
  async pencilText(kind: "fingering" | "text" | "rehearsal", on: "note" | "bar") {
    const { score, selection } = current();
    const place = score ? pencilPlaces(score, selection, on)[0] : undefined;
    if (!score || !place) {
      notifications.show({ color: "orange", message: on === "note" ? "Select a note first." : "Select a bar of one part first." });
      return;
    }
    const measureIndex = score.measures.findIndex((m) => m.id === place.measureId);
    const existing = hasPencilMark(score, place.partId, place, kind)?.text;
    const initial = existing ?? (kind === "rehearsal" ? nextRehearsalLetter(score, place.partId, measureIndex) : "");
    const title = kind === "fingering" ? "Fingering (e.g. 3, or 1-2)" : kind === "rehearsal" ? "Rehearsal letter" : "Words in pencil";
    const text = await modals.prompt(title, initial, existing !== undefined ? "Leave it empty to rub it out" : undefined);
    if (text === null) return;
    run(`Pencil: ${PENCIL_NAMES[kind]}`, (s) => setPencilMark(s, place.partId, { ...place, kind, text }));
  },

  /** Rub out every pencil mark at the selected notes (or on the selected bars). */
  pencilErase() {
    run("Rub out pencil marks", (score, selection) => {
      const places = [...pencilPlaces(score, selection, "note"), ...(selection.eventIds.length ? [] : pencilPlaces(score, selection, "bar"))];
      if (!places.length) throw new EditError("Select the notes or bars to rub out.");
      return places.reduce((next, place) => removePencilMarks(next, place.partId, place), score);
    });
  },

  move(move: PitchMove) {
    const { view } = current();
    run("Move notes", (score, selection) => moveNotes(score, targets(selection), move, view));
  },

  alter(delta: 1 | -1) {
    const { view } = current();
    run(delta > 0 ? "Sharpen" : "Flatten", (score, selection) => alterNotes(score, targets(selection), delta, view));
  },

  respell() {
    const { view } = current();
    run("Respell", (score, selection) => respellNotes(score, targets(selection), view));
  },

  duration(duration: Duration) {
    useEditor.getState().setInputDuration(duration);
    run("Change length", (score, selection) => {
      // Notes swallowed by an earlier, longer one are skipped.
      const next = setDurations(score, selection.eventIds, duration);
      if (next === score && selection.eventIds.length === 1) {
        const ev = eventById(score, selection.eventIds[0]!);
        if (ev && (ev.duration.type !== duration.type || ev.duration.dots !== duration.dots)) {
          throw new EditError("There is no room for a longer note before the barline.");
        }
      }
      return next;
    });
  },

  dot() {
    run("Dot", (score, selection) => toggleDots(score, selection.eventIds));
  },

  remove() {
    run("Delete", (score, selection) => deleteNotes(score, targets(selection)));
  },

  tie() {
    run("Tie", (score, selection) => toggleTies(score, selection.eventIds));
  },

  articulation(articulation: Articulation) {
    run(`Toggle ${articulation}`, (score, selection) => toggleArticulation(score, selection.eventIds, articulation));
  },

  dynamic(dynamic: Dynamic | null) {
    run(dynamic ? `Dynamic ${dynamic}` : "Remove dynamic", (score, selection) => {
      const id = selection.eventIds[0];
      if (!id) throw new EditError("Select the note where the dynamic starts.");
      return setDynamic(score, id, dynamic);
    });
  },

  chord(steps: number) {
    const { view } = current();
    run("Add chord note", (score, selection) => {
      let next = score;
      for (const id of selection.eventIds) next = addChordNote(next, id, steps, view);
      return next;
    });
  },

  step(direction: 1 | -1) {
    const { project, score, selection } = current();
    const id = selection.eventIds[selection.eventIds.length - 1];
    if (!score || !id) return;
    const target = direction > 0 ? nextEventId(score, id) : previousEventId(score, id);
    const sel = selectEvent(score, target);
    if (sel) project.select(sel);
  },

  insertBars(where: "before" | "after", count = 1) {
    run(`Insert ${count} bar${count > 1 ? "s" : ""}`, (score, selection) => {
      const range = selection.measures ?? { from: score.measures.length - 1, to: score.measures.length - 1 };
      return insertMeasures(score, where === "before" ? range.from : range.to + 1, count);
    });
  },

  deleteBars() {
    run("Delete bars", (score, selection) => {
      if (!selection.measures) throw new EditError("Select the bars to delete.");
      const next = deleteMeasures(score, selection.measures.from, selection.measures.to);
      return { score: next, select: { eventIds: [] } };
    });
  },

  copy() {
    const { score, selection } = current();
    if (!score || !selection.measures) {
      notifications.show({ color: "orange", message: "Select bars to copy (click a bar, shift-click to extend)." });
      return;
    }
    const partIds = selection.partIds?.length ? selection.partIds : score.parts.map((p) => p.id);
    useEditor.setState({ clipboard: { data: copyMeasures(score, selection.measures.from, selection.measures.to, partIds), parts: partIds.length } });
    notifications.show({ message: `Copied ${selection.measures.to - selection.measures.from + 1} bar(s).`, autoClose: 2000 });
  },

  paste() {
    const clipboard = useEditor.getState().clipboard;
    if (!clipboard) {
      notifications.show({ color: "orange", message: "Nothing copied yet." });
      return;
    }
    run("Paste bars", (score, selection) => {
      if (!selection.measures) throw new EditError("Select the bar to paste into.");
      const firstPart = selection.partIds?.[0] ?? score.parts[0]!.id;
      const start = score.parts.findIndex((p) => p.id === firstPart);
      const partIds = score.parts.slice(start, start + clipboard.parts).map((p) => p.id);
      return pasteMeasures(score, clipboard.data, selection.measures.from, partIds);
    });
  },
};

export const DURATIONS: { key: string; duration: Duration; label: string; name: string }[] = [
  { key: "7", duration: { type: "whole", dots: 0 }, label: "1", name: "Whole note" },
  { key: "6", duration: { type: "half", dots: 0 }, label: "½", name: "Half note" },
  { key: "5", duration: { type: "quarter", dots: 0 }, label: "¼", name: "Quarter note" },
  { key: "4", duration: { type: "eighth", dots: 0 }, label: "⅛", name: "Eighth note" },
  { key: "3", duration: { type: "16th", dots: 0 }, label: "16", name: "16th note" },
  { key: "2", duration: { type: "32nd", dots: 0 }, label: "32", name: "32nd note" },
];

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return /input|textarea|select/i.test(el.tagName) || el.isContentEditable || !!el.closest("[role=dialog]");
}

/** Keyboard shortcuts for editing (close to MuseScore's). Returns true when the key was handled. */
export function handleEditorKey(event: KeyboardEvent): boolean {
  if (typing(event.target)) return false;
  const { selection } = current();
  const hasEvents = selection.eventIds.length > 0;
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key;

  // Copy/paste bars only when bars are selected and no page text is highlighted.
  if (mod && !event.altKey && (key.toLowerCase() === "c" || key.toLowerCase() === "v")) {
    if (!selection.measures || window.getSelection()?.toString()) return false;
    if (key.toLowerCase() === "c") editor.copy();
    else editor.paste();
    return true;
  }
  if (!hasEvents) return false;

  if (/^[a-g]$/i.test(key) && !mod && !event.altKey) {
    editor.enter(key.toUpperCase() as Step);
    return true;
  }
  if (key === "ArrowUp" || key === "ArrowDown") {
    const dir = key === "ArrowUp" ? 1 : -1;
    if (mod) editor.move({ octaves: dir });
    else if (event.altKey) editor.move({ steps: dir });
    else editor.move({ semitones: dir });
    return true;
  }
  if (key === "ArrowRight" || key === "ArrowLeft") {
    editor.step(key === "ArrowRight" ? 1 : -1);
    return true;
  }
  if (event.altKey && /^Digit[2-8]$/.test(event.code)) {
    editor.chord(Number(event.code.slice(5)) - 1);
    return true;
  }
  const duration = DURATIONS.find((d) => d.key === key);
  if (duration && !mod && !event.altKey) {
    editor.duration(duration.duration);
    return true;
  }
  switch (key) {
    case ".":
      editor.dot();
      return true;
    case "0":
    case "Delete":
    case "Backspace":
      editor.remove();
      return true;
    case "+":
      editor.tie();
      return true;
    case "#":
      editor.alter(1);
      return true;
    case "-":
      editor.alter(-1);
      return true;
    case "j":
    case "J":
      editor.respell();
      return true;
    default:
      return false;
  }
}
