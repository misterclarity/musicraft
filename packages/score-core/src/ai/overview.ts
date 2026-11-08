/** Compact text descriptions of a score for the language model. */
import { checkScore } from "../checks";
import { describeTransposition, getInstrument } from "../instruments";
import { concertKeys, timeSignatures, type Score } from "../model";
import { formatPitch, isUnison, keyName, midiNumber, type Pitch } from "../pitch";
import { toWrittenPitch, writtenContexts } from "../transpose";
import { aiBarLabels, printedNumbersAreUnique } from "./notation";

const CLEF_WORDS: Record<string, string> = { G: "treble", F: "bass", C: "C clef", percussion: "percussion" };

function clefWord(sign: string, line: number, octave?: number): string {
  if (sign === "C") return line === 3 ? "alto" : line === 4 ? "tenor" : "C clef";
  const base = CLEF_WORDS[sign] ?? sign;
  return octave === -1 ? `${base} 8vb` : octave === 1 ? `${base} 8va` : base;
}

/** Lowest and highest sounding and written notes of a part. */
export function partRange(score: Score, partIndex: number): { concert: [Pitch, Pitch]; written: [Pitch, Pitch] } | null {
  const part = score.parts[partIndex]!;
  const contexts = writtenContexts(score, part);
  let low: { p: Pitch; m: number } | undefined;
  let high: { p: Pitch; m: number } | undefined;
  part.measures.forEach((pm, m) => {
    for (const v of pm.voices) {
      for (const e of v.events) {
        if (e.kind !== "note") continue;
        for (const n of e.notes) {
          if (!low || midiNumber(n.pitch) < midiNumber(low.p)) low = { p: n.pitch, m };
          if (!high || midiNumber(n.pitch) > midiNumber(high.p)) high = { p: n.pitch, m };
        }
      }
    }
  });
  if (!low || !high) return null;
  return {
    concert: [low.p, high.p],
    written: [toWrittenPitch(low.p, contexts[low.m]!), toWrittenPitch(high.p, contexts[high.m]!)],
  };
}

/** Changes of a bar-level value, as "X from bar 1; Y from bar 33". */
function changes<T>(score: Score, values: T[], same: (a: T, b: T) => boolean, show: (v: T) => string): string {
  const labels = aiBarLabels(score);
  const out: string[] = [];
  values.forEach((v, i) => {
    if (i === 0 || !same(values[i - 1]!, v)) out.push(`${show(v)} from bar ${labels[i]}`);
  });
  return out.join("; ");
}

export function describePart(score: Score, partIndex: number): string {
  const part = score.parts[partIndex]!;
  const instrument = getInstrument(part.instrument);
  const transposing = !isUnison(instrument.transposition);
  const bits: string[] = [];
  bits.push(`${instrument.name} (${instrument.id})`);
  if (transposing) {
    bits.push(`transposing: ${describeTransposition(instrument).replace(/^Sounds/, "sounds")}`);
    const written = writtenContexts(score, part);
    bits.push(`written key ${changes(score, written.map((c) => c.key), (a, b) => a.fifths === b.fifths && a.mode === b.mode, keyName)}`);
  }
  const clefs = part.clefs.map((c) => clefWord(c.sign, c.line, c.octaveChange)).join(", ");
  bits.push(part.staves > 1 ? `${part.staves} staves (${clefs})` : `1 staff (${clefs})`);
  const range = partRange(score, partIndex);
  if (!range) bits.push("no notes yet");
  else if (transposing) {
    bits.push(
      `notes written ${formatPitch(range.written[0])}–${formatPitch(range.written[1])} (concert ${formatPitch(range.concert[0])}–${formatPitch(range.concert[1])})`,
    );
  } else bits.push(`notes ${formatPitch(range.concert[0])}–${formatPitch(range.concert[1])}`);
  bits.push(
    `instrument range${transposing ? " (written)" : ""} ${formatPitch(instrument.range.low)}–${formatPitch(instrument.range.high)}, ` +
      `comfortable ${formatPitch(instrument.comfortable.low)}–${formatPitch(instrument.comfortable.high)}`,
  );
  return `P${partIndex + 1} "${part.name}": ${bits.join("; ")}`;
}

/** Overview of the whole score: bars, time and key, tempo, marks, parts, checks. */
export function describeScore(score: Score): string {
  const labels = aiBarLabels(score);
  const lines: string[] = [];
  const meta = score.meta;
  lines.push(`Title: ${meta.title ? `"${meta.title}"` : "(none)"}${meta.subtitle ? ` — ${meta.subtitle}` : ""}`);
  if (meta.composer) lines.push(`Composer: ${meta.composer}`);
  if (meta.arranger) lines.push(`Arranger: ${meta.arranger}`);
  const n = score.measures.length;
  let bars = `Bars: ${labels[0]}–${labels[n - 1]} (${n} bar${n === 1 ? "" : "s"})`;
  if (score.measures[0]?.implicit) bars += `; bar ${labels[0]} is a pickup`;
  if (!printedNumbersAreUnique(score)) bars += "; bars are counted from the start because the printed numbers repeat";
  lines.push(bars);
  lines.push(
    `Time: ${changes(score, timeSignatures(score), (a, b) => a.beats === b.beats && a.beatType === b.beatType, (t) => `${t.beats}/${t.beatType}`)}`,
  );
  lines.push(`Key (concert pitch): ${changes(score, concertKeys(score), (a, b) => a.fifths === b.fifths && a.mode === b.mode, keyName)}`);
  const tempos = score.measures
    .map((m, i) => (m.tempo ? `${m.tempo.text ? `"${m.tempo.text}" ` : ""}${m.tempo.beatUnit}${m.tempo.beatUnitDots ? " dotted" : ""} = ${m.tempo.bpm} at bar ${labels[i]}` : null))
    .filter(Boolean);
  if (tempos.length) lines.push(`Tempo: ${tempos.join("; ")}`);
  const marks = score.measures.map((m, i) => (m.rehearsal ? `${m.rehearsal} at bar ${labels[i]}` : null)).filter(Boolean);
  if (marks.length) lines.push(`Rehearsal marks: ${marks.join("; ")}`);
  const repeats: string[] = [];
  score.measures.forEach((m, i) => {
    if (m.repeatStart) repeats.push(`start at bar ${labels[i]}`);
    if (m.repeatEnd) repeats.push(`end after bar ${labels[i]}${m.repeatEnd.times && m.repeatEnd.times !== 2 ? ` (${m.repeatEnd.times} times)` : ""}`);
    if (m.ending?.start) repeats.push(`ending ${m.ending.number} from bar ${labels[i]}`);
  });
  if (repeats.length) lines.push(`Repeats: ${repeats.join("; ")}`);
  lines.push("Parts:");
  score.parts.forEach((_, i) => lines.push(`  ${describePart(score, i)}`));
  const issues = checkScore(score).filter((i) => i.severity !== "info");
  if (issues.length) {
    const kinds = new Map<string, number>();
    for (const i of issues) {
      const kind = i.code.startsWith("bar-") ? "bar length" : i.code.includes("range") ? "range" : i.code === "tie-mismatch" ? "ties" : "clef";
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
    lines.push(`Checks: ${issues.length} problem${issues.length === 1 ? "" : "s"} (${[...kinds].map(([k, c]) => `${c} ${k}`).join(", ")}); call get_issues for details.`);
  } else lines.push("Checks: no problems found.");
  return lines.join("\n");
}
