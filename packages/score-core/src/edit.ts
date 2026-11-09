/**
 * Editing operations for the note editor (and the AI tools). Every function returns a new score.
 *
 * Pitch input follows what the user sees: in the transposed view ("written"), typing C on a Bb
 * trumpet part means a written C. Pitches are converted to concert pitch for storage.
 */
import { produce, type Draft } from "immer";
import { durationValue, splitValue, type Duration } from "./duration";
import { add, cmp, gt, lt, sub, ZERO, type Fraction } from "./fraction";
import { newId } from "./ids";
import {
  concertKeys,
  emptyPartMeasure,
  eventOnsets,
  eventValue,
  measureLengths,
  measureIsEmpty,
  measureRest,
  renumberMeasures,
  type Articulation,
  type Clef,
  type Dynamic,
  type Id,
  type MeasureInfo,
  type MusicEvent,
  type NoteEvent,
  type Part,
  type PartMeasure,
  type RestEvent,
  type Score,
  type Tempo,
  type TimeSignature,
  type Voice,
} from "./model";
import {
  diatonicNumber,
  enharmonics,
  keyAlterations,
  midiNumber,
  negateInterval,
  samePitch,
  spellMidi,
  STEPS,
  transposePitch,
  type KeySignature,
  type Pitch,
  type Step,
} from "./pitch";
import { writtenContexts, type WrittenContext } from "./transpose";

export type PitchView = "written" | "concert";

export class EditError extends Error {}

interface Found {
  partIndex: number;
  measureIndex: number;
  voiceIndex: number;
  eventIndex: number;
  noteIndex?: number;
}

function find(score: Score, id: Id): Found | undefined {
  for (let p = 0; p < score.parts.length; p++) {
    const measures = score.parts[p]!.measures;
    for (let m = 0; m < measures.length; m++) {
      const voices = measures[m]!.voices;
      for (let v = 0; v < voices.length; v++) {
        const events = voices[v]!.events;
        for (let e = 0; e < events.length; e++) {
          const ev = events[e]!;
          if (ev.id === id) return { partIndex: p, measureIndex: m, voiceIndex: v, eventIndex: e };
          if (ev.kind === "note") {
            const n = ev.notes.findIndex((x) => x.id === id);
            if (n >= 0) return { partIndex: p, measureIndex: m, voiceIndex: v, eventIndex: e, noteIndex: n };
          }
        }
      }
    }
  }
  return undefined;
}

function must(score: Score, id: Id): Found {
  const found = find(score, id);
  if (!found) throw new EditError(`Nothing with id ${id} in the score.`);
  return found;
}

/** Context to convert between what the user sees and concert pitch. */
function viewContext(score: Score, partIndex: number, measureIndex: number, view: PitchView): WrittenContext {
  if (view === "concert") return { key: concertKeys(score)[measureIndex]!, interval: { diatonic: 0, chromatic: 0 } };
  return writtenContexts(score, score.parts[partIndex]!)[measureIndex]!;
}

const toView = (concert: Pitch, ctx: WrittenContext) => transposePitch(concert, ctx.interval);
const fromView = (shown: Pitch, ctx: WrittenContext) => transposePitch(shown, negateInterval(ctx.interval));

function fillRests(value: Fraction): RestEvent[] {
  return splitValue(value).map((duration) => ({ kind: "rest", id: newId("e"), duration }));
}

/** Replace a voice that holds only rests by a whole-bar rest (first voice) or drop it (other voices). */
function tidyVoice(pm: Draft<PartMeasure>, voiceIndex: number) {
  const voice = pm.voices[voiceIndex]!;
  if (voice.events.some((e) => e.kind === "note")) return;
  const isFirst = !pm.voices.some((v, i) => i !== voiceIndex && v.staff === voice.staff && v.voice < voice.voice);
  if (isFirst) voice.events = [measureRest()];
  else pm.voices.splice(voiceIndex, 1);
}

/**
 * Remove tie marks that no longer join two equal notes (after a pitch change, a deletion or a new
 * length), in bars from–to and the bars on either side. Ties to bars outside that window are left alone.
 */
function cleanTies(part: Draft<Part>, from: number, to: number): void {
  const lo = Math.max(0, from - 1);
  const hi = Math.min(part.measures.length - 1, to + 1);
  const streams = new Map<string, { ev: Draft<MusicEvent>; m: number }[]>();
  for (let m = lo; m <= hi; m++) {
    for (const v of part.measures[m]!.voices) {
      const key = `${v.staff}/${v.voice}`;
      let list = streams.get(key);
      if (!list) streams.set(key, (list = []));
      for (const e of v.events) if (!(e.kind === "note" && e.grace)) list.push({ ev: e, m });
    }
  }
  const same = (a: Pitch, b: Pitch) => midiNumber(a) === midiNumber(b);
  for (const list of streams.values()) {
    list.forEach(({ ev, m }, i) => {
      if (ev.kind !== "note") return;
      const next = list[i + 1];
      const prev = list[i - 1];
      for (const n of ev.notes) {
        if (!n.tie) continue;
        // Judge a start only when the next event is known (inside the window) or the part ends here.
        if (n.tie.start && (next || m === part.measures.length - 1)) {
          if (!(next?.ev.kind === "note" && next.ev.notes.some((x) => same(x.pitch, n.pitch)))) delete n.tie.start;
        }
        if (n.tie.stop && prev) {
          if (!(prev.ev.kind === "note" && prev.ev.notes.some((x) => x.tie?.start && same(x.pitch, n.pitch)))) delete n.tie.stop;
        }
        if (!n.tie.start && !n.tie.stop) delete n.tie;
      }
    });
  }
}

/** Bars touched per part, to clean up ties after an edit. */
class Touched {
  private readonly ranges = new Map<number, [number, number]>();
  add(partIndex: number, measureIndex: number) {
    const r = this.ranges.get(partIndex);
    this.ranges.set(partIndex, r ? [Math.min(r[0], measureIndex), Math.max(r[1], measureIndex)] : [measureIndex, measureIndex]);
  }
  cleanTies(draft: Draft<Score>) {
    for (const [p, [from, to]] of this.ranges) cleanTies(draft.parts[p]!, from, to);
  }
}

// ---------------------------------------------------------------------------
// Pitch
// ---------------------------------------------------------------------------

/** The pitch (as shown) of the nearest note before an event in its voice, for octave guessing. */
function referencePitch(score: Score, at: Found, view: PitchView): Pitch | undefined {
  const part = score.parts[at.partIndex]!;
  const voice = part.measures[at.measureIndex]!.voices[at.voiceIndex]!;
  for (let m = at.measureIndex; m >= 0; m--) {
    const v = m === at.measureIndex ? voice : part.measures[m]!.voices.find((x) => x.staff === voice.staff && x.voice === voice.voice);
    if (!v) continue;
    const start = m === at.measureIndex ? at.eventIndex : v.events.length - 1;
    for (let e = start; e >= 0; e--) {
      const ev = v.events[e]!;
      if (ev.kind === "note") return toView(ev.notes[ev.notes.length - 1]!.pitch, viewContext(score, at.partIndex, m, view));
    }
  }
  return undefined;
}

function defaultPitch(score: Score, at: Found): Pitch {
  const part = score.parts[at.partIndex]!;
  const staff = part.measures[at.measureIndex]!.voices[at.voiceIndex]!.staff;
  const clef = part.clefs[staff - 1];
  return clef?.sign === "F" ? { step: "D", alter: 0, octave: 3 } : clef?.sign === "C" ? { step: "C", alter: 0, octave: 4 } : { step: "B", alter: 0, octave: 4 };
}

export interface EntryResult {
  score: Score;
  /** The event to select next, for entering notes one after another. */
  nextEventId?: Id;
}

/** The event after this one in its voice (into the next bar if needed). */
export function nextEventId(score: Score, eventId: Id): Id | undefined {
  const at = find(score, eventId);
  if (!at) return undefined;
  const part = score.parts[at.partIndex]!;
  const voice = part.measures[at.measureIndex]!.voices[at.voiceIndex]!;
  const next = voice.events[at.eventIndex + 1];
  if (next) return next.id;
  for (let m = at.measureIndex + 1; m < part.measures.length; m++) {
    const v = part.measures[m]!.voices.find((x) => x.staff === voice.staff && x.voice === voice.voice) ??
      part.measures[m]!.voices.find((x) => x.staff === voice.staff);
    if (v?.events[0]) return v.events[0].id;
  }
  return undefined;
}

/** The event before this one in its voice (into the previous bar if needed). */
export function previousEventId(score: Score, eventId: Id): Id | undefined {
  const at = find(score, eventId);
  if (!at) return undefined;
  const part = score.parts[at.partIndex]!;
  const voice = part.measures[at.measureIndex]!.voices[at.voiceIndex]!;
  const prev = voice.events[at.eventIndex - 1];
  if (prev) return prev.id;
  for (let m = at.measureIndex - 1; m >= 0; m--) {
    const v = part.measures[m]!.voices.find((x) => x.staff === voice.staff && x.voice === voice.voice) ??
      part.measures[m]!.voices.find((x) => x.staff === voice.staff);
    const last = v?.events[v.events.length - 1];
    if (last) return last.id;
  }
  return undefined;
}

/**
 * Type a note name (A–G) on a note or rest: the nearest octave to the previous note, with the key's
 * accidental. A rest becomes a note of the same length (a whole-bar rest a note of `inputDuration`).
 */
export function enterNote(
  score: Score,
  eventId: Id,
  step: Step,
  options: { view?: PitchView; inputDuration?: Duration; noteId?: Id } = {},
): EntryResult {
  const view = options.view ?? "written";
  const at = must(score, eventId);
  const ctx = viewContext(score, at.partIndex, at.measureIndex, view);
  const event = score.parts[at.partIndex]!.measures[at.measureIndex]!.voices[at.voiceIndex]!.events[at.eventIndex]!;
  const chordIndex = event.kind === "note" ? Math.max(0, event.notes.findIndex((n) => n.id === options.noteId)) : 0;
  const reference =
    event.kind === "note" ? toView(event.notes[chordIndex]!.pitch, ctx) : (referencePitch(score, at, view) ?? defaultPitch(score, at));
  const alter = keyAlterations(ctx.key.fifths)[step];
  let best: Pitch = { step, alter, octave: reference.octave };
  for (const octave of [reference.octave - 1, reference.octave, reference.octave + 1]) {
    const candidate = { step, alter, octave };
    if (Math.abs(diatonicNumber(candidate) - diatonicNumber(reference)) < Math.abs(diatonicNumber(best) - diatonicNumber(reference))) best = candidate;
  }
  const concert = fromView(best, ctx);
  const lengths = measureLengths(score);

  let next = produce(score, (draft) => {
    const pm = draft.parts[at.partIndex]!.measures[at.measureIndex]!;
    const voice = pm.voices[at.voiceIndex]!;
    const ev = voice.events[at.eventIndex]!;
    if (ev.kind === "note") {
      const index = Math.max(0, ev.notes.findIndex((n) => n.id === options.noteId));
      ev.notes[index] = { id: ev.notes[index]!.id, pitch: concert };
      ev.notes.sort((a, b) => midiNumber(a.pitch) - midiNumber(b.pitch));
      return;
    }
    if (ev.measureRest) {
      const length = lengths[at.measureIndex]!;
      let duration = options.inputDuration ?? { type: "quarter", dots: 0 };
      if (gt(durationValue(duration), length)) duration = splitValue(length)[0]!;
      const note: NoteEvent = { kind: "note", id: ev.id, duration, notes: [{ id: newId("n"), pitch: concert }] };
      voice.events.splice(at.eventIndex, 1, note, ...fillRests(sub(length, durationValue(duration))));
      return;
    }
    const note: NoteEvent = { kind: "note", id: ev.id, duration: ev.duration, notes: [{ id: newId("n"), pitch: concert }] };
    voice.events[at.eventIndex] = note;
  });
  // A note typed onto a rest takes the chosen input length, like note input in notation programs.
  if (event.kind === "rest" && !event.measureRest && options.inputDuration) {
    const same =
      options.inputDuration.type === event.duration.type &&
      options.inputDuration.dots === event.duration.dots &&
      !event.duration.tuplet;
    if (!same) next = setDuration(next, eventId, options.inputDuration);
  }
  return { score: next, nextEventId: event.kind === "rest" ? nextEventId(next, eventId) : undefined };
}

export interface PitchMove {
  /** Chromatic steps; spelled for the key that is shown. */
  semitones?: number;
  /** Letter-name steps within the key. */
  steps?: number;
  octaves?: number;
}

/** Move notes up or down. When `noteId` is given only that chord tone moves. */
export function moveNotes(score: Score, ids: Id[], move: PitchMove, view: PitchView = "written"): Score {
  return produce(score, (draft) => {
    const touched = new Touched();
    for (const id of ids) {
      const at = find(draft as Score, id);
      if (!at) continue;
      touched.add(at.partIndex, at.measureIndex);
      const ev = draft.parts[at.partIndex]!.measures[at.measureIndex]!.voices[at.voiceIndex]!.events[at.eventIndex]!;
      if (ev.kind !== "note") continue;
      const ctx = viewContext(draft as Score, at.partIndex, at.measureIndex, view);
      const alterations = keyAlterations(ctx.key.fifths);
      const notes = at.noteIndex !== undefined ? [ev.notes[at.noteIndex]!] : ev.notes;
      for (const note of notes) {
        let shown = toView(note.pitch, ctx);
        if (move.semitones) shown = spellMidi(midiNumber(shown) + move.semitones, ctx.key.fifths, move.semitones > 0 ? "sharp" : "flat");
        if (move.steps) {
          const target = diatonicNumber(shown) + move.steps;
          const step = STEPS[((target % 7) + 7) % 7]!;
          shown = { step, alter: alterations[step], octave: Math.floor(target / 7) };
        }
        if (move.octaves) shown = { ...shown, octave: shown.octave + move.octaves };
        note.pitch = fromView(shown, ctx);
      }
      ev.notes.sort((a, b) => midiNumber(a.pitch) - midiNumber(b.pitch));
    }
    // A tie survives when both of its notes moved together; otherwise both ends are removed.
    touched.cleanTies(draft);
  });
}

/** Raise or lower notes by a semitone keeping their letter (C → C#, B → Bb). */
export function alterNotes(score: Score, ids: Id[], delta: 1 | -1, view: PitchView = "written"): Score {
  return produce(score, (draft) => {
    const touched = new Touched();
    for (const id of ids) {
      const at = find(draft as Score, id);
      if (!at) continue;
      touched.add(at.partIndex, at.measureIndex);
      const ev = draft.parts[at.partIndex]!.measures[at.measureIndex]!.voices[at.voiceIndex]!.events[at.eventIndex]!;
      if (ev.kind !== "note") continue;
      const ctx = viewContext(draft as Score, at.partIndex, at.measureIndex, view);
      const notes = at.noteIndex !== undefined ? [ev.notes[at.noteIndex]!] : ev.notes;
      for (const note of notes) {
        const shown = toView(note.pitch, ctx);
        if (Math.abs(shown.alter + delta) > 2) continue;
        note.pitch = fromView({ ...shown, alter: shown.alter + delta }, ctx);
      }
    }
    touched.cleanTies(draft);
  });
}

/** Spell notes differently without changing their sound (C# ↔ Db). */
export function respellNotes(score: Score, ids: Id[], view: PitchView = "written"): Score {
  return produce(score, (draft) => {
    for (const id of ids) {
      const at = find(draft as Score, id);
      if (!at) continue;
      const ev = draft.parts[at.partIndex]!.measures[at.measureIndex]!.voices[at.voiceIndex]!.events[at.eventIndex]!;
      if (ev.kind !== "note") continue;
      const ctx = viewContext(draft as Score, at.partIndex, at.measureIndex, view);
      const notes = at.noteIndex !== undefined ? [ev.notes[at.noteIndex]!] : ev.notes;
      for (const note of notes) {
        const shown = toView(note.pitch, ctx);
        const options = enharmonics(shown).filter((p) => Math.abs(p.alter) <= 1);
        const index = options.findIndex((p) => samePitch(p, shown));
        const next = options[(index + 1) % options.length];
        if (next) note.pitch = fromView(next, ctx);
      }
    }
  });
}

/** Add a note above (positive steps) or below the chord: steps = 2 is a third, 7 an octave. */
export function addChordNote(score: Score, eventId: Id, steps: number, view: PitchView = "written"): Score {
  const at = must(score, eventId);
  const ev = score.parts[at.partIndex]!.measures[at.measureIndex]!.voices[at.voiceIndex]!.events[at.eventIndex]!;
  if (ev.kind !== "note") throw new EditError("Chord notes can only be added to a note.");
  const ctx = viewContext(score, at.partIndex, at.measureIndex, view);
  const alterations = keyAlterations(ctx.key.fifths);
  const base = toView(ev.notes[steps > 0 ? ev.notes.length - 1 : 0]!.pitch, ctx);
  const target = diatonicNumber(base) + steps;
  const step = STEPS[((target % 7) + 7) % 7]!;
  const shown: Pitch = { step, alter: alterations[step], octave: Math.floor(target / 7) };
  const concert = fromView(shown, ctx);
  if (ev.notes.some((n) => samePitch(n.pitch, concert))) return score;
  return produce(score, (draft) => {
    const e = draft.parts[at.partIndex]!.measures[at.measureIndex]!.voices[at.voiceIndex]!.events[at.eventIndex] as NoteEvent;
    e.notes.push({ id: newId("n"), pitch: concert });
    e.notes.sort((a, b) => midiNumber(a.pitch) - midiNumber(b.pitch));
  });
}

// ---------------------------------------------------------------------------
// Rhythm
// ---------------------------------------------------------------------------

/**
 * Give an event a new length. Shorter: the time left over becomes rests. Longer: following events
 * in the bar are overwritten (a partly covered note leaves rests behind). Never crosses the barline.
 */
export function setDuration(score: Score, eventId: Id, duration: Duration): Score {
  const at = must(score, eventId);
  const length = measureLengths(score)[at.measureIndex]!;
  return produce(score, (draft) => {
    const pm = draft.parts[at.partIndex]!.measures[at.measureIndex]!;
    const voice = pm.voices[at.voiceIndex]!;
    const events = voice.events as MusicEvent[];
    const onsets = eventOnsets(voice as Voice, length);
    const ev = events[at.eventIndex]!;
    if (ev.kind === "note" && ev.grace) {
      ev.duration = duration;
      return;
    }
    const start = onsets[at.eventIndex]!;
    let wanted = durationValue(duration);
    const room = sub(length, start);
    if (gt(wanted, room)) {
      const fits = splitValue(room)[0];
      if (!fits) throw new EditError("There is no room left in this bar.");
      duration = fits;
      wanted = durationValue(fits);
    }
    const unchanged =
      duration.type === ev.duration.type && duration.dots === ev.duration.dots && !duration.tuplet && !ev.duration.tuplet;
    if (unchanged && !(ev.kind === "rest" && ev.measureRest)) return;
    const oldEnd = add(start, eventValue(ev, length));
    const newEnd = add(start, wanted);
    const updated: MusicEvent = { ...(ev as MusicEvent), duration } as MusicEvent;
    if (updated.kind === "rest") delete updated.measureRest;
    const before = events.slice(0, at.eventIndex);
    const after: MusicEvent[] = [];
    if (lt(newEnd, oldEnd)) {
      after.push(...fillRests(sub(oldEnd, newEnd)));
      after.push(...events.slice(at.eventIndex + 1));
    } else {
      // Drop or shorten whatever the longer event now covers.
      for (let i = at.eventIndex + 1; i < events.length; i++) {
        const s = onsets[i]!;
        const e = add(s, eventValue(events[i]!, length));
        if (cmp(e, newEnd) <= 0) continue;
        if (lt(s, newEnd)) after.push(...fillRests(sub(e, newEnd)));
        else after.push(events[i]!);
      }
    }
    voice.events = [...before, updated, ...after] as typeof voice.events;
    // Fill up a bar that is now short.
    const total = voice.events.reduce((t, e) => add(t, eventValue(e as MusicEvent, length)), ZERO);
    if (lt(total, length)) voice.events.push(...fillRests(sub(length, total)));
    // Notes that were overwritten may have been tied.
    cleanTies(draft.parts[at.partIndex]!, at.measureIndex, at.measureIndex);
  });
}

/** Give several events a new length; events swallowed by an earlier, longer one are skipped. */
export function setDurations(score: Score, ids: Id[], duration: Duration): Score {
  let next = score;
  for (const id of ids) if (find(next, id)) next = setDuration(next, id, duration);
  return next;
}

/** Add a dot, or remove it if the event already has one. */
export function toggleDot(score: Score, eventId: Id): Score {
  const at = must(score, eventId);
  const ev = score.parts[at.partIndex]!.measures[at.measureIndex]!.voices[at.voiceIndex]!.events[at.eventIndex]!;
  if (ev.kind === "rest" && ev.measureRest) return score;
  return setDuration(score, eventId, { ...ev.duration, dots: ev.duration.dots ? 0 : 1 });
}

/** Add or remove dots on several events; events swallowed by an earlier, longer one are skipped. */
export function toggleDots(score: Score, ids: Id[]): Score {
  let next = score;
  for (const id of ids) if (find(next, id)) next = toggleDot(next, id);
  return next;
}

/** Turn notes into rests (or remove one tone from a chord when a chord tone id is given). */
export function deleteNotes(score: Score, ids: Id[]): Score {
  return produce(score, (draft) => {
    const touched = new Set<string>();
    const bars = new Touched();
    for (const id of ids) {
      const at = find(draft as Score, id);
      if (!at) continue;
      bars.add(at.partIndex, at.measureIndex);
      const pm = draft.parts[at.partIndex]!.measures[at.measureIndex]!;
      const voice = pm.voices[at.voiceIndex]!;
      const ev = voice.events[at.eventIndex]!;
      if (ev.kind !== "note") continue;
      if (at.noteIndex !== undefined && ev.notes.length > 1) {
        ev.notes.splice(at.noteIndex, 1);
        continue;
      }
      if (ev.grace) {
        voice.events.splice(at.eventIndex, 1);
      } else {
        voice.events[at.eventIndex] = { kind: "rest", id: ev.id, duration: ev.duration };
      }
      touched.add(`${at.partIndex}/${at.measureIndex}/${at.voiceIndex}`);
    }
    for (const key of [...touched].sort().reverse()) {
      const [p, m, v] = key.split("/").map(Number) as [number, number, number];
      tidyVoice(draft.parts[p]!.measures[m]!, v);
    }
    bars.cleanTies(draft);
  });
}

// ---------------------------------------------------------------------------
// Ties, articulations, dynamics
// ---------------------------------------------------------------------------

/** Tie notes to the same notes in the next event, or remove the tie. */
export function toggleTie(score: Score, eventId: Id): Score {
  const at = must(score, eventId);
  const ev = score.parts[at.partIndex]!.measures[at.measureIndex]!.voices[at.voiceIndex]!.events[at.eventIndex]!;
  if (ev.kind !== "note") throw new EditError("Only notes can be tied.");
  const nextId = nextEventId(score, eventId);
  const nextAt = nextId ? find(score, nextId) : undefined;
  const next = nextAt
    ? score.parts[nextAt.partIndex]!.measures[nextAt.measureIndex]!.voices[nextAt.voiceIndex]!.events[nextAt.eventIndex]!
    : undefined;
  const removing = ev.notes.every((n) => n.tie?.start);
  if (!removing && (!next || next.kind !== "note" || !ev.notes.some((n) => next.notes.some((m) => samePitch(m.pitch, n.pitch))))) {
    throw new EditError("A tie needs the same note right after it.");
  }
  return produce(score, (draft) => {
    const e = draft.parts[at.partIndex]!.measures[at.measureIndex]!.voices[at.voiceIndex]!.events[at.eventIndex] as NoteEvent;
    const n = nextAt
      ? (draft.parts[nextAt.partIndex]!.measures[nextAt.measureIndex]!.voices[nextAt.voiceIndex]!.events[nextAt.eventIndex] as MusicEvent)
      : undefined;
    for (const note of e.notes) {
      const partner = n?.kind === "note" ? n.notes.find((m) => samePitch(m.pitch, note.pitch)) : undefined;
      if (removing) {
        if (note.tie) delete note.tie.start;
        if (partner?.tie) delete partner.tie.stop;
      } else if (partner) {
        note.tie = { ...note.tie, start: true };
        partner.tie = { ...partner.tie, stop: true };
      }
      if (note.tie && !note.tie.start && !note.tie.stop) delete note.tie;
      if (partner?.tie && !partner.tie.start && !partner.tie.stop) delete partner.tie;
    }
  });
}

/** Tie or untie several notes; notes that can't be tied are skipped unless none can. */
export function toggleTies(score: Score, ids: Id[]): Score {
  let next = score;
  let firstError: EditError | undefined;
  let done = 0;
  for (const id of ids) {
    if (!find(next, id)) continue;
    try {
      next = toggleTie(next, id);
      done++;
    } catch (error) {
      if (!(error instanceof EditError)) throw error;
      firstError ??= error;
    }
  }
  if (!done && firstError) throw firstError;
  return next;
}

/** Add an articulation to the notes, or remove it if they all have it already. */
export function toggleArticulation(score: Score, ids: Id[], articulation: Articulation): Score {
  const events = ids
    .map((id) => find(score, id))
    .filter((f): f is Found => !!f)
    .map((f) => score.parts[f.partIndex]!.measures[f.measureIndex]!.voices[f.voiceIndex]!.events[f.eventIndex]!)
    .filter((e): e is NoteEvent => e.kind === "note");
  const remove = events.length > 0 && events.every((e) => e.articulations?.includes(articulation));
  return produce(score, (draft) => {
    for (const id of ids) {
      const at = find(draft as Score, id);
      if (!at) continue;
      const ev = draft.parts[at.partIndex]!.measures[at.measureIndex]!.voices[at.voiceIndex]!.events[at.eventIndex]!;
      if (ev.kind !== "note") continue;
      const list = new Set(ev.articulations ?? []);
      if (remove) list.delete(articulation);
      else list.add(articulation);
      // Accent and marcato, staccato and staccatissimo exclude each other.
      if (!remove && articulation === "accent") list.delete("marcato");
      if (!remove && articulation === "marcato") list.delete("accent");
      if (!remove && articulation === "staccato") list.delete("staccatissimo");
      if (!remove && articulation === "staccatissimo") list.delete("staccato");
      if (list.size) ev.articulations = [...list];
      else delete ev.articulations;
    }
  });
}

/** Put a dynamic under an event (replacing one already there), or remove it with null. */
export function setDynamic(score: Score, eventId: Id, dynamic: Dynamic | null): Score {
  const at = must(score, eventId);
  const length = measureLengths(score)[at.measureIndex]!;
  const voice = score.parts[at.partIndex]!.measures[at.measureIndex]!.voices[at.voiceIndex]!;
  const offset = eventOnsets(voice, length)[at.eventIndex]!;
  return produce(score, (draft) => {
    const pm = draft.parts[at.partIndex]!.measures[at.measureIndex]!;
    const directions = (pm.directions ?? []).filter(
      (d) => !(d.kind === "dynamic" && d.staff === voice.staff && cmp(d.offset, offset) === 0),
    );
    if (dynamic) directions.push({ id: newId("d"), kind: "dynamic", staff: voice.staff, offset, value: dynamic });
    if (directions.length) pm.directions = directions;
    else delete pm.directions;
  });
}

/** Add text (e.g. "dolce", "solo") above an event, or remove all text there with an empty string. */
export function setText(score: Score, eventId: Id, text: string): Score {
  const at = must(score, eventId);
  const length = measureLengths(score)[at.measureIndex]!;
  const voice = score.parts[at.partIndex]!.measures[at.measureIndex]!.voices[at.voiceIndex]!;
  const offset = eventOnsets(voice, length)[at.eventIndex]!;
  return produce(score, (draft) => {
    const pm = draft.parts[at.partIndex]!.measures[at.measureIndex]!;
    const directions = (pm.directions ?? []).filter((d) => !(d.kind === "words" && d.staff === voice.staff && cmp(d.offset, offset) === 0));
    if (text.trim()) directions.push({ id: newId("d"), kind: "words", staff: voice.staff, offset, text: text.trim() });
    if (directions.length) pm.directions = directions;
    else delete pm.directions;
  });
}

/** A crescendo or diminuendo hairpin from one event to another (in the same part). */
export function addHairpin(score: Score, fromEventId: Id, toEventId: Id, type: "crescendo" | "diminuendo"): Score {
  const from = must(score, fromEventId);
  const to = must(score, toEventId);
  if (from.partIndex !== to.partIndex) throw new EditError("A hairpin must stay in one part.");
  const lengths = measureLengths(score);
  const part = score.parts[from.partIndex]!;
  const fromVoice = part.measures[from.measureIndex]!.voices[from.voiceIndex]!;
  const toVoice = part.measures[to.measureIndex]!.voices[to.voiceIndex]!;
  const startOffset = eventOnsets(fromVoice, lengths[from.measureIndex]!)[from.eventIndex]!;
  const toEvent = toVoice.events[to.eventIndex]!;
  const endOffset = add(eventOnsets(toVoice, lengths[to.measureIndex]!)[to.eventIndex]!, eventValue(toEvent, lengths[to.measureIndex]!));
  return produce(score, (draft) => {
    const start = draft.parts[from.partIndex]!.measures[from.measureIndex]!;
    (start.directions ??= []).push({ id: newId("d"), kind: "wedge", staff: fromVoice.staff, offset: startOffset, type });
    const end = draft.parts[to.partIndex]!.measures[to.measureIndex]!;
    (end.directions ??= []).push({ id: newId("d"), kind: "wedge", staff: toVoice.staff, offset: endOffset, type: "stop" });
  });
}

// ---------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------

/** Insert empty bars before measure `at` (at = length appends at the end). */
export function insertMeasures(score: Score, at: number, count = 1): Score {
  return produce(score, (draft) => {
    const index = Math.max(0, Math.min(at, draft.measures.length));
    const infos: MeasureInfo[] = Array.from({ length: count }, () => ({ id: newId("m"), number: "" }));
    if (index === 0 && draft.measures[0]) {
      // The first bar carries the opening time and key signatures.
      const first = draft.measures[0];
      infos[0]!.time = first.time;
      infos[0]!.key = first.key;
      infos[0]!.tempo = first.tempo;
      delete first.time;
      delete first.key;
      delete first.tempo;
    }
    draft.measures.splice(index, 0, ...infos);
    for (const part of draft.parts) {
      part.measures.splice(index, 0, ...infos.map(() => emptyPartMeasure(part.staves)));
    }
    if (index === draft.measures.length - count && index > 0) {
      // Appending: move a final barline to the new last bar.
      const previous = draft.measures[index - 1]!;
      if (previous.barline === "final") {
        delete previous.barline;
        draft.measures[draft.measures.length - 1]!.barline = "final";
      }
    }
    renumberMeasures(draft);
  });
}

/** Delete bars from..to (inclusive). The opening signatures move to the new first bar. */
export function deleteMeasures(score: Score, from: number, to: number): Score {
  if (to - from + 1 >= score.measures.length) throw new EditError("A score needs at least one bar.");
  const times = score.measures.map((m) => m.time);
  const tempos = score.measures.map((m) => m.tempo);
  const keys = concertKeys(score);
  return produce(score, (draft) => {
    const after = draft.measures[to + 1];
    if (after) {
      // Keep the signatures that were in force after the deleted range.
      let time: TimeSignature | undefined;
      for (let i = to; i >= 0 && !time; i--) time = times[i];
      if (!after.time && time && (from === 0 || to + 1 < draft.measures.length)) after.time = time;
      if (!after.key) after.key = keys[to];
      // A tempo marked in the deleted bars (e.g. the opening tempo) still applies afterwards.
      if (!after.tempo) {
        for (let i = to; i >= from; i--) {
          if (tempos[i]) {
            after.tempo = tempos[i];
            break;
          }
        }
      }
    } else if (from > 0 && draft.measures[to]!.barline === "final") {
      // Deleting the last bars: the new last bar gets the final barline.
      const last = draft.measures[from - 1]!;
      if (!last.barline || last.barline === "regular") last.barline = "final";
    }
    draft.measures.splice(from, to - from + 1);
    for (const part of draft.parts) part.measures.splice(from, to - from + 1);
    if (from > 0) {
      // Drop signatures that now repeat the previous bar's.
      const prevTime = (() => {
        for (let i = from - 1; i >= 0; i--) if (draft.measures[i]!.time) return draft.measures[i]!.time;
        return undefined;
      })();
      const m = draft.measures[from];
      if (m?.time && prevTime && m.time.beats === prevTime.beats && m.time.beatType === prevTime.beatType) delete m.time;
      if (m?.key && keys[from - 1] && m.key.fifths === keys[from - 1]!.fifths) delete m.key;
    }
    renumberMeasures(draft);
  });
}

// ---------------------------------------------------------------------------
// Multi-bar rests
// ---------------------------------------------------------------------------

/** Whether a bar is rests only, in every part and voice (dynamics and other marks may be there). */
export function isRestBar(score: Score, measureIndex: number): boolean {
  if (!score.measures[measureIndex] || score.measures[measureIndex]!.implicit) return false;
  return score.parts.every((part) => measureIsEmpty(part.measures[measureIndex]));
}

/** Runs of consecutive whole-bar rests (in every part): where a multi-bar rest may have been read as one bar. */
export function restRuns(score: Score): { from: number; to: number }[] {
  const runs: { from: number; to: number }[] = [];
  score.measures.forEach((_, m) => {
    if (!isRestBar(score, m)) return;
    const last = runs[runs.length - 1];
    if (last && last.to === m - 1) last.to = m;
    else runs.push({ from: m, to: m });
  });
  return runs;
}

const MAX_REST_BARS = 500;

/**
 * Turn the whole-bar rest at a bar into a rest of `bars` bars: the bar printed as a multi-bar rest
 * (a number over the staff) that recognition read as a single bar. Empty bars are inserted after it.
 */
export function expandMultiRest(score: Score, measureIndex: number, bars: number): Score {
  const label = score.measures[measureIndex]?.number ?? String(measureIndex + 1);
  if (!isRestBar(score, measureIndex)) throw new EditError(`Bar ${label} has notes, so it isn't a multi-bar rest.`);
  if (!Number.isInteger(bars) || bars < 1 || bars > MAX_REST_BARS) throw new EditError(`A multi-bar rest lasts 1 to ${MAX_REST_BARS} bars.`);
  if (bars === 1) return score;
  return insertMeasures(score, measureIndex + 1, bars - 1);
}

/**
 * Make the run of whole-bar rests that contains a bar last `bars` bars in total, adding or removing
 * empty bars at its end.
 */
export function setRestLength(score: Score, measureIndex: number, bars: number): Score {
  if (!isRestBar(score, measureIndex)) {
    throw new EditError(`Bar ${score.measures[measureIndex]?.number ?? measureIndex + 1} has notes, so it isn't a rest.`);
  }
  if (!Number.isInteger(bars) || bars < 1 || bars > MAX_REST_BARS) throw new EditError(`A rest lasts 1 to ${MAX_REST_BARS} bars.`);
  const run = restRuns(score).find((r) => r.from <= measureIndex && measureIndex <= r.to)!;
  const length = run.to - run.from + 1;
  if (bars > length) return insertMeasures(score, run.to + 1, bars - length);
  if (bars < length) return deleteMeasures(score, run.from + bars, run.to);
  return score;
}

export interface MeasureClipboard {
  measures: { parts: PartMeasure[] }[];
}

/** Copy bars of some parts (all parts when partIds is empty). */
export function copyMeasures(score: Score, from: number, to: number, partIds?: Id[]): MeasureClipboard {
  const parts = score.parts.filter((p) => !partIds?.length || partIds.includes(p.id));
  const measures: MeasureClipboard["measures"] = [];
  for (let m = from; m <= to; m++) {
    measures.push({ parts: parts.map((p) => structuredClone(p.measures[m]!) as PartMeasure) });
  }
  return { measures };
}

function freshIds(pm: PartMeasure): PartMeasure {
  return {
    ...pm,
    voices: pm.voices.map((v) => ({
      ...v,
      events: v.events.map((e) =>
        e.kind === "note" ? { ...e, id: newId("e"), notes: e.notes.map((n) => ({ ...n, id: newId("n") })) } : { ...e, id: newId("e") },
      ),
    })),
    directions: pm.directions?.map((d) => ({ ...d, id: newId("d") })),
  };
}

/** Paste copied bars starting at bar `at` into the given parts (in order), adding bars at the end if needed. */
export function pasteMeasures(score: Score, clipboard: MeasureClipboard, at: number, partIds: Id[]): Score {
  let result = score;
  const needed = at + clipboard.measures.length - score.measures.length;
  if (needed > 0) result = insertMeasures(result, result.measures.length, needed);
  return produce(result, (draft) => {
    clipboard.measures.forEach((copied, k) => {
      copied.parts.forEach((pm, i) => {
        const part = draft.parts.find((p) => p.id === partIds[i]);
        if (!part) return;
        const fresh = freshIds(pm);
        // Staves beyond the target's are dropped; missing ones get rests.
        fresh.voices = fresh.voices.filter((v) => v.staff <= part.staves);
        for (let s = 1; s <= part.staves; s++) {
          if (!fresh.voices.some((v) => v.staff === s)) fresh.voices.push({ staff: s, voice: 1, events: [measureRest()] });
        }
        part.measures[at + k] = fresh as Draft<PartMeasure>;
      });
    });
  });
}

export function setKeySignature(score: Score, measureIndex: number, key: KeySignature | null): Score {
  return produce(score, (draft) => {
    const m = draft.measures[measureIndex];
    if (!m) return;
    if (key) m.key = key;
    else if (measureIndex > 0) delete m.key;
  });
}

export function setTimeSignature(score: Score, measureIndex: number, time: TimeSignature | null): Score {
  return produce(score, (draft) => {
    const m = draft.measures[measureIndex];
    if (!m) return;
    if (time) m.time = time;
    else if (measureIndex > 0) delete m.time;
  });
}

export function setClef(score: Score, partId: Id, staff: number, measureIndex: number, clef: Clef): Score {
  return produce(score, (draft) => {
    const part = draft.parts.find((p) => p.id === partId);
    if (!part) return;
    if (measureIndex === 0) {
      part.clefs[staff - 1] = clef;
      return;
    }
    const pm = part.measures[measureIndex]!;
    const changes = (pm.clefChanges ?? []).filter((c) => !(c.staff === staff && cmp(c.offset, ZERO) === 0));
    changes.push({ staff, offset: ZERO, clef });
    pm.clefChanges = changes;
  });
}

export function setTempo(score: Score, measureIndex: number, tempo: Tempo | null): Score {
  return produce(score, (draft) => {
    const m = draft.measures[measureIndex];
    if (!m) return;
    if (tempo) m.tempo = tempo;
    else delete m.tempo;
  });
}

export function setRehearsal(score: Score, measureIndex: number, text: string | null): Score {
  return produce(score, (draft) => {
    const m = draft.measures[measureIndex];
    if (!m) return;
    if (text?.trim()) m.rehearsal = text.trim();
    else delete m.rehearsal;
  });
}

export function setBarline(score: Score, measureIndex: number, options: Partial<Pick<MeasureInfo, "barline" | "repeatStart" | "repeatEnd">>): Score {
  return produce(score, (draft) => {
    const m = draft.measures[measureIndex];
    if (!m) return;
    if ("barline" in options) {
      if (options.barline && options.barline !== "regular") m.barline = options.barline;
      else delete m.barline;
    }
    if ("repeatStart" in options) {
      if (options.repeatStart) m.repeatStart = true;
      else delete m.repeatStart;
    }
    if ("repeatEnd" in options) {
      if (options.repeatEnd) m.repeatEnd = options.repeatEnd;
      else delete m.repeatEnd;
    }
  });
}

/** The step letter (as shown) of a pitch, for UIs. */
export function shownPitch(score: Score, eventId: Id, view: PitchView): Pitch[] {
  const at = find(score, eventId);
  if (!at) return [];
  const ev = score.parts[at.partIndex]!.measures[at.measureIndex]!.voices[at.voiceIndex]!.events[at.eventIndex]!;
  if (ev.kind !== "note") return [];
  const ctx = viewContext(score, at.partIndex, at.measureIndex, view);
  return ev.notes.map((n) => toView(n.pitch, ctx));
}
