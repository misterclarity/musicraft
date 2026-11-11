/** How much of each instrument's range a part uses: for the range meters and the player card. */
import { formatPitch, getInstrument, midiNumber, spellMidi, toWrittenPitch, writtenContexts, type Score } from "@musicraft/score-core";

export interface PartRange {
  /** Lowest and highest written note of the part, as MIDI numbers (null when it has no notes). */
  low: number | null;
  high: number | null;
  /** The instrument's full and comfortable range, written MIDI numbers. */
  rangeLow: number;
  rangeHigh: number;
  comfortLow: number;
  comfortHigh: number;
  /** Semitones from written to sounding pitch (-2 for a B♭ trumpet). */
  transposition: number;
  notes: number;
  barsWithNotes: number;
  /** Whether the part goes beyond what the instrument plays comfortably, or can play at all. */
  beyond: "comfort" | "range" | null;
}

export function partRanges(score: Score): Map<string, PartRange> {
  const ranges = new Map<string, PartRange>();
  for (const part of score.parts) {
    const instrument = getInstrument(part.instrument);
    const contexts = writtenContexts(score, part);
    let low: number | null = null;
    let high: number | null = null;
    let notes = 0;
    let barsWithNotes = 0;
    part.measures.forEach((pm, m) => {
      let any = false;
      for (const voice of pm.voices) {
        for (const event of voice.events) {
          if (event.kind !== "note") continue;
          any = true;
          notes++;
          for (const note of event.notes) {
            const written = midiNumber(toWrittenPitch(note.pitch, contexts[m]!));
            low = low === null ? written : Math.min(low, written);
            high = high === null ? written : Math.max(high, written);
          }
        }
      }
      if (any) barsWithNotes++;
    });
    const range = {
      rangeLow: midiNumber(instrument.range.low),
      rangeHigh: midiNumber(instrument.range.high),
      comfortLow: midiNumber(instrument.comfortable.low),
      comfortHigh: midiNumber(instrument.comfortable.high),
    };
    const beyond: PartRange["beyond"] =
      low === null || high === null
        ? null
        : low < range.rangeLow || high > range.rangeHigh
          ? "range"
          : low < range.comfortLow || high > range.comfortHigh
            ? "comfort"
            : null;
    ranges.set(part.id, { low, high, ...range, transposition: instrument.transposition.chromatic, notes, barsWithNotes, beyond });
  }
  return ranges;
}

/** A written MIDI number as a note name, spelled with sharps ("F#5"). */
export function noteName(midi: number): string {
  return formatPitch(spellMidi(midi, 0));
}
