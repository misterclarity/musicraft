/**
 * A deterministic first-draft arranger, e.g. piano → brass quintet:
 * the top line becomes the melody, the lowest line the bass, and the inner instruments play the
 * harmony as sustained chords with smooth voice leading inside comfortable ranges. Breath marks are
 * added in long passages, and the result comes with a playability report. The AI assistant (or the
 * user) refines the draft.
 */
import { checkScore } from "./checks";
import { splitValue } from "./duration";
import { add, cmp, gt, lt, max, min, sub, ZERO, type Fraction } from "./fraction";
import { analysisBeat, nameChord, soundingNotes, type ChordGuess } from "./harmony";
import { newId } from "./ids";
import { getEnsemble, getInstrument, type EnsembleTemplate, type InstrumentDef } from "./instruments";
import {
  concertKeys,
  eventOnsets,
  timeSignatures,
  eventValue,
  measureLengths,
  SCORE_SCHEMA_VERSION,
  voiceLength,
  type Direction,
  type Id,
  type MusicEvent,
  type NoteEvent,
  type Part,
  type Score,
} from "./model";
import { newPart } from "./ops";
import { midiNumber, spellMidi, transposePitch, type Pitch } from "./pitch";

export interface ArrangeOptions {
  /** An ensemble template id (see ENSEMBLES) … */
  ensemble?: string;
  /** … or a list of instrument ids, highest first. */
  instruments?: { instrument: string; name?: string }[];
  /** Parts to arrange from (default: all). */
  sourcePartIds?: Id[];
  /** Keep the source parts below the new ones (e.g. the piano as a reference). */
  keepSource?: boolean;
  /** Add breath marks in long passages (default true). */
  breaths?: boolean;
}

export interface ArrangeResult {
  score: Score;
  /** What was done and what to check, in plain sentences. */
  report: string[];
}

interface Sounding {
  start: Fraction;
  end: Fraction;
  pitch: Pitch;
}

interface Item {
  start: Fraction;
  end: Fraction;
  pitches: Pitch[];
}

const MIDI = (p: Pitch) => midiNumber(p);

/** Concert MIDI range of an instrument (comfortable or full). */
function concertRange(instrument: InstrumentDef, which: "comfortable" | "range"): [number, number] {
  const r = instrument[which];
  return [MIDI(transposePitch(r.low, instrument.transposition)), MIDI(transposePitch(r.high, instrument.transposition))];
}

function withOctave(p: Pitch, octaves: number): Pitch {
  return { ...p, octave: p.octave + octaves };
}

/** Notes of one staff of some parts in a bar, with their times. */
function staffNotes(score: Score, parts: Part[], m: number, staffOf: (part: Part) => number[]): Sounding[] {
  const length = measureLengths(score)[m]!;
  const out: Sounding[] = [];
  for (const part of parts) {
    const staves = staffOf(part);
    for (const voice of part.measures[m]?.voices ?? []) {
      if (!staves.includes(voice.staff)) continue;
      const onsets = eventOnsets(voice, length);
      voice.events.forEach((e, i) => {
        if (e.kind !== "note" || e.grace) return;
        const start = onsets[i]!;
        const end = add(start, eventValue(e, length));
        for (const n of e.notes) out.push({ start, end, pitch: n.pitch });
      });
    }
  }
  return out;
}

/**
 * The top (or bottom) line of some notes: at each attack the highest (lowest) new note, unless a
 * note that is still sounding is higher (lower), in which case it keeps going.
 */
export function extractLine(notes: Sounding[], which: "top" | "bottom"): Sounding[] {
  const better = (a: Pitch, b: Pitch) => (which === "top" ? MIDI(a) > MIDI(b) : MIDI(a) < MIDI(b));
  const attacks = [...new Set(notes.map((n) => `${n.start.n}/${n.start.d}`))]
    .map((k) => notes.find((n) => `${n.start.n}/${n.start.d}` === k)!.start)
    .sort(cmp);
  const line: Sounding[] = [];
  let current: Sounding | null = null;
  for (const t of attacks) {
    const starting = notes.filter((n) => cmp(n.start, t) === 0);
    let pick = starting[0]!;
    for (const n of starting) if (better(n.pitch, pick.pitch) || (MIDI(n.pitch) === MIDI(pick.pitch) && gt(n.end, pick.end))) pick = n;
    if (current && gt(current.end, t) && !better(pick.pitch, current.pitch)) continue;
    if (current) current.end = min(current.end, t);
    current = { ...pick };
    line.push(current);
  }
  return line;
}

/** Events for a voice from timed items: rests fill the gaps; odd lengths become tied notes. */
function toEvents(items: Item[], barLength: Fraction): MusicEvent[] {
  const sorted = [...items].filter((i) => lt(i.start, i.end)).sort((a, b) => cmp(a.start, b.start));
  const events: MusicEvent[] = [];
  let t = ZERO;
  const rests = (value: Fraction) => {
    for (const duration of splitValue(value)) events.push({ kind: "rest", id: newId("e"), duration });
  };
  for (const item of sorted) {
    const start = max(item.start, t);
    const end = min(item.end, barLength);
    if (!lt(start, end)) continue;
    if (gt(start, t)) rests(sub(start, t));
    const pieces = splitValue(sub(end, start));
    pieces.forEach((duration, k) => {
      const tieStart = k < pieces.length - 1;
      const tieStop = k > 0;
      const ev: NoteEvent = {
        kind: "note",
        id: newId("e"),
        duration,
        notes: item.pitches.map((pitch) => ({
          id: newId("n"),
          pitch,
          ...(tieStart || tieStop ? { tie: { ...(tieStart ? { start: true } : {}), ...(tieStop ? { stop: true } : {}) } } : {}),
        })),
      };
      events.push(ev);
    });
    t = end;
  }
  if (lt(t, barLength)) {
    if (cmp(t, ZERO) === 0) return [{ kind: "rest", id: newId("e"), duration: { type: "whole", dots: 0 }, measureRest: true }];
    rests(sub(barLength, t));
  }
  return events;
}

function fitScore(pitches: number[], range: [number, number], k: number): number {
  let score = 0;
  for (const p of pitches) {
    const q = p + 12 * k;
    const outside = q < range[0] ? range[0] - q : q > range[1] ? q - range[1] : 0;
    // A note or two past the comfortable range is fine now and then; further out is not.
    if (outside === 0) score += 1;
    else if (outside <= 2) score += 0.5;
    else score -= outside / 12;
  }
  return score;
}

/**
 * Whole-octave shifts that bring a line into a range, chosen per phrase of `chunk` bars: no shift is
 * preferred, and so is keeping the previous phrase's shift (no jumps without a reason).
 */
export function phraseOctaveShifts(bars: number[][], range: [number, number], chunk = 4): number[] {
  const shifts: number[] = [];
  let previous = 0;
  for (let start = 0; start < bars.length; start += chunk) {
    const pitches = bars.slice(start, start + chunk).flat();
    let best = previous;
    if (pitches.length) {
      let bestScore = -Infinity;
      for (const k of [0, 1, -1, 2, -2]) {
        const score = fitScore(pitches, range, k) - (k !== previous ? 0.15 * pitches.length : 0) - 0.12 * Math.abs(k) * pitches.length;
        if (score > bestScore + 1e-9) {
          best = k;
          bestScore = score;
        }
      }
    }
    for (let m = start; m < Math.min(bars.length, start + chunk); m++) shifts.push(best);
    previous = best;
  }
  return shifts;
}

interface VoiceSlot {
  instrument: InstrumentDef;
  comfortable: [number, number];
  full: [number, number];
  previous: number | null;
}

/** Choose pitches for the inner voices of one chord, high to low, with smooth voice leading. */
function voiceChord(chord: ChordGuess, melody: number | null, bass: number | null, slots: VoiceSlot[]): (number | null)[] {
  const pcs = chord.pitchClasses;
  const root = pcs[0]!;
  const third = pcs[1];
  const fifth = pcs[2];
  const seventh = pcs[3];
  const order = [third, seventh, root, fifth, ...pcs.slice(4)].filter((x): x is number => x !== undefined);
  const covered = new Set<number>();
  if (melody !== null) covered.add(((melody % 12) + 12) % 12);
  if (bass !== null) covered.add(((bass % 12) + 12) % 12);
  const result: (number | null)[] = [];
  let ceiling = melody !== null ? melody - 1 : Infinity;
  const floor = bass !== null ? bass + 1 : -Infinity;
  for (const slot of slots) {
    const needed = order.filter((pc) => !covered.has(pc));
    const center = slot.previous ?? Math.round((slot.comfortable[0] + slot.comfortable[1]) / 2);
    let best: { pitch: number; cost: number } | null = null;
    for (const pc of new Set([...needed, ...order])) {
      for (let pitch = slot.full[0]; pitch <= slot.full[1]; pitch++) {
        if (((pitch % 12) + 12) % 12 !== pc) continue;
        if (pitch > ceiling || pitch < floor) continue;
        let cost = Math.abs(pitch - center);
        if (!needed.includes(pc)) cost += 5; // doubling
        if (pc === third && covered.has(pc)) cost += 6; // avoid doubled thirds
        if (pitch < slot.comfortable[0] || pitch > slot.comfortable[1]) cost += 7;
        if (result.length && result[result.length - 1] === pitch) cost += 4; // unison with the voice above
        if (!best || cost < best.cost) best = { pitch, cost };
      }
    }
    if (best) {
      result.push(best.pitch);
      covered.add(((best.pitch % 12) + 12) % 12);
      ceiling = best.pitch;
    } else result.push(null);
  }
  return result;
}

function spellLike(midi: number, sources: Pitch[], keyFifths: number): Pitch {
  const pc = ((midi % 12) + 12) % 12;
  const same = sources.find((p) => ((MIDI(p) % 12) + 12) % 12 === pc);
  if (same) return withOctave(same, Math.round((midi - MIDI(same)) / 12));
  return spellMidi(midi, keyFifths);
}

function template(options: ArrangeOptions): { instrument: string; name: string }[] {
  if (options.instruments?.length) return options.instruments.map((i) => ({ instrument: i.instrument, name: i.name ?? getInstrument(i.instrument).name }));
  const ensemble: EnsembleTemplate | undefined = getEnsemble(options.ensemble ?? "brass-quintet");
  if (!ensemble) throw new Error(`Unknown ensemble "${options.ensemble}".`);
  return ensemble.parts;
}

/** Arrange the source parts for an ensemble. */
export function arrangeForEnsemble(score: Score, options: ArrangeOptions = {}): ArrangeResult {
  const targets = template(options);
  if (targets.length < 2) throw new Error("An arrangement needs at least two instruments.");
  const sources = options.sourcePartIds?.length ? score.parts.filter((p) => options.sourcePartIds!.includes(p.id)) : score.parts;
  if (!sources.length) throw new Error("No source parts to arrange from.");
  const lengths = measureLengths(score);
  const keys = concertKeys(score);
  const count = score.measures.length;
  const report: string[] = [];

  // Highest instrument first: melody on top, bass at the bottom, harmony in between.
  const defs = targets.map((t) => getInstrument(t.instrument));
  const order = defs.map((_, i) => i).sort((a, b) => concertRange(defs[b]!, "comfortable")[1] - concertRange(defs[a]!, "comfortable")[1]);
  const melodyIndex = order[0]!;
  const bassIndex = order[order.length - 1]!;
  const innerIndexes = order.slice(1, -1);

  const top = sources[0]!;
  const bottom = sources[sources.length - 1]!;
  const singleLine = sources.length === 1 && top.staves === 1;

  // Actual length of each bar (pickups are short).
  const barLength = (m: number) => {
    if (!score.measures[m]!.implicit) return lengths[m]!;
    let longest = ZERO;
    for (const p of sources) for (const v of p.measures[m]?.voices ?? []) longest = max(longest, voiceLength(v, lengths[m]!));
    return cmp(longest, ZERO) > 0 ? longest : lengths[m]!;
  };

  // Melody and bass lines, bar by bar.
  const melody: Sounding[][] = [];
  const bass: Sounding[][] = [];
  for (let m = 0; m < count; m++) {
    melody.push(extractLine(staffNotes(score, [top], m, () => [1]), "top"));
    bass.push(singleLine ? [] : extractLine(staffNotes(score, [bottom], m, (p) => [p.staves]), "bottom"));
  }
  const melodyShifts = phraseOctaveShifts(melody.map((bar) => bar.map((n) => MIDI(n.pitch))), concertRange(defs[melodyIndex]!, "comfortable"));
  const bassShifts = phraseOctaveShifts(bass.map((bar) => bar.map((n) => MIDI(n.pitch))), concertRange(defs[bassIndex]!, "comfortable"));

  const slots: VoiceSlot[] = innerIndexes.map((i) => ({
    instrument: defs[i]!,
    comfortable: concertRange(defs[i]!, "comfortable"),
    full: concertRange(defs[i]!, "range"),
    previous: null,
  }));

  // Chords beat by beat for the arrangement: the melody counts less than the accompaniment, and a
  // chord is kept while it still explains the notes (passing notes don't change the harmony).
  const times = timeSignatures(score);
  const sourceIds = sources.map((p) => p.id);
  let previousChord: ChordGuess | null = null;
  const harmonySegments = (m: number, length: Fraction) => {
    const beat = analysisBeat(times[m]!.beats, times[m]!.beatType);
    const out: { start: Fraction; end: Fraction; chord: ChordGuess | null }[] = [];
    for (let t = ZERO; lt(t, length); t = add(t, beat)) {
      const end = min(add(t, beat), length);
      const tune = melody[m]!.filter((n) => lt(n.start, end) && gt(n.end, t)).map((n) => MIDI(n.pitch));
      const notes = soundingNotes(score, m, t, end, sourceIds).map((n) => (tune.includes(MIDI(n.pitch)) ? { ...n, weight: n.weight * 0.5 } : n));
      const chord = nameChord(notes, { prefer: previousChord });
      if (chord && chord.pitchClasses.length >= 2) previousChord = chord;
      const last = out[out.length - 1];
      if (last && last.chord?.name === chord?.name) last.end = end;
      else out.push({ start: t, end, chord });
    }
    return out;
  };

  const parts: Part[] = targets.map((t) => newPart(t.instrument, count, t.name));
  let restBars = 0;
  for (let m = 0; m < count; m++) {
    const length = barLength(m);
    const keyFifths = keys[m]!.fifths;
    const fit = (p: Pitch, def: InstrumentDef, shift: number) => {
      let q = withOctave(p, shift);
      const [lo, hi] = concertRange(def, "range");
      while (MIDI(q) > hi && MIDI(q) - 12 >= lo) q = withOctave(q, -1);
      while (MIDI(q) < lo && MIDI(q) + 12 <= hi) q = withOctave(q, 1);
      return q;
    };
    const melodyItems: Item[] = melody[m]!.map((n) => ({ start: n.start, end: n.end, pitches: [fit(n.pitch, defs[melodyIndex]!, melodyShifts[m]!)] }));
    const bassItems: Item[] = bass[m]!.map((n) => ({ start: n.start, end: n.end, pitches: [fit(n.pitch, defs[bassIndex]!, bassShifts[m]!)] }));
    const innerItems: Item[][] = innerIndexes.map(() => []);

    const allSource = staffNotes(score, sources, m, (p) => Array.from({ length: p.staves }, (_, k) => k + 1)).map((n) => n.pitch);
    if (!singleLine) {
      const segments = harmonySegments(m, length);
      let barHasChord = false;
      for (const seg of segments) {
        const start = seg.start;
        const end = seg.end;
        if (!lt(start, end)) continue;
        const chord = seg.chord;
        if (!chord || chord.pitchClasses.length < 2 || chord.fit < 0.5) continue;
        barHasChord = true;
        const at = (items: Item[]) => items.find((i) => !gt(i.start, start) && gt(i.end, start))?.pitches[0];
        const mel = at(melodyItems);
        const bas = at(bassItems);
        const chosen = voiceChord(chord, mel ? MIDI(mel) : null, bas ? MIDI(bas) : null, slots);
        chosen.forEach((pitch, k) => {
          if (pitch === null) return;
          slots[k]!.previous = pitch;
          const spelled = spellLike(pitch, allSource, keyFifths);
          const items = innerItems[k]!;
          const last = items[items.length - 1];
          // The same note again on the next beat is held, not repeated.
          if (last && cmp(last.end, start) === 0 && MIDI(last.pitches[0]!) === pitch) last.end = end;
          else items.push({ start, end, pitches: [spelled] });
        });
      }
      if (!barHasChord && melodyItems.length) restBars++;
    }

    const write = (partIndex: number, items: Item[]) => {
      parts[partIndex]!.measures[m]!.voices = [{ staff: 1, voice: 1, events: toEvents(items, length) }];
    };
    write(melodyIndex, melodyItems);
    write(bassIndex, bassItems);
    innerIndexes.forEach((p, k) => write(p, innerItems[k]!));

    // Dynamics and hairpins for everyone; words for the melody.
    const marks = new Map<string, Direction>();
    for (const source of sources) {
      for (const d of source.measures[m]?.directions ?? []) {
        const key = `${d.kind}:${d.offset.n}/${d.offset.d}:${d.kind === "wedge" ? d.type : ""}`;
        if (!marks.has(key)) marks.set(key, d);
      }
    }
    parts.forEach((part, p) => {
      const list: Direction[] = [];
      for (const d of marks.values()) {
        if (d.kind === "words" && p !== melodyIndex) continue;
        list.push({ ...d, id: newId("d"), staff: 1 });
      }
      if (list.length) part.measures[m]!.directions = list.sort((a, b) => cmp(a.offset, b.offset));
    });
  }

  if (options.breaths ?? true) for (const part of parts) addBreaths(part);

  const result: Score = {
    id: newId("s"),
    schemaVersion: SCORE_SCHEMA_VERSION,
    meta: { ...score.meta },
    measures: score.measures.map((m) => ({ ...m })),
    parts: options.keepSource ? [...parts, ...sources.map((p) => structuredClone(p))] : parts,
  };

  const name = (i: number) => targets[i]!.name;
  const shiftWords = (shifts: number[]) => {
    const used = [...new Set(shifts)];
    if (used.length === 1) {
      const k = used[0]!;
      return k === 0 ? "" : ` (moved ${k > 0 ? "up" : "down"} ${Math.abs(k) === 1 ? "an octave" : `${Math.abs(k)} octaves`})`;
    }
    return " (moved by octaves in places to suit the instrument)";
  };
  report.push(`${name(melodyIndex)} plays the melody${shiftWords(melodyShifts)}.`);
  if (singleLine) {
    report.push("The source is a single line, so there was no harmony or bass to arrange; the other parts rest. Ask the assistant to harmonise it.");
  } else {
    report.push(`${name(bassIndex)} plays the bass line${shiftWords(bassShifts)}.`);
    if (innerIndexes.length) report.push(`${innerIndexes.map(name).join(", ")} play the harmony as sustained chords.`);
    if (restBars) report.push(`In ${restBars} bar${restBars === 1 ? "" : "s"} no clear chord was found, so the inner parts rest there.`);
  }
  const issues = checkScore(result).filter((i) => i.code === "out-of-range" || i.code === "uncomfortable-range");
  const byPart = new Map<string, number>();
  for (const i of issues) byPart.set(i.partId, (byPart.get(i.partId) ?? 0) + 1);
  if (byPart.size) {
    for (const [id, n] of byPart) {
      const part = result.parts.find((p) => p.id === id);
      if (part) report.push(`${part.name}: ${n} note${n === 1 ? "" : "s"} outside the comfortable range (see Checks).`);
    }
  } else report.push("Every note is within the instruments' comfortable ranges.");
  return { score: result, report };
}

/** Breath marks at the end of every 4th bar in passages without rests. */
function addBreaths(part: Part) {
  let playing = 0;
  part.measures.forEach((pm) => {
    const events = pm.voices[0]?.events ?? [];
    const hasRest = events.some((e) => e.kind === "rest");
    playing = hasRest ? 0 : playing + 1;
    if (playing >= 4) {
      const last = [...events].reverse().find((e): e is NoteEvent => e.kind === "note");
      if (last && !last.notes.some((n) => n.tie?.start)) {
        last.articulations = [...(last.articulations ?? []).filter((a) => a !== "breath"), "breath"];
        playing = 0;
      }
    }
  });
}
