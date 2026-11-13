/**
 * MCN, Musicraft's compact notation for language models: one line per bar, absolute pitches and
 * explicit lengths, e.g.
 *
 *   bar 12: Bb4/4. C5/8 D5/2
 *   bar 13: [F4 A4 C5]/2 r/2
 *   bar 14 staff 2: R
 *   bar 15: 3:2{C5/8 D5/8 E5/8} F5/4~ F5/2(accent,mf)
 *
 * The parser is strict and its errors say exactly what to fix, so a model can correct itself.
 */
import { produce, type Draft } from "immer";
import { describeBeats } from "../checks";
import { NOTE_TYPES, TYPE_DENOMINATOR, type Duration, type NoteType } from "../duration";
import { add, cmp, gt, lt, sub, ZERO, type Fraction } from "../fraction";
import { newId } from "../ids";
import {
  ARTICULATIONS,
  concertKeys,
  DYNAMICS,
  eventOnsets,
  eventValue,
  measureLengths,
  timeSignatures,
  voiceLength,
  type Articulation,
  type Direction,
  type Dynamic,
  type MusicEvent,
  type Note,
  type NoteEvent,
  type Part,
  type PartMeasure,
  type RestEvent,
  type Score,
  type Voice,
} from "../model";
import { tupletGroups } from "../musicxml/export";
import { midiNumber as midi, negateInterval, transposePitch, UNISON, type Pitch, type Step } from "../pitch";
import { writtenContexts, type WrittenContext } from "../transpose";

export type PitchFrame = "concert" | "written";

export class McnError extends Error {}

// ---------------------------------------------------------------------------
// Parsed form
// ---------------------------------------------------------------------------

export interface McnNote {
  pitch: Pitch;
  tie: boolean;
}

export interface McnEvent {
  kind: "note" | "rest" | "spacer" | "barRest";
  notes: McnNote[];
  duration: Duration;
  grace?: "plain" | "slash";
  articulations: Articulation[];
  dynamic?: Dynamic;
  wedge?: "crescendo" | "diminuendo";
  wedgeEnd?: boolean;
  texts?: string[];
  slurStart?: boolean;
  slurEnd?: boolean;
}

export interface McnLine {
  /** Bar number as printed. */
  bar: string;
  staff: number;
  voice: number;
  events: McnEvent[];
  /** 1-based line in the input, for error messages. */
  line: number;
}

const LENGTH_CODES: Record<string, NoteType> = Object.fromEntries(
  NOTE_TYPES.map((t) => [t === "breve" ? "breve" : String(TYPE_DENOMINATOR[t]), t]),
);

const ARTICULATION_SET = new Set<string>(ARTICULATIONS);
const DYNAMIC_SET = new Set<string>(DYNAMICS);

const FLAG_HELP =
  "Marks go in brackets after the length, separated by commas: articulations (accent, marcato, staccato, " +
  "staccatissimo, tenuto, fermata, trill, mordent, turn, breath), one dynamic (pp, p, mp, mf, f, ff, sfz, fp…), " +
  'cresc, dim, hairpin-end, slur, slur-end, grace, grace-slash, text="…".';

function normalise(text: string): string {
  return text
    .replace(/[♯]/g, "#")
    .replace(/[♭]/g, "b")
    .replace(/[𝄪]/g, "x")
    .replace(/[𝄫]/g, "bb")
    .replace(/[♮]/g, "n")
    .replace(/[“”]/g, '"');
}

const PITCH_RE = /^([A-Ga-g])(##|x|bb|#|b|n)?(-?\d)$/;

function parsePitchToken(token: string, where: string): Pitch {
  const m = PITCH_RE.exec(token);
  if (!m) {
    throw new McnError(
      `${where}: "${token}" is not a pitch. Write letter, accidental and octave, e.g. C4 (middle C), F#5, Bb3.`,
    );
  }
  const acc = m[2] ?? "";
  const alter = acc === "#" ? 1 : acc === "##" || acc === "x" ? 2 : acc === "b" ? -1 : acc === "bb" ? -2 : 0;
  const octave = Number(m[3]);
  if (octave < 0 || octave > 9) throw new McnError(`${where}: octave ${octave} in "${token}" is out of range (0–9).`);
  return { step: m[1]!.toUpperCase() as Step, alter, octave };
}

function splitFlags(inner: string): string[] {
  const out: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of inner) {
    if (ch === '"') quoted = !quoted;
    if (ch === "," && !quoted) {
      out.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out.filter(Boolean);
}

function applyFlag(event: McnEvent, flag: string, where: string) {
  const lower = flag.toLowerCase();
  const text = /^(?:text\s*=\s*)?"(.*)"$/s.exec(flag);
  if (text) {
    (event.texts ??= []).push(text[1]!.trim());
    return;
  }
  if (ARTICULATION_SET.has(lower)) {
    if (!event.articulations.includes(lower as Articulation)) event.articulations.push(lower as Articulation);
    return;
  }
  if (DYNAMIC_SET.has(lower)) {
    if (event.dynamic && event.dynamic !== lower) throw new McnError(`${where}: only one dynamic per note ("${event.dynamic}" and "${lower}").`);
    event.dynamic = lower as Dynamic;
    return;
  }
  switch (lower) {
    case "cresc":
    case "cresc.":
    case "crescendo":
      event.wedge = "crescendo";
      return;
    case "dim":
    case "dim.":
    case "decresc":
    case "decrescendo":
    case "diminuendo":
      event.wedge = "diminuendo";
      return;
    case "hairpin-end":
    case "end-hairpin":
    case "/cresc":
    case "/dim":
      event.wedgeEnd = true;
      return;
    case "slur":
    case "slur-start":
      event.slurStart = true;
      return;
    case "slur-end":
    case "/slur":
      event.slurEnd = true;
      return;
    case "grace":
    case "appoggiatura":
      event.grace = "plain";
      return;
    case "grace-slash":
    case "acciaccatura":
      event.grace = "slash";
      return;
    case "tie":
      event.notes.forEach((n) => (n.tie = true));
      return;
    case "acc":
      event.articulations.push("accent");
      return;
    case "stacc":
      event.articulations.push("staccato");
      return;
    case "ten":
      event.articulations.push("tenuto");
      return;
    default:
      throw new McnError(`${where}: unknown mark "${flag}". ${FLAG_HELP}`);
  }
}

const EVENT_RE = /^(\[[^\]]*\]|[A-Ga-g](?:##|x|bb|#|b|n)?-?\d|r|s)\/(\d+|breve)(\.{0,4})/;

function parseEvents(body: string, where: string): McnEvent[] {
  const events: McnEvent[] = [];
  let rest = body.trim();
  let tuplet: { actual: number; normal: number } | null = null;
  const barRest = /^R(?:\/1)?(?:\((.*)\))?$/.exec(rest);
  if (barRest) {
    const event: McnEvent = { kind: "barRest", notes: [], duration: { type: "whole", dots: 0 }, articulations: [] };
    for (const flag of splitFlags(barRest[1] ?? "")) applyFlag(event, flag, where);
    if (event.articulations.length || event.grace || event.slurStart || event.slurEnd) {
      throw new McnError(`${where}: rests can't have articulations, slurs or grace marks.`);
    }
    return [event];
  }
  if (!rest) throw new McnError(`${where}: the bar is empty. Write its notes, or R for a whole-bar rest.`);
  while (rest.length) {
    rest = rest.trimStart();
    if (!rest.length) break;
    const open = /^(\d+):(\d+)\s*\{/.exec(rest);
    if (open) {
      if (tuplet) throw new McnError(`${where}: tuplets can't be nested.`);
      tuplet = { actual: Number(open[1]), normal: Number(open[2]) };
      if (tuplet.actual < 2 || tuplet.normal < 1) throw new McnError(`${where}: "${open[0]}" is not a valid tuplet (use e.g. 3:2{…}).`);
      rest = rest.slice(open[0].length);
      continue;
    }
    if (rest.startsWith("}")) {
      if (!tuplet) throw new McnError(`${where}: "}" without a tuplet start like 3:2{.`);
      tuplet = null;
      rest = rest.slice(1);
      continue;
    }
    if (/^R(\s|$)/.test(rest)) throw new McnError(`${where}: R (whole-bar rest) must be the only thing in its bar; use r/4, r/2… for shorter rests.`);
    const m = EVENT_RE.exec(rest);
    if (!m) {
      const token = rest.split(/\s+/)[0]!;
      const hint = token.startsWith("(")
        ? " Marks go right after a note's length, e.g. C5/8(staccato), also inside triplets."
        : /^[A-Ga-g](##|x|bb|#|b|n)?-?\d$/.test(token)
        ? ` It needs a length, e.g. ${token}/4.`
        : /^[A-Ga-g](##|x|bb|#|b|n)?\//.test(token)
          ? " The pitch needs an octave, e.g. C5/4 (C4 is middle C)."
          : " Expected a note like C#5/4, a chord like [C4 E4 G4]/2, a rest like r/4, or 3:2{…} for triplets.";
      throw new McnError(`${where}: can't read "${token}".${hint}`);
    }
    const [whole, head, code, dots] = m;
    const type = LENGTH_CODES[code!];
    if (!type) throw new McnError(`${where}: "/${code}" is not a length. Use /1 whole, /2 half, /4 quarter, /8, /16, /32, /64.`);
    const duration: Duration = { type, dots: dots!.length, ...(tuplet ? { tuplet: { ...tuplet } } : {}) };
    const event: McnEvent = { kind: "note", notes: [], duration, articulations: [] };
    if (head === "r") event.kind = "rest";
    else if (head === "s") event.kind = "spacer";
    else if (head!.startsWith("[")) {
      const tokens = head!.slice(1, -1).trim().split(/\s+/).filter(Boolean);
      if (!tokens.length) throw new McnError(`${where}: empty chord "[]".`);
      event.notes = tokens.map((t) => {
        const tie = t.endsWith("~");
        return { pitch: parsePitchToken(tie ? t.slice(0, -1) : t, where), tie };
      });
    } else {
      event.notes = [{ pitch: parsePitchToken(head!, where), tie: false }];
    }
    rest = rest.slice(whole!.length);
    // Ties and marks, in any order.
    for (;;) {
      if (rest.startsWith("~")) {
        if (event.kind !== "note") throw new McnError(`${where}: a rest can't be tied.`);
        event.notes.forEach((n) => (n.tie = true));
        rest = rest.slice(1);
        continue;
      }
      if (rest.startsWith("(")) {
        let depth = 0;
        let quoted = false;
        let end = -1;
        for (let i = 0; i < rest.length; i++) {
          const ch = rest[i];
          if (ch === '"') quoted = !quoted;
          if (quoted) continue;
          if (ch === "(") depth++;
          if (ch === ")" && --depth === 0) {
            end = i;
            break;
          }
        }
        if (end < 0) throw new McnError(`${where}: missing ")" after the marks.`);
        for (const flag of splitFlags(rest.slice(1, end))) applyFlag(event, flag, where);
        rest = rest.slice(end + 1);
        continue;
      }
      break;
    }
    if (rest.length && !/^[\s}]/.test(rest)) {
      throw new McnError(`${where}: put a space between notes (after "${whole}").`);
    }
    if (event.kind !== "note" && (event.articulations.length || event.grace || event.slurStart || event.slurEnd)) {
      throw new McnError(`${where}: rests can't have articulations, slurs or grace marks.`);
    }
    events.push(event);
  }
  if (tuplet) throw new McnError(`${where}: the tuplet is not closed with "}".`);
  return events;
}

const LINE_RE = /^\s*(?:bar|measure|m\.?)\s*([0-9A-Za-z]+)\s*(?:,?\s*staff\s*(\d+))?\s*(?:,?\s*voice\s*(\d+))?\s*:\s*(.*)$/i;

/** Parse MCN text. Blank lines and lines starting with # are ignored. */
export function parseMcn(text: string): McnLine[] {
  const lines: McnLine[] = [];
  const seen = new Set<string>();
  normalise(text)
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const line = raw.trim().replace(/^[-*]\s+/, "");
      if (!line || line.startsWith("#") || line.startsWith("//") || line.startsWith("```")) return;
      const m = LINE_RE.exec(line);
      if (!m) {
        throw new McnError(`Line ${i + 1}: expected "bar <number>: <notes>", got "${line.slice(0, 60)}".`);
      }
      const bar = m[1]!;
      const staff = m[2] ? Number(m[2]) : 1;
      const voice = m[3] ? Number(m[3]) : 1;
      const where = `bar ${bar}${m[2] ? ` staff ${staff}` : ""}${m[3] ? ` voice ${voice}` : ""}`;
      const key = `${bar}/${staff}/${voice}`;
      if (seen.has(key)) throw new McnError(`${where} appears twice.`);
      seen.add(key);
      if (voice < 1 || voice > 4) throw new McnError(`${where}: voices are numbered 1–4.`);
      lines.push({ bar, staff, voice, events: parseEvents(m[4]!, where), line: i + 1 });
    });
  if (!lines.length) throw new McnError('No bars found. Write one line per bar, like "bar 5: C5/4 D5/4 E5/2".');
  return lines;
}

// ---------------------------------------------------------------------------
// Bar labels
// ---------------------------------------------------------------------------

/** Whether the printed bar numbers can be used to address bars (unique and simple). */
export function printedNumbersAreUnique(score: Score): boolean {
  const labels = score.measures.map((m) => m.number.trim());
  return new Set(labels).size === labels.length && labels.every((l) => /^[0-9A-Za-z]+$/.test(l));
}

/** Bar labels used with the AI: the printed numbers when they are unique, otherwise positions from the start. */
export function aiBarLabels(score: Score): string[] {
  if (printedNumbersAreUnique(score)) return score.measures.map((m) => m.number.trim());
  const start = score.measures[0]?.implicit ? 0 : 1;
  return score.measures.map((_, i) => String(i + start));
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

export function formatMcnPitch(p: Pitch): string {
  const acc = p.alter === 1 ? "#" : p.alter === 2 ? "x" : p.alter === -1 ? "b" : p.alter === -2 ? "bb" : "";
  return `${p.step}${acc}${p.octave}`;
}

function lengthCode(d: Duration): string {
  return `/${d.type === "breve" ? "breve" : TYPE_DENOMINATOR[d.type]}${".".repeat(d.dots)}`;
}

export function frameContexts(score: Score, part: Part, frame: PitchFrame): WrittenContext[] {
  if (frame === "written") return writtenContexts(score, part);
  return concertKeys(score).map((key) => ({ key, interval: UNISON }));
}

interface Attach {
  dynamic?: Dynamic;
  text?: string[];
  wedge?: "crescendo" | "diminuendo";
  wedgeEnd?: boolean;
}

/** Where each staff direction of a bar attaches: the event of the staff's first voice at (or covering) its offset. */
function attachments(score: Score, part: Part, m: number, staff: number): Map<number, Attach> {
  const result = new Map<number, Attach>();
  const length = measureLengths(score)[m]!;
  const pm = part.measures[m]!;
  const voice = firstVoice(pm, staff);
  if (!voice) return result;
  const onsets = eventOnsets(voice, length);
  const ends = voice.events.map((e, i) => add(onsets[i]!, eventValue(e, length)));
  const at = (i: number) => {
    let a = result.get(i);
    if (!a) result.set(i, (a = {}));
    return a;
  };
  const covering = (offset: Fraction) => {
    let index = 0;
    voice.events.forEach((e, i) => {
      if (e.kind === "note" && e.grace) return;
      if (cmp(onsets[i]!, offset) <= 0) index = i;
    });
    return index;
  };
  for (const d of pm.directions ?? []) {
    if (d.staff !== staff) continue;
    if (d.kind === "wedge" && d.type === "stop") {
      if (cmp(d.offset, ZERO) === 0) continue; // printed on the previous bar
      const grace = (i: number) => {
        const e = voice.events[i]!;
        return e.kind === "note" && !!e.grace;
      };
      let index = ends.findIndex((e, i) => !grace(i) && cmp(e, d.offset) === 0);
      // Inside a note: the hairpin ends with that note.
      if (index < 0) index = covering(d.offset);
      at(index).wedgeEnd = true;
      continue;
    }
    const a = at(covering(d.offset));
    if (d.kind === "dynamic") a.dynamic = d.value;
    else if (d.kind === "words") (a.text ??= []).push(d.text);
    else if (d.kind === "wedge") a.wedge = d.type as "crescendo" | "diminuendo";
  }
  // A hairpin that ends at the very start of the next bar ends on this bar's last note.
  const next = part.measures[m + 1];
  if (next?.directions?.some((d) => d.staff === staff && d.kind === "wedge" && d.type === "stop" && cmp(d.offset, ZERO) === 0)) {
    at(voice.events.length - 1).wedgeEnd = true;
  }
  return result;
}

function firstVoice(pm: PartMeasure, staff: number): Voice | undefined {
  return pm.voices.filter((v) => v.staff === staff).sort((a, b) => a.voice - b.voice)[0];
}

function eventToken(event: MusicEvent, ctx: WrittenContext, attach: Attach | undefined): string {
  let token: string;
  if (event.kind === "rest") {
    token = (event.hidden ? "s" : "r") + lengthCode(event.duration);
  } else {
    const shown = event.notes.map((n) => ({ text: formatMcnPitch(transposePitch(n.pitch, ctx.interval)), tie: !!n.tie?.start }));
    const allTied = shown.every((s) => s.tie);
    if (shown.length === 1) token = shown[0]!.text + lengthCode(event.duration) + (allTied ? "~" : "");
    else {
      const inner = shown.map((s) => s.text + (s.tie && !allTied ? "~" : "")).join(" ");
      token = `[${inner}]${lengthCode(event.duration)}${allTied ? "~" : ""}`;
    }
  }
  const flags: string[] = [];
  if (event.kind === "note") {
    if (event.grace) flags.push(event.grace.slash ? "grace-slash" : "grace");
    flags.push(...(event.articulations ?? []));
    if (event.slurs?.some((s) => s.type === "start")) flags.push("slur");
    if (event.slurs?.some((s) => s.type === "stop")) flags.push("slur-end");
  }
  if (attach?.dynamic) flags.push(attach.dynamic);
  if (attach?.wedge) flags.push(attach.wedge === "crescendo" ? "cresc" : "dim");
  if (attach?.wedgeEnd) flags.push("hairpin-end");
  for (const t of attach?.text ?? []) flags.push(`text="${t.replace(/"/g, "'").replace(/\s+/g, " ").trim()}"`);
  return flags.length ? `${token}(${flags.join(",")})` : token;
}

function voiceTokens(events: MusicEvent[], ctx: WrittenContext, attach: Map<number, Attach>): string {
  if (events.length === 1 && events[0]!.kind === "rest" && events[0]!.measureRest) {
    const token = eventToken(events[0]!, ctx, attach.get(0));
    const flags = token.indexOf("(");
    return flags >= 0 ? `R${token.slice(flags)}` : "R";
  }
  const groups = tupletGroups(events);
  const starts = new Map(groups.map(([a, b]) => [a, b]));
  const parts: string[] = [];
  for (let i = 0; i < events.length; i++) {
    const end = starts.get(i);
    const ev = events[i]!;
    if (end !== undefined && ev.duration.tuplet) {
      const t = ev.duration.tuplet;
      const inner = events
        .slice(i, end + 1)
        .map((e, k) => eventToken(e, ctx, attach.get(i + k)))
        .join(" ");
      parts.push(`${t.actual}:${t.normal}{${inner}}`);
      i = end;
    } else {
      parts.push(eventToken(ev, ctx, attach.get(i)));
    }
  }
  return parts.join(" ");
}

/** MCN lines for bars from–to (measure indexes) of one part. */
export function printBars(score: Score, partIndex: number, from: number, to: number, frame: PitchFrame = "concert"): string[] {
  const part = score.parts[partIndex];
  if (!part) throw new McnError(`No part ${partIndex + 1}.`);
  const contexts = frameContexts(score, part, frame);
  const labels = aiBarLabels(score);
  const lines: string[] = [];
  for (let m = from; m <= to; m++) {
    const pm = part.measures[m];
    if (!pm) continue;
    const label = labels[m]!;
    for (let staff = 1; staff <= part.staves; staff++) {
      const voices = pm.voices.filter((v) => v.staff === staff).sort((a, b) => a.voice - b.voice);
      voices.forEach((voice, k) => {
        const attach = k === 0 ? attachments(score, part, m, staff) : new Map<number, Attach>();
        // Voices are numbered by their order on the staff (MusicXML numbers them across staves).
        const head = `bar ${label}${part.staves > 1 ? ` staff ${staff}` : ""}${k > 0 ? ` voice ${k + 1}` : ""}`;
        lines.push(`${head}: ${voiceTokens(voice.events, contexts[m]!, attach)}`);
      });
      if (!voices.length) lines.push(`bar ${label}${part.staves > 1 ? ` staff ${staff}` : ""}: R`);
    }
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Measure index of a printed bar number, or an error that lists the valid numbers. */
export function barIndex(score: Score, bar: string | number): number {
  const label = String(bar).trim().replace(/^bar\s*/i, "");
  const labels = aiBarLabels(score);
  const index = labels.indexOf(label);
  if (index >= 0) return index;
  throw new McnError(`There is no bar ${label}. Bars are numbered ${labels[0] ?? "1"}–${labels[labels.length - 1] ?? "1"}.`);
}

function toEvents(line: McnLine, ctx: WrittenContext): { events: MusicEvent[]; marks: { index: number; event: McnEvent }[] } {
  const back = negateInterval(ctx.interval);
  const events: MusicEvent[] = [];
  const marks: { index: number; event: McnEvent }[] = [];
  let slur = 0;
  line.events.forEach((e) => {
    if (e.dynamic || e.wedge || e.wedgeEnd || e.texts?.length) marks.push({ index: events.length, event: e });
    if (e.kind === "barRest") {
      events.push({ kind: "rest", id: newId("e"), duration: { type: "whole", dots: 0 }, measureRest: true });
      return;
    }
    if (e.kind === "rest" || e.kind === "spacer") {
      const rest: RestEvent = { kind: "rest", id: newId("e"), duration: e.duration };
      if (e.kind === "spacer") rest.hidden = true;
      events.push(rest);
      return;
    }
    const notes: Note[] = e.notes
      .map((n) => ({ id: newId("n"), pitch: transposePitch(n.pitch, back), ...(n.tie ? { tie: { start: true } } : {}) }))
      .sort((a, b) => midi(a.pitch) - midi(b.pitch));
    const ev: NoteEvent = { kind: "note", id: newId("e"), duration: e.duration, notes };
    if (e.grace) ev.grace = e.grace === "slash" ? { slash: true } : {};
    if (e.articulations.length) ev.articulations = [...e.articulations];
    if (e.slurStart || e.slurEnd) {
      // Numbers only for nested slurs (1 is the default).
      ev.slurs = [];
      if (e.slurEnd) {
        const number = Math.max(1, slur);
        slur = Math.max(0, slur - 1);
        ev.slurs.push(number > 1 ? { type: "stop", number } : { type: "stop" });
      }
      if (e.slurStart) {
        const number = ++slur;
        ev.slurs.push(number > 1 ? { type: "start", number } : { type: "start" });
      }
    }
    events.push(ev);
  });
  return { events, marks };
}

/**
 * Set the tie stops that follow tie starts, and clear stops that no longer follow a start, for notes
 * in bars from–to and the first note after them. Tie starts are left as written.
 */
export function repairTies(part: Draft<Part> | Part, from = 0, to = part.measures.length - 1): void {
  const streams = new Map<string, { ev: NoteEvent; m: number }[]>();
  part.measures.forEach((pm, m) => {
    if (m < from - 1 || m > to + 1) return;
    for (const v of pm.voices) {
      const key = `${v.staff}/${v.voice}`;
      let list = streams.get(key);
      if (!list) streams.set(key, (list = []));
      for (const e of v.events) if (e.kind === "note" && !e.grace) list.push({ ev: e as NoteEvent, m });
    }
  });
  for (const list of streams.values()) {
    let afterRange = false;
    list.forEach(({ ev, m }, i) => {
      if (m < from || afterRange) return;
      if (m > to) afterRange = true;
      const before = i > 0 ? list[i - 1]!.ev : undefined;
      for (const x of ev.notes) {
        const tied = before?.notes.some((n) => n.tie?.start && midi(n.pitch) === midi(x.pitch));
        if (tied) x.tie = { ...(x.tie ?? {}), stop: true };
        else if (x.tie?.stop && (before || m > from - 1)) {
          if (x.tie.start) x.tie = { start: true };
          else delete x.tie;
        }
      }
    });
  }
}

export interface WriteResult {
  score: Score;
  /** Measure indexes that were written. */
  measures: number[];
}

/** Replace bars of a part with MCN. Pitches are concert unless `frame` is "written". */
export function writeBars(score: Score, partIndex: number, text: string, frame: PitchFrame = "concert"): WriteResult {
  const part = score.parts[partIndex];
  if (!part) throw new McnError(`No part ${partIndex + 1}.`);
  const lines = parseMcn(text);
  const lengths = measureLengths(score);
  const times = timeSignatures(score);
  const contexts = frameContexts(score, part, frame);
  const prepared = lines.map((line) => {
    const where = `bar ${line.bar}${line.staff > 1 || part.staves > 1 ? ` staff ${line.staff}` : ""}${line.voice > 1 ? ` voice ${line.voice}` : ""}`;
    const m = barIndex(score, line.bar);
    if (line.staff > part.staves) {
      throw new McnError(`${where}: ${part.name} has ${part.staves === 1 ? "one staff" : `${part.staves} staves`}.`);
    }
    const { events, marks } = toEvents(line, contexts[m]!);
    const length = lengths[m]!;
    const total = events.reduce((t, e) => add(t, eventValue(e, length)), ZERO);
    // Pickup bars, bars that are already short (e.g. at phrase ends) and extra voices may be shorter
    // than the time signature; first voices of full bars must fit exactly. A bar may also keep the
    // length it already has.
    const pm = part.measures[m]!;
    const existing = pm.voices.filter((v) => v.staff === line.staff).sort((a, b) => a.voice - b.voice)[line.voice - 1];
    const existingLength = existing ? voiceLength(existing, length) : undefined;
    const first = firstVoice(pm, line.staff);
    const alreadyShort = !!first && lt(voiceLength(first, length), length);
    const mayBeShort = !!score.measures[m]!.implicit || line.voice > 1 || alreadyShort;
    const beatType = times[m]!.beatType;
    const keepsLength = existingLength !== undefined && cmp(total, existingLength) === 0 && cmp(total, ZERO) > 0;
    const fits = mayBeShort ? !gt(total, length) && cmp(total, ZERO) > 0 : cmp(total, length) === 0;
    if (!fits && !keepsLength) {
      const need = `${times[m]!.beats}/${beatType} needs ${describeBeats(length, beatType)}`;
      const diff = lt(total, length) ? sub(length, total) : sub(total, length);
      throw new McnError(
        `${where}: the notes add up to ${describeBeats(total, beatType)} but ${need} ` +
          `(${lt(total, length) ? "missing" : "too much by"} ${describeBeats(diff, beatType)}). Fix the lengths or add rests.`,
      );
    }
    return { line, m, events, marks, length };
  });

  const touched = new Set<number>();
  const next = produce(score, (draft) => {
    const dpart = draft.parts[partIndex]!;
    for (const { line, m, events, marks, length } of prepared) {
      touched.add(m);
      const pm = dpart.measures[m]!;
      // "voice N" is the N-th voice on the staff, whatever number it has internally.
      const staffVoices = pm.voices.filter((v) => v.staff === line.staff).sort((a, b) => a.voice - b.voice);
      const target = staffVoices[line.voice - 1];
      const index = target ? pm.voices.indexOf(target) : -1;
      const isBarRest = events.length === 1 && events[0]!.kind === "rest" && (events[0] as RestEvent).measureRest;
      if (line.voice > 1 && isBarRest) {
        if (index >= 0) pm.voices.splice(index, 1);
      } else if (index >= 0) {
        pm.voices[index]!.events = events as Draft<MusicEvent>[];
      } else {
        const number = staffVoices.length ? staffVoices[staffVoices.length - 1]!.voice + 1 : line.voice;
        pm.voices.push({ staff: line.staff, voice: number, events: events as Draft<MusicEvent>[] });
        pm.voices.sort((a, b) => a.staff - b.staff || a.voice - b.voice);
      }
      // Marks: the first voice's line replaces the staff's marks in this bar.
      let directions = (pm.directions ?? []) as Direction[];
      if (line.voice === 1) {
        directions = directions.filter((d) => d.staff !== line.staff || (d.kind === "wedge" && d.type === "stop" && cmp(d.offset, ZERO) === 0));
        // A hairpin ending at the start of the next bar was printed on this bar's last note.
        const following = dpart.measures[m + 1];
        if (following?.directions) {
          following.directions = following.directions.filter(
            (d) => !(d.staff === line.staff && d.kind === "wedge" && d.type === "stop" && cmp(d.offset, ZERO) === 0),
          );
          if (!following.directions.length) delete following.directions;
        }
      }
      const onsets = eventOnsets({ staff: line.staff, voice: line.voice, events }, length);
      for (const { index: i, event } of marks) {
        const offset = onsets[i]!;
        if (event.dynamic) directions.push({ id: newId("d"), kind: "dynamic", staff: line.staff, offset, value: event.dynamic });
        for (const text of event.texts ?? []) directions.push({ id: newId("d"), kind: "words", staff: line.staff, offset, text });
        if (event.wedge) directions.push({ id: newId("d"), kind: "wedge", staff: line.staff, offset, type: event.wedge });
        if (event.wedgeEnd) {
          const end = add(offset, eventValue(events[i]!, length));
          directions.push({ id: newId("d"), kind: "wedge", staff: line.staff, offset: end, type: "stop" });
        }
      }
      directions.sort((a, b) => cmp(a.offset, b.offset));
      if (directions.length) pm.directions = directions as Draft<Direction>[];
      else delete pm.directions;
    }
    if (touched.size) repairTies(dpart, Math.min(...touched), Math.max(...touched));
  });
  return { score: next, measures: [...touched].sort((a, b) => a - b) };
}

/** Bar range helper: "bars 3–5" or "bar 3". */
export function barsText(score: Score, measures: number[]): string {
  if (!measures.length) return "no bars";
  const labels = aiBarLabels(score);
  const label = (m: number) => labels[m] ?? String(m + 1);
  const ranges: string[] = [];
  let start = measures[0]!;
  let prev = start;
  for (const m of [...measures.slice(1), Number.NaN]) {
    if (m === prev + 1) {
      prev = m;
      continue;
    }
    ranges.push(start === prev ? label(start) : `${label(start)}–${label(prev)}`);
    start = prev = m;
  }
  return `${measures.length === 1 ? "bar" : "bars"} ${ranges.join(", ")}`;
}
