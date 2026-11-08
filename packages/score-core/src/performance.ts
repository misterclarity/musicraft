import { durationValue } from "./duration";
import { cmp, div, frac, lte, mul, toNumber, type Fraction } from "./fraction";
import {
  eventOnsets,
  eventValue,
  measureLengths,
  timeSignatures,
  type Dynamic,
  type Id,
  type MeasureInfo,
  type Score,
} from "./model";
import { midiNumber } from "./pitch";

export interface PerformanceNote {
  partIndex: number;
  partId: Id;
  /** Sounding MIDI pitch. */
  midi: number;
  /** Seconds from the start. */
  start: number;
  duration: number;
  /** Whole notes from the start (for MIDI ticks). */
  startWhole: number;
  durationWhole: number;
  velocity: number;
  /** Chord-tone ids and the event id of every notated note this sound covers (ties merge notes). */
  noteIds: Id[];
  eventIds: Id[];
  measureIndex: number;
}

export interface PlayedMeasure {
  measureIndex: number;
  start: number;
  duration: number;
  startWhole: number;
}

export interface Performance {
  notes: PerformanceNote[];
  measures: PlayedMeasure[];
  /** Quarter notes per minute, at whole-note positions. */
  tempos: { startWhole: number; start: number; quarterBpm: number }[];
  timeSignatures: { startWhole: number; beats: number; beatType: number }[];
  duration: number;
}

export interface PerformanceOptions {
  expandRepeats?: boolean;
  /** 1 = as written, 0.5 = half speed. */
  tempoScale?: number;
  partIds?: Id[];
  defaultQuarterBpm?: number;
}

const DYNAMIC_VELOCITY: Partial<Record<Dynamic, number>> = {
  ppp: 25,
  pp: 36,
  p: 50,
  mp: 64,
  mf: 76,
  f: 90,
  ff: 104,
  fff: 118,
};
const ACCENTED_DYNAMICS: Partial<Record<Dynamic, number>> = { sf: 108, sfz: 110, sffz: 120, fz: 108, rf: 100, rfz: 104, fp: 100 };

function endingNumbers(text: string): number[] {
  return text
    .split(/[,\s]+/)
    .flatMap((part) => {
      const range = /^(\d+)\s*-\s*(\d+)$/.exec(part);
      if (range) {
        const out: number[] = [];
        for (let i = Number(range[1]); i <= Number(range[2]); i++) out.push(i);
        return out;
      }
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? [n] : [];
    });
}

/** Measure indexes in the order they are played, following repeats and first/second endings. */
export function playbackOrder(measures: MeasureInfo[]): number[] {
  const order: number[] = [];
  const passes = new Map<number, number>();
  let sectionStart = 0;
  let pass = 1;
  let jumped = false;
  let i = 0;
  const limit = measures.length * 16 + 16;
  while (i < measures.length && order.length < limit) {
    const info = measures[i]!;
    if (info.repeatStart && !jumped) {
      sectionStart = i;
      pass = 1;
    }
    jumped = false;
    if (info.ending?.start) {
      const numbers = endingNumbers(info.ending.number);
      if (numbers.length && !numbers.includes(pass)) {
        let j = i;
        while (j < measures.length - 1 && !measures[j]!.ending?.stop) j++;
        i = j + 1;
        continue;
      }
    }
    order.push(i);
    if (info.repeatEnd) {
      const times = info.repeatEnd.times ?? 2;
      const done = passes.get(i) ?? 1;
      if (done < times) {
        passes.set(i, done + 1);
        pass = done + 1;
        i = sectionStart;
        jumped = true;
        continue;
      }
      // Last time through: a new section starts after this bar.
      sectionStart = i + 1;
      pass = 1;
    } else if (info.ending?.stop && pass > 1) {
      // The last ending of a repeated section (its repeat sign was in an earlier ending, skipped
      // this time): carry on with a new section.
      sectionStart = i + 1;
      pass = 1;
    }
    i++;
  }
  return order;
}

export function quarterBpm(tempo: MeasureInfo["tempo"]): number | undefined {
  if (!tempo) return undefined;
  return toNumber(mul(frac(tempo.bpm), div(durationValue({ type: tempo.beatUnit, dots: tempo.beatUnitDots ?? 0 }), frac(1, 4))));
}

/** Turn the score into timed notes for playback and MIDI. */
export function buildPerformance(score: Score, options: PerformanceOptions = {}): Performance {
  const order = options.expandRepeats === false ? score.measures.map((_, i) => i) : playbackOrder(score.measures);
  const lengths = measureLengths(score);
  const times = timeSignatures(score);
  const scale = options.tempoScale && options.tempoScale > 0 ? options.tempoScale : 1;
  const parts = score.parts
    .map((part, index) => ({ part, index }))
    .filter(({ part }) => !options.partIds || options.partIds.includes(part.id));

  const notes: PerformanceNote[] = [];
  const measures: PlayedMeasure[] = [];
  const tempos: Performance["tempos"] = [];
  const timeSigs: Performance["timeSignatures"] = [];

  let bpm = options.defaultQuarterBpm ?? 100;
  // Tempo in force before the first played bar: the last marking at or before it.
  for (let i = 0; i <= (order[0] ?? 0); i++) bpm = quarterBpm(score.measures[i]?.tempo) ?? bpm;

  let timeSec = 0;
  let whole = 0;
  const dynamics = new Map<string, number>();
  const openTies = new Map<string, PerformanceNote>();

  for (const m of order) {
    const info = score.measures[m]!;
    bpm = quarterBpm(info.tempo) ?? bpm;
    const secondsPerWhole = (4 * 60) / (bpm * scale);
    if (tempos.length === 0 || tempos[tempos.length - 1]!.quarterBpm !== bpm) {
      tempos.push({ startWhole: whole, start: timeSec, quarterBpm: bpm });
    }
    const time = times[m]!;
    const lastSig = timeSigs[timeSigs.length - 1];
    if (!lastSig || lastSig.beats !== time.beats || lastSig.beatType !== time.beatType) {
      timeSigs.push({ startWhole: whole, beats: time.beats, beatType: time.beatType });
    }
    const length = lengths[m]!;
    // A pickup or short bar lasts as long as its longest voice.
    let actualLength = length;
    if (info.implicit) {
      let longest: Fraction = frac(0);
      for (const { part } of parts) {
        for (const voice of part.measures[m]?.voices ?? []) {
          const onsets = eventOnsets(voice, length);
          const last = voice.events.length - 1;
          if (last >= 0) {
            const end = toNumber(onsets[last]!) + toNumber(eventValue(voice.events[last]!, length));
            if (end > toNumber(longest)) longest = frac(Math.round(end * 1e6), 1e6);
          }
        }
      }
      if (longest.n > 0 && lte(longest, length)) actualLength = longest;
    }
    const measureSeconds = toNumber(actualLength) * secondsPerWhole;
    measures.push({ measureIndex: m, start: timeSec, duration: measureSeconds, startWhole: whole });

    for (const { part, index: partIndex } of parts) {
      const pm = part.measures[m];
      if (!pm) continue;
      const directions = [...(pm.directions ?? [])].sort((a, b) => cmp(a.offset, b.offset));
      for (const voice of pm.voices) {
        const dynKey = `${partIndex}/${voice.staff}`;
        const onsets = eventOnsets(voice, length);
        let inSlur = false;
        voice.events.forEach((event, i) => {
          const onset = onsets[i]!;
          let accentVelocity: number | undefined;
          for (const d of directions) {
            if (d.kind !== "dynamic" || d.staff !== voice.staff || cmp(d.offset, onset) > 0) continue;
            if (cmp(d.offset, onset) === 0 && ACCENTED_DYNAMICS[d.value]) accentVelocity = ACCENTED_DYNAMICS[d.value];
            const level = DYNAMIC_VELOCITY[d.value] ?? (d.value === "fp" ? DYNAMIC_VELOCITY.p : undefined);
            if (level) dynamics.set(dynKey, level);
          }
          if (event.kind !== "note") return;
          if (event.slurs?.some((s) => s.type === "start")) inSlur = true;
          const value = toNumber(eventValue(event, length));
          const startSec = timeSec + toNumber(onset) * secondsPerWhole;
          const startWhole = whole + toNumber(onset);
          const articulations = event.articulations ?? [];
          let gate = inSlur ? 1 : 0.92;
          if (articulations.includes("staccato")) gate = 0.5;
          if (articulations.includes("staccatissimo")) gate = 0.3;
          if (articulations.includes("tenuto")) gate = 1;
          let velocity = accentVelocity ?? dynamics.get(dynKey) ?? 76;
          if (articulations.includes("accent")) velocity += 14;
          if (articulations.includes("marcato")) velocity += 20;
          velocity = Math.max(1, Math.min(127, velocity));

          for (const note of event.notes) {
            const midi = midiNumber(note.pitch);
            const tieKey = `${partIndex}/${voice.staff}/${voice.voice}/${midi}`;
            if (event.grace) {
              const graceLength = Math.min(0.08, (60 / bpm) * 0.25);
              notes.push({
                partIndex,
                partId: part.id,
                midi,
                start: Math.max(0, startSec - graceLength),
                duration: graceLength * 0.9,
                startWhole: Math.max(0, startWhole - graceLength / secondsPerWhole),
                durationWhole: (graceLength * 0.9) / secondsPerWhole,
                velocity,
                noteIds: [note.id],
                eventIds: [event.id],
                measureIndex: m,
              });
              continue;
            }
            const open = note.tie?.stop ? openTies.get(tieKey) : undefined;
            if (open) {
              open.duration = startSec + value * secondsPerWhole * gate - open.start;
              open.durationWhole = startWhole + value * gate - open.startWhole;
              open.noteIds.push(note.id);
              open.eventIds.push(event.id);
              if (!note.tie?.start) openTies.delete(tieKey);
              continue;
            }
            const played: PerformanceNote = {
              partIndex,
              partId: part.id,
              midi,
              start: startSec,
              duration: value * secondsPerWhole * gate,
              startWhole,
              durationWhole: value * gate,
              velocity,
              noteIds: [note.id],
              eventIds: [event.id],
              measureIndex: m,
            };
            notes.push(played);
            if (note.tie?.start) openTies.set(tieKey, played);
          }
          if (event.slurs?.some((s) => s.type === "stop")) inSlur = false;
        });
      }
    }
    timeSec += measureSeconds;
    whole += toNumber(actualLength);
  }
  notes.sort((a, b) => a.start - b.start || a.midi - b.midi);
  return { notes, measures, tempos, timeSignatures: timeSigs, duration: timeSec };
}
