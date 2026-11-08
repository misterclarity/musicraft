/**
 * Proofreading recognised scores with a vision model: for each line of music, the model sees the
 * original crop and the recognised bars (written pitch) and lists differences and missed markings.
 * Nothing is applied until the user confirms a finding.
 */
import {
  aiBarLabels,
  barIndex,
  concertKeys,
  getInstrument,
  isUnison,
  keyName,
  MCN_GUIDE,
  parseMcn,
  partHandle,
  printBars,
  runTool,
  SCORE_TOOLS,
  timeSignatures,
  writeBars,
  writtenContexts,
  type Score,
} from "@musicraft/score-core";
import type { PageRecord } from "../lib/db";
import type { Settings } from "../lib/settings";
import { streamChat, type ChatMessage } from "./llm";
import { cropPage, pageSystems, type SystemCrop } from "./vision";

export type FindingKind = "notes" | "dynamic" | "text" | "tempo" | "rehearsal";

export interface Finding {
  id: string;
  partIndex: number;
  measureIndex: number;
  kind: FindingKind;
  problem: string;
  /** Corrected bar in MCN (written pitch), for kind "notes". */
  fix?: string;
  value?: string;
  beat?: number;
}

export const PROOFREAD_PROMPT = `You check the work of an optical music recognition program. You get an image of one line of printed music and the notes the program recognised, in MCN notation, at written pitch (as printed).
Compare them bar by bar. Report only differences you can actually see in the image: wrong pitches or accidentals, wrong lengths, missing or extra notes or rests, missing ties, and markings the program missed (dynamics, text such as "Marcia" or "solo", tempo marks, rehearsal marks).
Answer with JSON only, no other text:
{"findings": [{"part": "P1", "bar": "12", "problem": "the second note is A4, not G4", "fix": "bar 12: E5/4 A4/4 C5/2"}],
 "missing": [{"part": "P1", "bar": "12", "beat": 1, "kind": "dynamic", "value": "mf"}]}
- "fix" is the whole corrected bar in MCN at written pitch, and must add up to the time signature. Leave it out if you are not sure.
- "kind" is one of dynamic, text, tempo, rehearsal. For tempo, value is like "Allegro" or "quarter = 120".
- If everything matches, answer {"findings": [], "missing": []}.

${MCN_GUIDE}`;

/** The recognised bars of a line of music, as the model sees them. */
export function describeSystem(score: Score, system: SystemCrop): string {
  const [from, to] = system.measures;
  const labels = aiBarLabels(score);
  const time = timeSignatures(score)[from]!;
  const lines: string[] = [];
  lines.push(`Recognised bars ${labels[from]}–${labels[to]} (time ${time.beats}/${time.beatType}, concert key ${keyName(concertKeys(score)[from]!)}).`);
  score.parts.forEach((part, p) => {
    const instrument = getInstrument(part.instrument);
    const written = writtenContexts(score, part)[from]!;
    const transposing = !isUnison(instrument.transposition);
    lines.push(`# ${partHandle(p)} "${part.name}" (${instrument.name}${transposing ? `, written key ${keyName(written.key)}` : ""}), written pitch:`);
    lines.push(...printBars(score, p, from, to, "written"));
  });
  return lines.join("\n");
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
    return { partIndex, measureIndex };
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
    const kind = String(item.kind ?? "").toLowerCase();
    const value = typeof item.value === "string" ? item.value.trim() : typeof item.value === "number" ? String(item.value) : "";
    if (!where || !value || !["dynamic", "text", "tempo", "rehearsal"].includes(kind)) continue;
    const beat = typeof item.beat === "number" && item.beat >= 1 ? item.beat : undefined;
    out.push({ id: `f${++findingCounter}`, ...where, kind: kind as FindingKind, value, beat, problem: `Missing ${kind}: ${value}` });
  }
  return out;
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
  return pageSystems(pages, score.measures.length);
}

/** Apply a finding to the score; returns the new score and a label for the undo history. */
export function applyFinding(score: Score, finding: Finding): { score: Score; label: string } {
  const bar = aiBarLabels(score)[finding.measureIndex]!;
  const part = partHandle(finding.partIndex);
  if (finding.kind === "notes") {
    if (!finding.fix) throw new Error("This finding has no fix to apply; correct the bar by hand.");
    return { score: writeBars(score, finding.partIndex, finding.fix, "written").score, label: `Proofreading: bar ${bar}` };
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
