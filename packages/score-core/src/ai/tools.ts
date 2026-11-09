/**
 * The music tools the AI assistant calls. Each tool validates its arguments (zod), runs a
 * deterministic operation on the score and returns text for the model plus, for edits, the new score.
 * Errors are thrown with messages written so the model can correct its call.
 */
import { produce, type Draft } from "immer";
import { z } from "zod";
import { arrangeForEnsemble } from "../arrange";
import { checkScore } from "../checks";
import { EditError, expandMultiRest, insertMeasures, deleteMeasures, setBarline, setKeySignature, setRehearsal, setTempo, setTimeSignature } from "../edit";
import { add, cmp, frac, lt, type Fraction } from "../fraction";
import { analysisBeat, analyzeHarmony, describeBarHarmony } from "../harmony";
import { newId } from "../ids";
import {
  describeTransposition,
  ENSEMBLES,
  getInstrument,
  hasInstrument,
  INSTRUMENTS,
  matchInstrument,
  type InstrumentDef,
  type InstrumentFamily,
} from "../instruments";
import {
  ARTICULATIONS,
  concertKeys,
  DYNAMICS,
  eventOnsets,
  measureLengths,
  timeSignatures,
  type Articulation,
  type BarlineStyle,
  type Direction,
  type Dynamic,
  type MusicEvent,
  type NoteEvent,
  type PartMeasure,
  type Score,
  type Tempo,
  type Voice,
} from "../model";
import { addPart, removePart, renamePart, setMeta } from "../ops";
import {
  formatPitch,
  intervalToKey,
  intervalWords,
  isUnison,
  keyName,
  negateInterval,
  parseInterval,
  parseKey,
  type Interval,
} from "../pitch";
import { changeInstrument, shiftOctaves, transposeScore, writtenKeyToConcert } from "../transpose";
import { aiBarLabels, barIndex, barsText, McnError, printBars, repairTies, writeBars } from "./notation";
import { describePart, describeScore } from "./overview";

export interface ToolOutcome {
  /** What the model reads. */
  result: string;
  /** The new score, when the tool changed it. */
  score?: Score;
  /** One line for the user's change list. */
  summary?: string;
}

export interface AiTool {
  name: string;
  description: string;
  schema: z.ZodObject<z.ZodRawShape>;
  /** Tools that only read the score. */
  readOnly?: boolean;
  run(score: Score, args: never): ToolOutcome;
}

export class ToolError extends Error {}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

const barArg = z.union([z.number().int(), z.string().min(1)]);
const partArg = z.union([z.string().min(1), z.number().int()]);
const pitchArg = z.enum(["concert", "written"]).optional();

export const partHandle = (index: number) => `P${index + 1}`;

/** A part from "P2", "part 2", 2, or (part of) its name. */
export function resolvePart(score: Score, ref: string | number): number {
  const text = String(ref).trim();
  const numbered = /^(?:p|part)?\s*(\d+)$/i.exec(text);
  if (numbered) {
    const index = Number(numbered[1]) - 1;
    if (score.parts[index]) return index;
  } else {
    const lower = text.toLowerCase();
    const exact = score.parts.findIndex((p) => p.name.toLowerCase() === lower);
    if (exact >= 0) return exact;
    const partial = score.parts.map((p, i) => (p.name.toLowerCase().includes(lower) || getInstrument(p.instrument).name.toLowerCase().includes(lower) ? i : -1)).filter((i) => i >= 0);
    if (partial.length === 1) return partial[0]!;
    if (partial.length > 1) {
      throw new ToolError(`"${text}" matches several parts (${partial.map((i) => `${partHandle(i)} "${score.parts[i]!.name}"`).join(", ")}); use a handle like P1.`);
    }
  }
  throw new ToolError(`No part "${text}". The parts are ${score.parts.map((p, i) => `${partHandle(i)} "${p.name}"`).join(", ")}.`);
}

function resolveParts(score: Score, refs: (string | number)[] | undefined): number[] {
  if (!refs?.length) return score.parts.map((_, i) => i);
  return [...new Set(refs.map((r) => resolvePart(score, r)))].sort((a, b) => a - b);
}

function resolveRange(score: Score, from?: string | number, to?: string | number): { from: number; to: number } {
  const a = from === undefined ? 0 : bar(score, from);
  const b = to === undefined ? (from === undefined ? score.measures.length - 1 : a) : bar(score, to);
  if (b < a) throw new ToolError(`The range ends (bar ${aiBarLabels(score)[b]}) before it starts (bar ${aiBarLabels(score)[a]}).`);
  return { from: a, to: b };
}

function bar(score: Score, ref: string | number): number {
  try {
    return barIndex(score, ref);
  } catch (err) {
    throw new ToolError((err as Error).message);
  }
}

/** Offset of a beat (1-based, counting the time signature's lower number; 2.5 = halfway through beat 2). */
function beatOffset(score: Score, m: number, beat: number | undefined): Fraction {
  const time = timeSignatures(score)[m]!;
  const b = beat ?? 1;
  if (!(b >= 1 && b < time.beats + 1)) {
    throw new ToolError(`Beat ${b} is not in bar ${aiBarLabels(score)[m]} (${time.beats}/${time.beatType} has beats 1–${time.beats}).`);
  }
  const whole = Math.floor(b);
  const fraction = Math.round((b - whole) * 1000);
  return add(frac(whole - 1, time.beatType), frac(fraction, 1000 * time.beatType));
}

export function resolveInstrument(text: string): InstrumentDef {
  const t = text.trim();
  if (hasInstrument(t)) return getInstrument(t);
  const byName = INSTRUMENTS.find((i) => i.name.toLowerCase() === t.toLowerCase());
  if (byName) return byName;
  const matched = matchInstrument(t);
  if (matched) return matched;
  throw new ToolError(`Unknown instrument "${t}". Call list_instruments for the ids, e.g. trumpet-bb, horn-f, trombone, tuba.`);
}

const SEMITONE_INTERVALS = ["P1", "m2", "M2", "m3", "M3", "P4", "A4", "P5", "m6", "M6", "m7", "M7"];

function intervalFromSemitones(semitones: number): Interval {
  const octaves = Math.floor(Math.abs(semitones) / 12);
  const simple = parseInterval(SEMITONE_INTERVALS[Math.abs(semitones) % 12]!);
  const iv = { diatonic: simple.diatonic + 7 * octaves, chromatic: simple.chromatic + 12 * octaves };
  return semitones < 0 ? negateInterval(iv) : iv;
}

function describeInterval(iv: Interval): string {
  if (isUnison(iv)) return "not at all (unison)";
  const down = iv.chromatic < 0 || (iv.chromatic === 0 && iv.diatonic < 0);
  return `${down ? "down" : "up"} ${intervalWords(down ? negateInterval(iv) : iv)}`;
}

function partsText(score: Score, parts: number[]): string {
  if (parts.length === score.parts.length && parts.length > 1) return "all parts";
  return parts.map((i) => `${partHandle(i)} (${score.parts[i]!.name})`).join(", ");
}

function rangeText(score: Score, range: { from: number; to: number }): string {
  if (range.from === 0 && range.to === score.measures.length - 1) return "the whole piece";
  return barsText(score, Array.from({ length: range.to - range.from + 1 }, (_, k) => range.from + k));
}

/** Problems the checks find in some bars of some parts, as short notes for the model. */
function problemsIn(score: Score, parts: number[], measures: number[]): string {
  const ids = new Set(parts.map((i) => score.parts[i]!.id));
  const bars = new Set(measures);
  const labels = aiBarLabels(score);
  const found = checkScore(score).filter((i) => i.severity !== "info" && ids.has(i.partId) && bars.has(i.measureIndex));
  if (!found.length) return "";
  const lines = found.slice(0, 8).map((i) => `bar ${labels[i.measureIndex]} ${partHandle(score.parts.findIndex((p) => p.id === i.partId))}: ${i.message}`);
  return `\nCheck these: ${lines.join("; ")}${found.length > 8 ? ` (and ${found.length - 8} more)` : ""}`;
}

function onsetsOf(score: Score, m: number, voice: Voice): Fraction[] {
  return eventOnsets(voice, measureLengths(score)[m]!);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const MAX_OUTPUT = 12_000;

function tool<S extends z.ZodRawShape>(
  name: string,
  description: string,
  shape: S,
  run: (score: Score, args: z.infer<z.ZodObject<S>>) => ToolOutcome,
  readOnly = false,
): AiTool {
  return { name, description, schema: z.object(shape) as unknown as z.ZodObject<z.ZodRawShape>, run: run as AiTool["run"], readOnly };
}

const getOverview = tool("get_overview", "Overview of the score: bars, time and key signatures, tempo, parts with their instruments and ranges, and how many problems the checks found.", {}, (score) => ({
  result: describeScore(score),
}), true);

function barInfo(score: Score, m: number, first: boolean): string | null {
  const info = score.measures[m]!;
  const labels = aiBarLabels(score);
  const bits: string[] = [];
  const time = timeSignatures(score)[m]!;
  const key = concertKeys(score)[m]!;
  if (first || info.time) bits.push(`time ${time.beats}/${time.beatType}`);
  if (first || info.key) bits.push(`key ${keyName(key)} (concert)`);
  if (info.tempo) bits.push(`tempo ${info.tempo.text ? `"${info.tempo.text}" ` : ""}${info.tempo.beatUnit}${info.tempo.beatUnitDots ? " dotted" : ""} = ${info.tempo.bpm}`);
  if (info.rehearsal) bits.push(`rehearsal mark "${info.rehearsal}"`);
  if (info.repeatStart) bits.push("repeat starts");
  if (info.repeatEnd) bits.push("repeat ends here");
  if (info.ending?.start) bits.push(`ending ${info.ending.number}`);
  if (info.barline && info.barline !== "regular") bits.push(`${info.barline} barline at the end`);
  if (info.implicit) bits.push("pickup/short bar");
  return bits.length ? `# bar ${labels[m]}: ${bits.join(", ")}` : null;
}

const getBars = tool(
  "get_bars",
  "Read bars in MCN notation, one line per bar (and staff/voice). Ask only for the bars you need.",
  {
    from: barArg.describe("First bar number"),
    to: barArg.optional().describe("Last bar number (default: same as from)"),
    parts: z.array(partArg).optional().describe('Parts like ["P1"]; default all'),
    pitch: pitchArg.describe('"concert" (default) or "written" (as transposing players read it)'),
  },
  (score, args) => {
    const range = resolveRange(score, args.from, args.to);
    const parts = resolveParts(score, args.parts);
    const frame = args.pitch ?? "concert";
    const out: string[] = [];
    for (let m = range.from; m <= range.to; m++) {
      const info = barInfo(score, m, m === range.from);
      if (info) out.push(info);
    }
    let length = out.join("\n").length;
    let cut: string | null = null;
    for (const p of parts) {
      const part = score.parts[p]!;
      const instrument = getInstrument(part.instrument);
      const header = `# ${partHandle(p)} "${part.name}" — ${frame === "written" && !isUnison(instrument.transposition) ? `written pitch (${describeTransposition(instrument)})` : "concert pitch"}`;
      out.push(header);
      for (let m = range.from; m <= range.to && !cut; m++) {
        const lines = printBars(score, p, m, m, frame);
        const size = lines.join("\n").length + 1;
        if (length + size > MAX_OUTPUT) {
          cut = `# Output stopped before bar ${aiBarLabels(score)[m]} of ${partHandle(p)} (too long). Ask for fewer bars or parts.`;
          break;
        }
        out.push(...lines);
        length += size;
      }
      if (cut) break;
    }
    if (cut) out.push(cut);
    return { result: out.join("\n") };
  },
  true,
);

const getIssues = tool("get_issues", "List the problems the checks find: bars that don't add up to the time signature, notes out of an instrument's range, odd clefs, broken ties.", {}, (score) => {
  const labels = aiBarLabels(score);
  const issues = checkScore(score).filter((i) => i.severity !== "info");
  if (!issues.length) return { result: "No problems found." };
  const lines = issues.slice(0, 60).map((i) => {
    const p = score.parts.findIndex((x) => x.id === i.partId);
    return `bar ${labels[i.measureIndex]} ${partHandle(p)}${i.staff && score.parts[p]!.staves > 1 ? ` staff ${i.staff}` : ""} [${i.severity}]: ${i.message}`;
  });
  if (issues.length > 60) lines.push(`… and ${issues.length - 60} more.`);
  return { result: lines.join("\n") };
}, true);

const analyzeHarmonyTool = tool(
  "analyze_harmony",
  "Name the chords beat by beat (concert pitch, all parts together unless parts are given), e.g. 'bar 5: C (1–2) | G7/B (3–4)'.",
  {
    from: barArg.describe("First bar"),
    to: barArg.optional().describe("Last bar (default: same as from; at most 64 bars)"),
    parts: z.array(partArg).optional().describe("Only these parts"),
  },
  (score, args) => {
    const range = resolveRange(score, args.from, args.to);
    if (range.to - range.from >= 64) range.to = range.from + 63;
    const partIds = args.parts?.length ? resolveParts(score, args.parts).map((i) => score.parts[i]!.id) : undefined;
    const segments = analyzeHarmony(score, range.from, range.to, partIds);
    const labels = aiBarLabels(score);
    const times = timeSignatures(score);
    const lengths = measureLengths(score);
    const lines: string[] = [];
    for (let m = range.from; m <= range.to; m++) {
      const beat = analysisBeat(times[m]!.beats, times[m]!.beatType);
      const beats = Math.round((lengths[m]!.n / lengths[m]!.d) / (beat.n / beat.d));
      lines.push(`bar ${labels[m]}: ${describeBarHarmony(segments.filter((s) => s.measureIndex === m), beats)}`);
    }
    return { result: lines.join("\n") };
  },
  true,
);

const listInstruments = tool(
  "list_instruments",
  "Instruments you can use, with ids, transposition and ranges.",
  { family: z.enum(["brass", "woodwind", "strings", "keyboard", "voice", "other"]).optional() },
  (_score, args) => ({
    result: INSTRUMENTS.filter((i) => !args.family || i.family === (args.family as InstrumentFamily))
      .map((i) => `${i.id}: ${i.name} (${i.family}; ${describeTransposition(i)}; range ${formatPitch(i.range.low)}–${formatPitch(i.range.high)}, comfortable ${formatPitch(i.comfortable.low)}–${formatPitch(i.comfortable.high)}${isUnison(i.transposition) ? "" : ", written"})`)
      .join("\n"),
  }),
  true,
);

const transpose = tool(
  "transpose",
  "Transpose the sounding pitch: by an interval, by semitones, or to a key. When the whole score moves, key signatures move with it. Use change_instrument instead to rewrite a part for another instrument.",
  {
    interval: z.string().optional().describe("Interval like M2, m3, P4, P5, P8"),
    semitones: z.number().int().min(-36).max(36).optional().describe("Alternative to interval"),
    direction: z.enum(["up", "down"]).optional().describe("For interval (default up)"),
    to_key: z.string().optional().describe('Target concert key, e.g. "Eb major"; direction picks up/down, default nearest'),
    parts: z.array(partArg).optional().describe("Default all parts"),
    from: barArg.optional(),
    to: barArg.optional(),
  },
  (score, args) => {
    const range = resolveRange(score, args.from, args.to);
    const parts = resolveParts(score, args.parts);
    let iv: Interval;
    try {
      if (args.to_key) iv = intervalToKey(concertKeys(score)[range.from]!, parseKey(args.to_key), args.direction ?? "nearest");
      else if (args.interval) {
        const parsed = parseInterval(args.interval.replace(/^[+-]/, ""));
        const down = args.direction === "down" || args.interval.trim().startsWith("-");
        iv = down ? negateInterval(parsed) : parsed;
      } else if (args.semitones !== undefined) iv = intervalFromSemitones(args.direction === "down" ? -Math.abs(args.semitones) : args.semitones);
      else throw new ToolError("Give interval (e.g. M2), semitones, or to_key.");
    } catch (err) {
      throw new ToolError((err as Error).message);
    }
    const whole = range.from === 0 && range.to === score.measures.length - 1 && parts.length === score.parts.length;
    const next = transposeScore(score, iv, { partIds: parts.map((i) => score.parts[i]!.id), from: range.from, to: range.to });
    const what = `${partsText(score, parts)}, ${rangeText(score, range)}, ${describeInterval(iv)}`;
    const key = whole ? ` Key now ${keyName(concertKeys(next)[0]!)} (concert).` : "";
    return {
      score: next,
      result: `Transposed ${what}.${key}${problemsIn(next, parts, Array.from({ length: range.to - range.from + 1 }, (_, k) => range.from + k))}`,
      summary: `Transposed ${what}`,
    };
  },
);

const changeInstrumentTool = tool(
  "change_instrument",
  "Give a part a different instrument. keep \"sound\" (default) rewrites the written notes so the music sounds the same (e.g. Bb trumpet part → C trumpet part, trumpet → clarinet). keep \"written\" keeps the notes on the page and changes the sound.",
  {
    part: partArg,
    instrument: z.string().describe("Instrument id from list_instruments, e.g. trumpet-c, clarinet-bb, horn-f"),
    keep: z.enum(["sound", "written"]).optional(),
    name: z.string().optional().describe("New part name (default: the instrument's name)"),
  },
  (score, args) => {
    const p = resolvePart(score, args.part);
    const instrument = resolveInstrument(args.instrument);
    const old = getInstrument(score.parts[p]!.instrument);
    const next = changeInstrument(score, score.parts[p]!.id, instrument.id, {
      mode: args.keep === "written" ? "keep-written" : "keep-sounding",
      name: args.name,
    });
    const all = Array.from({ length: next.measures.length }, (_, k) => k);
    const summary = `${partHandle(p)} is now ${instrument.name} (was ${old.name}${args.keep === "written" ? ", written notes kept" : ", same sound"})`;
    return { score: next, result: `${summary}. ${describePart(next, p)}${problemsIn(next, [p], all)}`, summary };
  },
);

const addPartTool = tool(
  "add_part",
  "Add an empty part (bar rests) for an instrument.",
  {
    instrument: z.string().describe("Instrument id, e.g. trombone"),
    name: z.string().optional(),
    position: z.number().int().min(1).optional().describe("1 = first; default last"),
  },
  (score, args) => {
    const instrument = resolveInstrument(args.instrument);
    const index = args.position ? Math.min(args.position - 1, score.parts.length) : score.parts.length;
    const next = addPart(score, instrument.id, { name: args.name, index });
    const summary = `Added ${partHandle(index)} "${next.parts[index]!.name}"`;
    return { score: next, result: `${summary}. Part handles after it moved up by one.`, summary };
  },
);

const removePartTool = tool("remove_part", "Delete a part.", { part: partArg }, (score, args) => {
  const p = resolvePart(score, args.part);
  const name = score.parts[p]!.name;
  let next: Score;
  try {
    next = removePart(score, score.parts[p]!.id);
  } catch (err) {
    throw new ToolError((err as Error).message);
  }
  return { score: next, result: `Removed ${partHandle(p)} "${name}". Later part handles moved down by one.`, summary: `Removed part "${name}"` };
});

const renamePartTool = tool("rename_part", "Rename a part.", { part: partArg, name: z.string().min(1) }, (score, args) => {
  const p = resolvePart(score, args.part);
  const next = renamePart(score, score.parts[p]!.id, args.name);
  return { score: next, result: `${partHandle(p)} is now called "${args.name}".`, summary: `Renamed ${partHandle(p)} to "${args.name}"` };
});

const setInfo = tool(
  "set_info",
  "Set the title, subtitle, composer or arranger.",
  { title: z.string().optional(), subtitle: z.string().optional(), composer: z.string().optional(), arranger: z.string().optional() },
  (score, args) => {
    const meta = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined)) as Record<string, string>;
    if (!Object.keys(meta).length) throw new ToolError("Nothing to set.");
    return { score: setMeta(score, meta), result: "Done.", summary: `Set ${Object.keys(meta).join(", ")}` };
  },
);

const writeBarsTool = tool(
  "write_bars",
  "Replace whole bars of one part with MCN lines (one line per bar; staff/voice lines for piano). Each bar must add up to its time signature. Prefer transpose, change_instrument, shift_octave or copy_bars when they can do the job.",
  {
    part: partArg,
    music: z.string().describe('MCN lines, e.g. "bar 5: C5/4 D5/4 E5/2\\nbar 6: R"'),
    pitch: pitchArg.describe('"concert" (default) or "written"'),
  },
  (score, args) => {
    const p = resolvePart(score, args.part);
    let written;
    try {
      written = writeBars(score, p, args.music, args.pitch ?? "concert");
    } catch (err) {
      if (err instanceof McnError) throw new ToolError(`${err.message} Nothing was written; send all the bars again.`);
      throw err;
    }
    const what = `${barsText(score, written.measures)} of ${partHandle(p)}`;
    return { score: written.score, result: `Wrote ${what}.${problemsIn(written.score, [p], written.measures)}`, summary: `Rewrote ${what}` };
  },
);

/** Events of a staff for copying: all voices, or one line of top/bottom notes. */
function copiedVoices(pm: PartMeasure, staff: number, notes: "all" | "top" | "bottom"): Voice[] {
  const voices = pm.voices.filter((v) => v.staff === staff).sort((a, b) => a.voice - b.voice);
  const chosen = notes === "all" ? voices : voices.slice(0, 1);
  return chosen.map((v, k) => ({
    staff,
    voice: k + 1,
    events: v.events.map((e): MusicEvent => {
      if (e.kind === "rest") return { ...e, id: newId("e") };
      const picked = notes === "top" ? [e.notes[e.notes.length - 1]!] : notes === "bottom" ? [e.notes[0]!] : e.notes;
      return { ...e, id: newId("e"), notes: picked.map((n) => ({ ...n, id: newId("n"), pitch: { ...n.pitch } })) };
    }),
  }));
}

const copyBars = tool(
  "copy_bars",
  "Copy bars (sounding pitch) from one part/staff to another part/staff or to other bars, replacing what is there. Use notes \"top\" or \"bottom\" to take one line (e.g. the melody) out of chords. The target instrument's written notes are worked out automatically.",
  {
    from_part: partArg,
    from: barArg.describe("First bar to copy"),
    to: barArg.optional().describe("Last bar to copy (default: same as from)"),
    to_part: partArg.optional().describe("Default: the same part"),
    at: barArg.optional().describe("First target bar (default: the same bars)"),
    from_staff: z.number().int().min(1).optional(),
    to_staff: z.number().int().min(1).optional(),
    notes: z.enum(["all", "top", "bottom"]).optional(),
    octaves: z.number().int().min(-3).max(3).optional().describe("Shift by octaves while copying"),
  },
  (score, args) => {
    const source = resolvePart(score, args.from_part);
    const target = args.to_part === undefined ? source : resolvePart(score, args.to_part);
    const range = resolveRange(score, args.from, args.to);
    const at = args.at === undefined ? range.from : bar(score, args.at);
    const fromStaff = args.from_staff ?? 1;
    const toStaff = args.to_staff ?? 1;
    const notes = args.notes ?? "all";
    const octaves = args.octaves ?? 0;
    if (fromStaff > score.parts[source]!.staves) throw new ToolError(`${partHandle(source)} has no staff ${fromStaff}.`);
    if (toStaff > score.parts[target]!.staves) throw new ToolError(`${partHandle(target)} has no staff ${toStaff}.`);
    const count = range.to - range.from + 1;
    if (at + count > score.measures.length) {
      throw new ToolError(`Not enough bars after bar ${aiBarLabels(score)[at]}: the copy needs ${count} bars. Insert bars first.`);
    }
    if (target === source && at === range.from && fromStaff === toStaff && notes === "all" && octaves === 0) {
      throw new ToolError("That would copy the bars onto themselves.");
    }
    const lengths = measureLengths(score);
    for (let k = 0; k < count; k++) {
      if (cmp(lengths[range.from + k]!, lengths[at + k]!) !== 0) {
        throw new ToolError(`Bar ${aiBarLabels(score)[range.from + k]} and bar ${aiBarLabels(score)[at + k]} have different time signatures.`);
      }
    }
    const next = produce(score, (draft) => {
      const dst = draft.parts[target]!;
      for (let k = 0; k < count; k++) {
        const src = score.parts[source]!.measures[range.from + k]!;
        const voices = copiedVoices(src, fromStaff, notes).map((v) => ({
          ...v,
          staff: toStaff,
          events: v.events.map((e) =>
            e.kind === "note" && octaves
              ? { ...e, notes: e.notes.map((n) => ({ ...n, pitch: { ...n.pitch, octave: n.pitch.octave + octaves } })) }
              : e,
          ),
        }));
        const pm = dst.measures[at + k]!;
        const others = pm.voices.filter((v) => v.staff !== toStaff);
        const copied = voices.length ? voices : [{ staff: toStaff, voice: 1, events: [{ kind: "rest", id: newId("e"), duration: { type: "whole", dots: 0 }, measureRest: true } as MusicEvent] }];
        pm.voices = [...others, ...copied].sort((a, b) => a.staff - b.staff || a.voice - b.voice) as Draft<Voice>[];
        const kept = (pm.directions ?? []).filter((d) => d.staff !== toStaff);
        const brought = (src.directions ?? []).filter((d) => d.staff === fromStaff).map((d) => ({ ...d, id: newId("d"), staff: toStaff }));
        const directions = [...kept, ...brought].sort((a, b) => cmp(a.offset, b.offset));
        if (directions.length) pm.directions = directions as Draft<Direction>[];
        else delete pm.directions;
      }
      repairTies(dst, at, at + count - 1);
    });
    const targetBars = Array.from({ length: count }, (_, k) => at + k);
    const what = `${barsText(score, Array.from({ length: count }, (_, k) => range.from + k))} of ${partHandle(source)}${score.parts[source]!.staves > 1 ? ` staff ${fromStaff}` : ""}${notes !== "all" ? ` (${notes} notes)` : ""} to ${barsText(score, targetBars)} of ${partHandle(target)}${score.parts[target]!.staves > 1 ? ` staff ${toStaff}` : ""}${octaves ? `, ${octaves > 0 ? "up" : "down"} ${Math.abs(octaves)} octave${Math.abs(octaves) > 1 ? "s" : ""}` : ""}`;
    return { score: next, result: `Copied ${what}.${problemsIn(next, [target], targetBars)}`, summary: `Copied ${what}` };
  },
);

const shiftOctave = tool(
  "shift_octave",
  "Move notes up or down by octaves.",
  {
    octaves: z.number().int().min(-3).max(3).describe("e.g. -1 = an octave lower"),
    parts: z.array(partArg).optional(),
    from: barArg.optional(),
    to: barArg.optional(),
    staff: z.number().int().min(1).optional().describe("Only this staff (piano: 1 upper, 2 lower)"),
  },
  (score, args) => {
    if (args.octaves === 0) throw new ToolError("octaves must not be 0.");
    const range = resolveRange(score, args.from, args.to);
    const parts = resolveParts(score, args.parts);
    const next = shiftOctaves(score, args.octaves, { partIds: parts.map((i) => score.parts[i]!.id), from: range.from, to: range.to, staff: args.staff });
    const what = `${partsText(score, parts)}${args.staff ? ` staff ${args.staff}` : ""}, ${rangeText(score, range)}, ${args.octaves > 0 ? "up" : "down"} ${Math.abs(args.octaves)} octave${Math.abs(args.octaves) > 1 ? "s" : ""}`;
    const bars = Array.from({ length: range.to - range.from + 1 }, (_, k) => range.from + k);
    return { score: next, result: `Moved ${what}.${problemsIn(next, parts, bars)}`, summary: `Moved ${what}` };
  },
);

const TEMPO_UNITS: Record<string, { unit: Tempo["beatUnit"]; dots: number }> = {
  quarter: { unit: "quarter", dots: 0 },
  "dotted quarter": { unit: "quarter", dots: 1 },
  half: { unit: "half", dots: 0 },
  "dotted half": { unit: "half", dots: 1 },
  eighth: { unit: "eighth", dots: 0 },
  whole: { unit: "whole", dots: 0 },
};

const setBarProperties = tool(
  "set_bar_properties",
  "Change bar-level settings from a bar on: time signature, key signature (concert pitch unless key_for_part is given), tempo, rehearsal mark, barline and repeats. Notes are not moved: use transpose to change the music's key.",
  {
    bar: barArg,
    time: z.string().optional().describe('e.g. "3/4", "6/8", "C" (common), "cut"'),
    key: z.string().optional().describe('e.g. "Eb major", "C minor"'),
    key_for_part: partArg.optional().describe("The key is written for this (transposing) part"),
    tempo_bpm: z.number().min(10).max(400).optional(),
    tempo_unit: z.enum(["quarter", "dotted quarter", "half", "dotted half", "eighth", "whole"]).optional(),
    tempo_text: z.string().optional().describe('e.g. "Allegro"'),
    rehearsal: z.string().optional().describe('e.g. "A"'),
    barline: z.enum(["regular", "double", "final", "dashed", "heavy"]).optional().describe("Barline at the end of the bar"),
    repeat_start: z.boolean().optional(),
    repeat_end: z.boolean().optional(),
    repeat_times: z.number().int().min(2).max(8).optional(),
    remove: z.array(z.enum(["time", "key", "tempo", "rehearsal"])).optional().describe("Remove these changes at this bar"),
  },
  (score, args) => {
    const m = bar(score, args.bar);
    let next = score;
    const done: string[] = [];
    try {
      for (const what of args.remove ?? []) {
        if (what === "time") next = setTimeSignature(next, m, null);
        if (what === "key") next = setKeySignature(next, m, null);
        if (what === "tempo") next = setTempo(next, m, null);
        if (what === "rehearsal") next = setRehearsal(next, m, null);
        done.push(`removed ${what}`);
      }
      if (args.time) {
        const t = args.time.trim().toLowerCase();
        const time = t === "c" || t === "common" ? { beats: 4, beatType: 4, symbol: "common" as const } : t === "cut" || t === "c|" ? { beats: 2, beatType: 2, symbol: "cut" as const } : (() => {
          const match = /^(\d+)\s*\/\s*(\d+)$/.exec(t);
          if (!match || ![1, 2, 4, 8, 16, 32].includes(Number(match[2]))) throw new ToolError(`"${args.time}" is not a time signature (use e.g. 3/4).`);
          return { beats: Number(match[1]), beatType: Number(match[2]) };
        })();
        next = setTimeSignature(next, m, time);
        done.push(`time ${time.beats}/${time.beatType}`);
      }
      if (args.key) {
        let key = parseKey(args.key);
        if (args.key_for_part !== undefined) {
          const p = resolvePart(next, args.key_for_part);
          key = writtenKeyToConcert(key, getInstrument(next.parts[p]!.instrument)).key;
        }
        next = setKeySignature(next, m, key);
        done.push(`key ${keyName(key)} (concert)`);
      }
      if (args.tempo_bpm !== undefined || args.tempo_text) {
        const unit = TEMPO_UNITS[args.tempo_unit ?? "quarter"]!;
        const existing = next.measures[m]!.tempo;
        const tempo: Tempo = {
          bpm: args.tempo_bpm ?? existing?.bpm ?? 100,
          beatUnit: unit.unit,
          ...(unit.dots ? { beatUnitDots: unit.dots } : {}),
          ...(args.tempo_text ? { text: args.tempo_text } : existing?.text ? { text: existing.text } : {}),
        };
        next = setTempo(next, m, tempo);
        done.push(`tempo ${tempo.bpm}`);
      }
      if (args.rehearsal) {
        next = setRehearsal(next, m, args.rehearsal);
        done.push(`rehearsal mark ${args.rehearsal}`);
      }
      if (args.barline || args.repeat_start !== undefined || args.repeat_end !== undefined) {
        next = setBarline(next, m, {
          ...(args.barline ? { barline: args.barline as BarlineStyle } : {}),
          ...(args.repeat_start !== undefined ? { repeatStart: args.repeat_start } : {}),
          ...(args.repeat_end !== undefined ? { repeatEnd: args.repeat_end ? (args.repeat_times && args.repeat_times !== 2 ? { times: args.repeat_times } : {}) : undefined } : {}),
        });
        done.push("barline/repeats");
      }
    } catch (err) {
      if (err instanceof ToolError) throw err;
      throw new ToolError((err as Error).message);
    }
    if (!done.length) throw new ToolError("Nothing to change: give time, key, tempo_bpm, rehearsal, barline, repeat_start/repeat_end or remove.");
    const label = aiBarLabels(score)[m];
    const warn = args.time ? problemsIn(next, next.parts.map((_, i) => i), next.measures.map((_, i) => i).filter((i) => i >= m)) : "";
    return { score: next, result: `Bar ${label}: ${done.join(", ")}.${warn}`, summary: `Bar ${label}: ${done.join(", ")}` };
  },
);

/** Replace or add a direction at an offset of a staff. */
function putDirection(score: Score, p: number, m: number, direction: Direction, replace: (d: Direction) => boolean): Score {
  return produce(score, (draft) => {
    const pm = draft.parts[p]!.measures[m]!;
    const list = ((pm.directions ?? []) as Direction[]).filter((d) => !(d.staff === direction.staff && cmp(d.offset, direction.offset) === 0 && replace(d)));
    list.push(direction);
    list.sort((a, b) => cmp(a.offset, b.offset));
    pm.directions = list as Draft<Direction>[];
  });
}

const addDynamics = tool(
  "add_dynamics",
  'Put dynamics (pp p mp mf f ff sfz fp …) at bars and beats of a part; "none" removes one.',
  {
    part: partArg,
    marks: z.array(z.object({ bar: barArg, beat: z.number().optional().describe("1 = downbeat (default)"), dynamic: z.string() })).min(1),
    staff: z.number().int().min(1).optional(),
  },
  (score, args) => {
    const p = resolvePart(score, args.part);
    const staff = args.staff ?? 1;
    let next = score;
    const labels = aiBarLabels(score);
    const done: string[] = [];
    for (const mark of args.marks) {
      const m = bar(score, mark.bar);
      const offset = beatOffset(score, m, mark.beat);
      const value = mark.dynamic.trim().toLowerCase();
      if (value === "none" || value === "") {
        next = produce(next, (draft) => {
          const pm = draft.parts[p]!.measures[m]!;
          pm.directions = (pm.directions ?? []).filter((d) => !(d.kind === "dynamic" && d.staff === staff && cmp(d.offset, offset) === 0));
          if (!pm.directions.length) delete pm.directions;
        });
        done.push(`removed at bar ${labels[m]}`);
        continue;
      }
      if (!(DYNAMICS as readonly string[]).includes(value)) throw new ToolError(`"${mark.dynamic}" is not a dynamic. Use one of: ${DYNAMICS.join(" ")}.`);
      next = putDirection(next, p, m, { id: newId("d"), kind: "dynamic", staff, offset, value: value as Dynamic }, (d) => d.kind === "dynamic");
      done.push(`${value} at bar ${labels[m]}${mark.beat && mark.beat !== 1 ? ` beat ${mark.beat}` : ""}`);
    }
    return { score: next, result: `${partHandle(p)}: ${done.join(", ")}.`, summary: `Dynamics in ${partHandle(p)}: ${done.join(", ")}` };
  },
);

const addHairpin = tool(
  "add_hairpin",
  "Add a crescendo or diminuendo hairpin to a part, from a bar/beat to a bar/beat (default: to the end of to_bar).",
  {
    part: partArg,
    type: z.enum(["crescendo", "diminuendo"]),
    from_bar: barArg,
    from_beat: z.number().optional(),
    to_bar: barArg,
    to_beat: z.number().optional().describe("Ends at the start of this beat"),
    staff: z.number().int().min(1).optional(),
  },
  (score, args) => {
    const p = resolvePart(score, args.part);
    const staff = args.staff ?? 1;
    const a = bar(score, args.from_bar);
    const b = bar(score, args.to_bar);
    const start = beatOffset(score, a, args.from_beat);
    const end = args.to_beat === undefined ? measureLengths(score)[b]! : beatOffset(score, b, args.to_beat);
    if (b < a || (a === b && !lt(start, end))) throw new ToolError("The hairpin must end after it starts.");
    let next = putDirection(score, p, a, { id: newId("d"), kind: "wedge", staff, offset: start, type: args.type }, (d) => d.kind === "wedge" && d.type !== "stop");
    next = putDirection(next, p, b, { id: newId("d"), kind: "wedge", staff, offset: end, type: "stop" }, (d) => d.kind === "wedge" && d.type === "stop");
    const labels = aiBarLabels(score);
    const what = `${args.type} in ${partHandle(p)} from bar ${labels[a]} to bar ${labels[b]}`;
    return { score: next, result: `Added a ${what}.`, summary: `Added a ${what}` };
  },
);

const addText = tool(
  "add_text",
  'Put text above a part at a bar/beat (e.g. "solo", "dolce", "mute", "a2"); an empty text removes text there.',
  { part: partArg, bar: barArg, beat: z.number().optional(), text: z.string(), staff: z.number().int().min(1).optional() },
  (score, args) => {
    const p = resolvePart(score, args.part);
    const m = bar(score, args.bar);
    const staff = args.staff ?? 1;
    const offset = beatOffset(score, m, args.beat);
    const text = args.text.trim();
    const next = text
      ? putDirection(score, p, m, { id: newId("d"), kind: "words", staff, offset, text }, (d) => d.kind === "words")
      : produce(score, (draft) => {
          const pm = draft.parts[p]!.measures[m]!;
          pm.directions = (pm.directions ?? []).filter((d) => !(d.kind === "words" && d.staff === staff && cmp(d.offset, offset) === 0));
          if (!pm.directions.length) delete pm.directions;
        });
    const where = `${partHandle(p)} bar ${aiBarLabels(score)[m]}`;
    return { score: next, result: text ? `Added "${text}" to ${where}.` : `Removed text at ${where}.`, summary: text ? `Text "${text}" in ${where}` : `Removed text in ${where}` };
  },
);

const setArticulation = tool(
  "set_articulation",
  "Add (or remove) an articulation on the notes of some bars, optionally only on notes starting on given beats.",
  {
    articulation: z.enum(ARTICULATIONS as unknown as [Articulation, ...Articulation[]]),
    from: barArg,
    to: barArg.optional(),
    parts: z.array(partArg).optional(),
    beats: z.array(z.number()).optional().describe("Only notes starting on these beats, e.g. [1, 3]"),
    remove: z.boolean().optional(),
    staff: z.number().int().min(1).optional(),
  },
  (score, args) => {
    const range = resolveRange(score, args.from, args.to);
    const parts = resolveParts(score, args.parts);
    let count = 0;
    const next = produce(score, (draft) => {
      for (const p of parts) {
        for (let m = range.from; m <= range.to; m++) {
          const beats = args.beats?.map((b) => beatOffset(score, m, b));
          const pm = draft.parts[p]!.measures[m]!;
          for (const voice of pm.voices) {
            if (args.staff && voice.staff !== args.staff) continue;
            const onsets = onsetsOf(score, m, voice as Voice);
            voice.events.forEach((e, i) => {
              if (e.kind !== "note" || e.grace) return;
              if (beats && !beats.some((b) => cmp(b, onsets[i]!) === 0)) return;
              const ev = e as Draft<NoteEvent>;
              const list = (ev.articulations ?? []).filter((a) => a !== args.articulation);
              if (!args.remove) list.push(args.articulation);
              if (list.length) ev.articulations = list;
              else delete ev.articulations;
              count++;
            });
          }
        }
      }
    });
    if (!count) throw new ToolError("No notes matched (check the bars, parts and beats).");
    const what = `${args.articulation} ${args.remove ? "removed from" : "on"} ${count} note${count === 1 ? "" : "s"} in ${partsText(score, parts)}, ${rangeText(score, range)}`;
    return { score: next, result: `${what[0]!.toUpperCase()}${what.slice(1)}.`, summary: what[0]!.toUpperCase() + what.slice(1) };
  },
);

const insertBars = tool(
  "insert_bars",
  "Insert empty bars before or after a bar (default: at the end).",
  { before: barArg.optional(), after: barArg.optional(), count: z.number().int().min(1).max(64).optional() },
  (score, args) => {
    const count = args.count ?? 1;
    const at = args.before !== undefined ? bar(score, args.before) : args.after !== undefined ? bar(score, args.after) + 1 : score.measures.length;
    const next = insertMeasures(score, at, count);
    const labels = aiBarLabels(next);
    const what = `${count} empty bar${count > 1 ? "s" : ""} (now bar${count > 1 ? `s ${labels[at]}–${labels[at + count - 1]}` : ` ${labels[at]}`})`;
    return { score: next, result: `Inserted ${what}. Later bars were renumbered.`, summary: `Inserted ${what}` };
  },
);

const deleteBars = tool("delete_bars", "Delete bars from all parts.", { from: barArg, to: barArg.optional() }, (score, args) => {
  const range = resolveRange(score, args.from, args.to);
  let next: Score;
  try {
    next = deleteMeasures(score, range.from, range.to);
  } catch (err) {
    throw new ToolError(err instanceof EditError ? err.message : (err as Error).message);
  }
  const what = rangeText(score, range);
  return { score: next, result: `Deleted ${what}. Later bars were renumbered.`, summary: `Deleted ${what}` };
});

const arrange = tool(
  "arrange",
  "Write a first-draft arrangement for an ensemble from the current parts (e.g. piano → brass quintet): the top line becomes the melody, the lowest line the bass, the other instruments play the harmony as chords. The ensemble's parts replace the old ones unless keep_source is true. Then refine it with the other tools.",
  {
    ensemble: z.enum(ENSEMBLES.map((e) => e.id) as [string, ...string[]]).optional().describe(ENSEMBLES.map((e) => `${e.id}: ${e.description}`).join("; ")),
    instruments: z.array(z.string()).optional().describe('Instead of an ensemble: instrument ids from high to low, e.g. ["flute", "clarinet-bb", "bassoon"]'),
    source_parts: z.array(partArg).optional().describe("Parts to arrange from (default all)"),
    keep_source: z.boolean().optional().describe("Keep the original parts below the new ones"),
  },
  (score, args) => {
    const sources = args.source_parts?.length ? resolveParts(score, args.source_parts).map((i) => score.parts[i]!.id) : undefined;
    const instruments = args.instruments?.map((name) => ({ instrument: resolveInstrument(name).id }));
    let result;
    try {
      result = arrangeForEnsemble(score, { ensemble: args.ensemble, instruments, sourcePartIds: sources, keepSource: args.keep_source });
    } catch (err) {
      throw new ToolError((err as Error).message);
    }
    const parts = result.score.parts.map((p, i) => `${partHandle(i)} "${p.name}"`).join(", ");
    const label = args.ensemble ? ENSEMBLES.find((e) => e.id === args.ensemble)?.name ?? args.ensemble : instruments ? `${instruments.length} instruments` : "brass quintet";
    return {
      score: result.score,
      result: `Arranged for ${label}. Parts now: ${parts}.\n${result.report.join("\n")}`,
      summary: `Arranged for ${label}`,
    };
  },
);

const multiBarRest = tool(
  "multi_bar_rest",
  "Make a whole-bar rest last several bars. Recognition reads a multi-bar rest (one bar printed with a number above it, e.g. 7) as a single bar; this adds the missing empty bars after it. Later bars are renumbered.",
  {
    bar: barArg.describe("The bar with the rest"),
    bars: z.number().int().min(2).max(500).describe("How many bars the rest lasts (the printed number)"),
  },
  (score, args) => {
    const m = bar(score, args.bar);
    let next: Score;
    try {
      next = expandMultiRest(score, m, args.bars);
    } catch (err) {
      throw new ToolError((err as Error).message);
    }
    const before = aiBarLabels(score)[m];
    const after = aiBarLabels(next);
    const what = `bar ${before} is now a ${args.bars}-bar rest (bars ${after[m]}–${after[m + args.bars - 1]})`;
    return { score: next, result: `Done: ${what}. Later bars were renumbered.`, summary: what[0]!.toUpperCase() + what.slice(1) };
  },
);

/** The score tools, in the order they are offered to the model. */
export const SCORE_TOOLS: AiTool[] = [
  getOverview,
  getBars,
  getIssues,
  analyzeHarmonyTool,
  listInstruments,
  transpose,
  changeInstrumentTool,
  shiftOctave,
  copyBars,
  writeBarsTool,
  setBarProperties,
  addDynamics,
  addHairpin,
  addText,
  setArticulation,
  insertBars,
  deleteBars,
  multiBarRest,
  addPartTool,
  removePartTool,
  renamePartTool,
  setInfo,
  arrange,
];

// ---------------------------------------------------------------------------
// Running tools and describing them for the API
// ---------------------------------------------------------------------------

export interface ToolRun extends ToolOutcome {
  error?: boolean;
}

/** Validate the arguments and run a tool; failures come back as text for the model. */
export function runTool(tools: AiTool[], name: string, rawArgs: unknown, score: Score): ToolRun {
  const found = tools.find((t) => t.name === name);
  if (!found) return { error: true, result: `Error: there is no tool "${name}". Tools: ${tools.map((t) => t.name).join(", ")}.` };
  const parsed = found.schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return { error: true, result: `Error: invalid arguments for ${name}:\n${z.prettifyError(parsed.error)}` };
  }
  try {
    return found.run(score, parsed.data as never);
  } catch (err) {
    if (err instanceof ToolError || err instanceof McnError || err instanceof EditError) return { error: true, result: `Error: ${err.message}` };
    return { error: true, result: `Error: ${(err as Error).message || String(err)}` };
  }
}

function clean(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(clean);
  if (!schema || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$schema") continue;
    // Huge integer bounds (zod's safe-integer limits) only make grammars slow.
    if ((key === "minimum" || key === "maximum") && typeof value === "number" && Math.abs(value) > 1e6) continue;
    out[key] = clean(value);
  }
  return out;
}

/** JSON schema of a tool's arguments. */
export function toolParameters(t: AiTool): Record<string, unknown> {
  return clean(z.toJSONSchema(t.schema, { target: "draft-7", io: "input" })) as Record<string, unknown>;
}

/** Tools in the OpenAI chat-completions format. */
export function openAiTools(tools: AiTool[]): { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }[] {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: toolParameters(t) } }));
}

export { beatOffset };
