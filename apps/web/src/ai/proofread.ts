/**
 * Proofreading recognised scores with a vision model: for each line of music, the model sees the
 * original crop and the recognised bars (written pitch) and lists differences and missed markings.
 * Nothing is applied until the user confirms a finding.
 */
import {
  aiBarLabels,
  barIndex,
  concertKeys,
  correctKeySignature,
  getInstrument,
  isUnison,
  keyName,
  MCN_GUIDE,
  parseKey,
  parseMcn,
  partHandle,
  printBars,
  runTool,
  SCORE_TOOLS,
  timeSignatures,
  expandMultiRest,
  isRestBar,
  writeBars,
  writtenContexts,
  writtenKeyToConcert,
  type KeySignature,
  type Score,
  type TimeSignature,
} from "@musicraft/score-core";
import type { PageRecord } from "../lib/db";
import type { Settings } from "../lib/settings";
import { streamChat, type ChatMessage } from "./llm";
import { cropPage, pageSystems, type SystemCrop } from "./vision";

export type FindingKind = "notes" | "dynamic" | "text" | "tempo" | "rehearsal" | "multirest" | "key" | "time";

export interface Finding {
  id: string;
  partIndex: number;
  /** The bar, by id: findings stay attached to it when other fixes add or remove bars. */
  measureId: string;
  /** Where the bar was when the finding was made (see findingBar for where it is now). */
  measureIndex: number;
  kind: FindingKind;
  problem: string;
  /** Corrected bar in MCN (written pitch), for kind "notes". */
  fix?: string;
  /** What to add; for kind "key" the concert key's fifths, for kind "time" e.g. "12/8". */
  value?: string;
  beat?: number;
}

export const PROOFREAD_PROMPT = `You check the work of an optical music recognition program. You get an image of one line of printed music and the notes the program recognised, in MCN notation, at written pitch (as printed).
First check the key signature (count the sharps or flats after the clef at the start of the line, and at any key change) and the time signature: when they are wrong, most pitches or bar lengths are wrong too.
Then compare the bars one by one. Report only differences you can actually see in the image: wrong pitches or accidentals, wrong lengths, missing or extra notes or rests, missing ties, markings the program missed (dynamics, text such as "Marcia" or "solo", tempo marks, rehearsal marks), and multi-bar rests: a rest bar with a number above it lasts that many bars, but the program reads it as a single bar.
Answer with JSON only, no other text:
{"findings": [{"part": "P1", "bar": "12", "problem": "the second note is A4, not G4", "fix": "bar 12: E5/4 A4/4 C5/2"}],
 "missing": [{"part": "P1", "bar": "12", "beat": 1, "kind": "dynamic", "value": "mf"}]}
- "fix" is the whole corrected bar in MCN at written pitch, and must add up to the time signature. Leave it out if you are not sure.
- "kind" is one of dynamic, text, tempo, rehearsal, multirest, key, time. For tempo, value is like "Allegro" or "quarter = 120". For multirest, value is the number printed above the rest, e.g. {"bar": "14", "kind": "multirest", "value": 7}.
- Report a key or time signature only where the printed one differs from the recognised one. For key, value is what is printed: the number of sharps or flats, e.g. {"bar": "26", "kind": "key", "value": "3 flats"}, or "none". For time, value is the printed time signature, e.g. {"bar": "34", "kind": "time", "value": "12/8"}. A signature at the start of the line belongs to its first bar.
- If everything matches, answer {"findings": [], "missing": []}.

${MCN_GUIDE}`;

/** The recognised bars of a line of music, as the model sees them. */
export function describeSystem(score: Score, system: SystemCrop): string {
  const [from, to] = system.measures;
  const labels = aiBarLabels(score);
  const times = timeSignatures(score);
  const keys = concertKeys(score);
  const written = score.parts.map((part) => writtenContexts(score, part));
  const timeText = (t: TimeSignature) => `${t.beats}/${t.beatType}`;
  // The key as printed in each part: transposing parts read a different key than concert pitch.
  const keyText = (m: number) =>
    score.parts.length === 1
      ? keyWithCount(written[0]![m]!.key)
      : score.parts.map((_, p) => `${partHandle(p)} ${keyWithCount(written[p]![m]!.key)}`).join(", ");
  const lines: string[] = [];
  lines.push(`Recognised bars ${labels[from]}–${labels[to]}: time ${timeText(times[from]!)}, key signature ${keyText(from)}.`);
  for (let m = from + 1; m <= to; m++) {
    const info = score.measures[m]!;
    if (info.time) lines.push(`Bar ${labels[m]}: time signature changes to ${timeText(times[m]!)}.`);
    if (info.key && keys[m]!.fifths !== keys[m - 1]!.fifths) lines.push(`Bar ${labels[m]}: key signature changes to ${keyText(m)}.`);
  }
  score.parts.forEach((part, p) => {
    const instrument = getInstrument(part.instrument);
    const transposing = !isUnison(instrument.transposition);
    lines.push(`# ${partHandle(p)} "${part.name}" (${instrument.name}${transposing ? ", a transposing instrument" : ""}), written pitch:`);
    lines.push(...printBars(score, p, from, to, "written"));
  });
  return lines.join("\n");
}

/** "3 flats", "1 sharp", "no sharps or flats". */
function keyCount(fifths: number): string {
  if (fifths === 0) return "no sharps or flats";
  const n = Math.abs(fifths);
  return `${n} ${fifths > 0 ? "sharp" : "flat"}${n > 1 ? "s" : ""}`;
}

/** "Eb major (3 flats)". */
function keyWithCount(key: KeySignature): string {
  return `${keyName(key)} (${keyCount(key.fifths)})`;
}

const NUMBER_WORDS = ["none", "one", "two", "three", "four", "five", "six", "seven"];

/** A printed key signature as the model describes it ("3 flats", "one sharp", "none", "Eb major") → fifths. */
export function parseKeySignature(text: string): number | undefined {
  const t = text.trim().toLowerCase().replace(/♭/g, "b").replace(/♯/g, "#");
  if (/^(none|0|no (sharps|flats|accidentals)|no sharps or flats|natural|c major|a minor)$/.test(t)) return 0;
  const counted = /^([0-7]|one|two|three|four|five|six|seven)\s*(sharps?|flats?|#|b)$/.exec(t);
  if (counted) {
    const n = /\d/.test(counted[1]!) ? Number(counted[1]) : NUMBER_WORDS.indexOf(counted[1]!);
    return counted[2]!.startsWith("s") || counted[2] === "#" ? n : -n;
  }
  if (/^[+-]?[0-7]$/.test(t)) return Number(t);
  if (/^#{1,7}$/.test(t)) return t.length;
  if (/^b{2,7}$/.test(t)) return -t.length;
  try {
    return parseKey(text.trim().replace(/\b(major|minor|maj|min)\b/i, (w) => w.toLowerCase())).fifths;
  } catch {
    return undefined;
  }
}

/** A printed time signature ("12/8", "C", "cut") → its numbers. */
export function parseTimeSignature(text: string): TimeSignature | undefined {
  const t = text.trim().toLowerCase();
  if (t === "c" || t === "common" || t === "common time") return { beats: 4, beatType: 4, symbol: "common" };
  if (t === "cut" || t === "¢" || t === "c|" || t === "alla breve" || t === "cut time") return { beats: 2, beatType: 2, symbol: "cut" };
  const m = /^(\d{1,2})\s*\/\s*(\d{1,2})$/.exec(t);
  if (!m || ![1, 2, 4, 8, 16, 32].includes(Number(m[2])) || Number(m[1]) < 1) return undefined;
  return { beats: Number(m[1]), beatType: Number(m[2]) };
}

/** The first JSON object in a reply (models sometimes wrap it in text or code fences). */
export function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{");
  if (start < 0) throw new Error("The model did not answer with JSON.");
  let depth = 0;
  let quoted = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "\\" && quoted) {
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (quoted) continue;
    if (ch === "{") depth++;
    if (ch === "}" && --depth === 0) return JSON.parse(cleaned.slice(start, i + 1).replace(/,\s*([}\]])/g, "$1"));
  }
  throw new Error("The model's JSON answer was cut off.");
}

let findingCounter = 0;

/** Turn the model's answer into findings, dropping anything that points outside the line. */
export function parseFindings(score: Score, system: SystemCrop, answer: unknown): Finding[] {
  const out: Finding[] = [];
  const data = (answer ?? {}) as { findings?: unknown[]; missing?: unknown[] };
  const resolve = (item: Record<string, unknown>) => {
    let partIndex = 0;
    const part = item.part;
    if (typeof part === "string" || typeof part === "number") {
      const m = /(\d+)/.exec(String(part));
      if (m && score.parts[Number(m[1]) - 1]) partIndex = Number(m[1]) - 1;
    }
    let measureIndex: number;
    try {
      measureIndex = barIndex(score, item.bar as string | number);
    } catch {
      return null;
    }
    if (measureIndex < system.measures[0] || measureIndex > system.measures[1]) return null;
    return { partIndex, measureIndex, measureId: score.measures[measureIndex]!.id };
  };
  for (const raw of data.findings ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const where = resolve(item);
    if (!where) continue;
    let fix = typeof item.fix === "string" && item.fix.trim() ? item.fix.trim() : undefined;
    if (fix) {
      // Keep only a fix that is valid notation for this bar.
      try {
        const lines = parseMcn(fix.startsWith("bar") ? fix : `bar ${aiBarLabels(score)[where.measureIndex]}: ${fix}`);
        if (lines.some((l) => { try { return barIndex(score, l.bar) !== where.measureIndex; } catch { return true; } })) fix = undefined;
        else if (!fix.startsWith("bar")) fix = `bar ${aiBarLabels(score)[where.measureIndex]}: ${fix}`;
      } catch {
        fix = undefined;
      }
    }
    out.push({ id: `f${++findingCounter}`, ...where, kind: "notes", problem: String(item.problem ?? "Differs from the original"), fix });
  }
  for (const raw of data.missing ?? []) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const where = resolve(item);
    const kind = String(item.kind ?? "").toLowerCase().replace(/[\s_-]/g, "");
    const value = typeof item.value === "string" ? item.value.trim() : typeof item.value === "number" ? String(item.value) : "";
    if (!where || !value) continue;
    if (kind === "multirest" || kind === "multibarrest" || kind === "multimeasurerest") {
      const bars = Number.parseInt(value, 10);
      // Only a rest bar can be a multi-bar rest; the count must be a plausible printed number.
      if (!(bars >= 2 && bars <= 500) || !isRestBar(score, where.measureIndex)) continue;
      out.push({ id: `f${++findingCounter}`, ...where, kind: "multirest", value: String(bars), problem: `A ${bars}-bar rest, read as one bar` });
      continue;
    }
    if (kind === "key" || kind === "keysignature") {
      const fifths = parseKeySignature(value);
      if (fifths === undefined) continue;
      const part = score.parts[where.partIndex]!;
      const instrument = getInstrument(part.instrument);
      const concert = writtenKeyToConcert({ fifths, mode: "major" }, instrument).key;
      const current = concertKeys(score)[where.measureIndex]!;
      if (concert.fifths === current.fifths) continue;
      const recognised = writtenContexts(score, part)[where.measureIndex]!.key;
      out.push({
        id: `f${++findingCounter}`,
        ...where,
        kind: "key",
        value: String(concert.fifths),
        problem: `Key signature with ${keyCount(fifths)}, read as ${keyCount(recognised.fifths)}; applying it also respells the notes that follow the key`,
      });
      continue;
    }
    if (kind === "time" || kind === "timesignature") {
      const time = parseTimeSignature(value);
      const current = timeSignatures(score)[where.measureIndex]!;
      if (!time || (time.beats === current.beats && time.beatType === current.beatType)) continue;
      out.push({
        id: `f${++findingCounter}`,
        ...where,
        kind: "time",
        value: `${time.beats}/${time.beatType}`,
        problem: `Time signature ${time.beats}/${time.beatType}, read as ${current.beats}/${current.beatType}`,
      });
      continue;
    }
    if (!["dynamic", "text", "tempo", "rehearsal"].includes(kind)) continue;
    const beat = typeof item.beat === "number" && item.beat >= 1 ? item.beat : undefined;
    out.push({ id: `f${++findingCounter}`, ...where, kind: kind as FindingKind, value, beat, problem: `Missing ${kind}: ${value}` });
  }
  // Signatures first: the notes depend on them, so they are best applied before the note fixes.
  const signature = (f: Finding) => (f.kind === "key" || f.kind === "time" ? 0 : 1);
  return out.sort((a, b) => signature(a) - signature(b));
}

/** Ask the model about one line of music. */
export async function proofreadSystem(
  settings: Settings,
  model: string | null,
  score: Score,
  pages: PageRecord[],
  system: SystemCrop,
  signal?: AbortSignal,
): Promise<Finding[]> {
  const image = await cropPage(pages[system.page]!, system.box);
  const messages: ChatMessage[] = [
    { role: "system", content: PROOFREAD_PROMPT },
    {
      role: "user",
      content: [
        { type: "text", text: `${describeSystem(score, system)}\n\nHere is the printed line. List the differences as JSON.` },
        { type: "image_url", image_url: { url: image } },
      ],
    },
  ];
  const result = await streamChat(settings, { model, messages }, {}, signal);
  return parseFindings(score, system, extractJson(result.content));
}

export function proofreadSystems(pages: PageRecord[], score: Score): SystemCrop[] {
  return pageSystems(pages, score);
}

/** Where a finding's bar is now (-1 when it was deleted). */
export function findingBar(score: Score, finding: Finding): number {
  return score.measures.findIndex((m) => m.id === finding.measureId);
}

/** Apply a finding to the score; returns the new score and a label for the undo history. */
export function applyFinding(score: Score, finding: Finding): { score: Score; label: string } {
  const m = findingBar(score, finding);
  if (m < 0) throw new Error("That bar no longer exists.");
  const bar = aiBarLabels(score)[m]!;
  const part = partHandle(finding.partIndex);
  if (finding.kind === "notes") {
    if (!finding.fix) throw new Error("This finding has no fix to apply; correct the bar by hand.");
    // Bar numbers may have moved since (an expanded multi-bar rest): write to the bar's current number.
    const fix = finding.fix.replace(/^(\s*bar\s+)[0-9A-Za-z]+/gim, (_all, prefix: string) => `${prefix}${bar}`);
    return { score: writeBars(score, finding.partIndex, fix, "written").score, label: `Proofreading: bar ${bar}` };
  }
  if (finding.kind === "multirest") {
    const bars = Number(finding.value);
    return { score: expandMultiRest(score, m, bars), label: `Proofreading: ${bars}-bar rest at bar ${bar}` };
  }
  if (finding.kind === "key") {
    // The notes were spelled by the key the recognition saw: respell those that followed it.
    const key: KeySignature = { fifths: Number(finding.value), mode: "major" };
    return { score: correctKeySignature(score, m, key), label: `Proofreading: key signature at bar ${bar}` };
  }
  if (finding.kind === "time") {
    const run = runTool(SCORE_TOOLS, "set_bar_properties", { bar, time: finding.value }, score);
    if (run.error || !run.score) throw new Error(run.result.replace(/^Error: /, ""));
    return { score: run.score, label: `Proofreading: time signature at bar ${bar}` };
  }
  let tool: string;
  let args: Record<string, unknown>;
  if (finding.kind === "dynamic") {
    tool = "add_dynamics";
    args = { part, marks: [{ bar, beat: finding.beat, dynamic: finding.value }] };
  } else if (finding.kind === "text") {
    tool = "add_text";
    args = { part, bar, beat: finding.beat, text: finding.value };
  } else if (finding.kind === "rehearsal") {
    tool = "set_bar_properties";
    args = { bar, rehearsal: finding.value };
  } else {
    const bpm = /(\d{2,3})/.exec(finding.value ?? "")?.[1];
    const text = (finding.value ?? "").replace(/(quarter|half|eighth|crotchet|minim|♩|𝅘𝅥)?\s*=?\s*\d{2,3}/gi, "").trim();
    tool = "set_bar_properties";
    args = { bar, ...(bpm ? { tempo_bpm: Number(bpm) } : {}), ...(text ? { tempo_text: text } : {}) };
  }
  const run = runTool(SCORE_TOOLS, tool, args, score);
  if (run.error || !run.score) throw new Error(run.result.replace(/^Error: /, ""));
  return { score: run.score, label: `Proofreading: ${finding.kind} in bar ${bar}` };
}
