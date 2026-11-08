import { durationFromValue, TYPE_DENOMINATOR, type Duration } from "./duration";
import { cmp, frac, mul, sub, toNumber, type Fraction } from "./fraction";
import { getInstrument, prettyName, type InstrumentDef } from "./instruments";
import { measureLengths, voiceLength, type ClefSign, type Id, type Score } from "./model";
import { diatonicNumber, formatPitch, midiNumber, samePitch, type Pitch } from "./pitch";
import { toWrittenPitch, writtenContexts } from "./transpose";

export type IssueSeverity = "error" | "warning" | "info";

export type IssueCode =
  | "bar-too-long"
  | "bar-too-short"
  | "out-of-range"
  | "uncomfortable-range"
  | "unusual-clef"
  | "tie-mismatch";

export interface Issue {
  id: string;
  severity: IssueSeverity;
  code: IssueCode;
  message: string;
  partId: Id;
  measureIndex: number;
  staff?: number;
  eventIds?: Id[];
}

export interface CheckOptions {
  /** Also warn about notes outside the comfortable (amateur) range. Default true. */
  comfortableRange?: boolean;
}

/** Clefs each family normally uses; anything else in the middle of a part is suspicious (often OMR noise). */
function usualClefs(instrument: InstrumentDef): Set<ClefSign> | null {
  if (instrument.family === "keyboard" || instrument.family === "other") return null;
  const usual = new Set(instrument.clefs.map((c) => c.sign));
  if (["horn-f", "cello", "bassoon", "trombone", "euphonium", "bass-trombone", "double-bass", "viola"].includes(instrument.id)) {
    usual.add("G");
    usual.add("F");
    usual.add("C");
  }
  return usual;
}

const CLEF_NAMES: Record<string, string> = { G: "treble", F: "bass", C: "C", percussion: "percussion" };

/** Describe a length like "3¾ beats" for a time signature beat. */
export function describeBeats(value: Fraction, beatType: number): string {
  const beats = mul(value, frac(beatType));
  const whole = Math.floor(toNumber(beats));
  const rest = sub(beats, frac(whole));
  const fractions: Record<string, string> = { "1/2": "½", "1/4": "¼", "3/4": "¾", "1/3": "⅓", "2/3": "⅔", "1/8": "⅛", "3/8": "⅜", "5/8": "⅝", "7/8": "⅞" };
  const restText = rest.n === 0 ? "" : (fractions[`${rest.n}/${rest.d}`] ?? ` ${rest.n}/${rest.d}`);
  const number = `${whole === 0 && restText ? "" : whole}${restText}`;
  return `${number} beat${toNumber(beats) === 1 ? "" : "s"}`;
}

export function describeValue(value: Fraction): string {
  const d: Duration | undefined = durationFromValue(value);
  if (!d) return `${value.n}/${value.d} of a whole note`;
  const names: Record<number, string> = { 1: "whole note", 2: "half note", 4: "quarter note", 8: "eighth note", 16: "16th note", 32: "32nd note", 64: "64th note", 128: "128th note", 0: "breve" };
  const dotted = d.dots === 1 ? "dotted " : d.dots === 2 ? "double-dotted " : "";
  return `a ${dotted}${names[TYPE_DENOMINATOR[d.type]]}`;
}

export function checkScore(score: Score, options: CheckOptions = {}): Issue[] {
  const issues: Issue[] = [];
  const lengths = measureLengths(score);
  const comfortable = options.comfortableRange ?? true;
  let counter = 0;
  const push = (issue: Omit<Issue, "id">) => issues.push({ id: `i${++counter}`, ...issue });

  let beatTypes: number[] = [];
  {
    let current = 4;
    beatTypes = score.measures.map((m) => (current = m.time?.beatType ?? current));
  }

  for (const part of score.parts) {
    const instrument = getInstrument(part.instrument);
    const contexts = writtenContexts(score, part);
    const clefs = usualClefs(instrument);
    const partLabel = prettyName(part.name);

    part.measures.forEach((pm, m) => {
      const info = score.measures[m]!;
      const expected = lengths[m]!;
      const isLast = m === score.measures.length - 1;

      // Bar lengths.
      for (const voice of pm.voices) {
        const actual = voiceLength(voice, expected);
        const c = cmp(actual, expected);
        const primary = voice.voice === Math.min(...pm.voices.filter((v) => v.staff === voice.staff).map((v) => v.voice));
        if (c > 0) {
          push({
            severity: "error",
            code: "bar-too-long",
            message: `Bar ${info.number} (${partLabel}${part.staves > 1 ? `, staff ${voice.staff}` : ""}): ${describeBeats(actual, beatTypes[m]!)} instead of ${describeBeats(expected, beatTypes[m]!)}, ${describeValue(sub(actual, expected))} too many.`,
            partId: part.id,
            measureIndex: m,
            staff: voice.staff,
            eventIds: voice.events.map((e) => e.id),
          });
        } else if (c < 0 && primary && !info.implicit && !isLast && voice.events.length > 0) {
          push({
            severity: "warning",
            code: "bar-too-short",
            message: `Bar ${info.number} (${partLabel}${part.staves > 1 ? `, staff ${voice.staff}` : ""}): ${describeBeats(actual, beatTypes[m]!)} instead of ${describeBeats(expected, beatTypes[m]!)}, ${describeValue(sub(expected, actual))} missing.`,
            partId: part.id,
            measureIndex: m,
            staff: voice.staff,
            eventIds: voice.events.map((e) => e.id),
          });
        }
      }

      // Ranges, reported once per bar and part.
      const tooLow: Pitch[] = [];
      const tooHigh: Pitch[] = [];
      const uncomfortable: Pitch[] = [];
      const rangeEvents: Id[] = [];
      for (const voice of pm.voices) {
        for (const event of voice.events) {
          if (event.kind !== "note") continue;
          for (const note of event.notes) {
            const written = toWrittenPitch(note.pitch, contexts[m]!);
            const midi = midiNumber(written);
            if (midi < midiNumber(instrument.range.low)) {
              tooLow.push(written);
              rangeEvents.push(event.id);
            } else if (midi > midiNumber(instrument.range.high)) {
              tooHigh.push(written);
              rangeEvents.push(event.id);
            } else if (
              comfortable &&
              (midi < midiNumber(instrument.comfortable.low) || midi > midiNumber(instrument.comfortable.high))
            ) {
              uncomfortable.push(written);
              rangeEvents.push(event.id);
            }
          }
        }
      }
      const extreme = (list: Pitch[], dir: 1 | -1) =>
        formatPitch(list.reduce((a, b) => (dir * (diatonicNumber(b) - diatonicNumber(a)) > 0 ? b : a)));
      if (tooLow.length || tooHigh.length) {
        const what = [
          tooLow.length ? `${tooLow.length} below (lowest ${extreme(tooLow, -1)})` : "",
          tooHigh.length ? `${tooHigh.length} above (highest ${extreme(tooHigh, 1)})` : "",
        ].filter(Boolean);
        push({
          severity: "error",
          code: "out-of-range",
          message: `Bar ${info.number} (${partLabel}): notes outside the range of ${prettyName(instrument.name)}: ${what.join(", ")}. Written range ${formatPitch(instrument.range.low)}–${formatPitch(instrument.range.high)}.`,
          partId: part.id,
          measureIndex: m,
          eventIds: rangeEvents,
        });
      } else if (uncomfortable.length) {
        push({
          severity: "info",
          code: "uncomfortable-range",
          message: `Bar ${info.number} (${partLabel}): ${uncomfortable.length} note${uncomfortable.length > 1 ? "s" : ""} outside the comfortable range ${formatPitch(instrument.comfortable.low)}–${formatPitch(instrument.comfortable.high)} (written).`,
          partId: part.id,
          measureIndex: m,
          eventIds: rangeEvents,
        });
      }

      // Clef changes the instrument doesn't normally use.
      if (clefs) {
        for (const change of pm.clefChanges ?? []) {
          if (!clefs.has(change.clef.sign)) {
            push({
              severity: "warning",
              code: "unusual-clef",
              message: `Bar ${info.number} (${partLabel}): change to ${CLEF_NAMES[change.clef.sign]} clef, which ${prettyName(instrument.name)} doesn't normally use. If this came from a scan it is probably a recognition error.`,
              partId: part.id,
              measureIndex: m,
              staff: change.staff,
            });
          }
        }
      }
    });

    // Ties must lead to the same pitch.
    const byStaffVoice = new Map<string, { measure: number; eventId: Id; pitch: Pitch; tieStart: boolean }[]>();
    part.measures.forEach((pm, m) => {
      for (const voice of pm.voices) {
        const key = `${voice.staff}/${voice.voice}`;
        const list = byStaffVoice.get(key) ?? [];
        for (const event of voice.events) {
          if (event.kind !== "note" || event.grace) continue;
          for (const note of event.notes) list.push({ measure: m, eventId: event.id, pitch: note.pitch, tieStart: !!note.tie?.start });
          if (event.notes.length === 0) list.push({ measure: m, eventId: event.id, pitch: { step: "C", alter: 0, octave: -10 }, tieStart: false });
        }
        byStaffVoice.set(key, list);
      }
    });
    for (const list of byStaffVoice.values()) {
      list.forEach((item, i) => {
        if (!item.tieStart) return;
        // The next event's notes in the same voice.
        const nextEvent = list.slice(i + 1).find((x) => x.eventId !== item.eventId);
        const candidates = nextEvent ? list.filter((x) => x.eventId === nextEvent.eventId) : [];
        if (!candidates.some((x) => samePitch(x.pitch, item.pitch))) {
          push({
            severity: "warning",
            code: "tie-mismatch",
            message: `Bar ${score.measures[item.measure]!.number} (${partLabel}): a tie from ${formatPitch(item.pitch)} doesn't lead to the same note.`,
            partId: part.id,
            measureIndex: item.measure,
            eventIds: [item.eventId],
          });
        }
      });
    }
  }
  return issues;
}
