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
  /** Seconds from the start. */
  start: number;
  duration: number;
  startWhole: number;
  /** Whole notes the bar lasts as played (a pickup can be shorter than its time signature). */
  length: number;
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
    measures.push({ measureIndex: m, start: timeSec, duration: measureSeconds, startWhole: whole, length: toNumber(actualLength) });

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

// ---------------------------------------------------------------------------
// Practising: metronome, count-in and loops
// ---------------------------------------------------------------------------

export interface Click {
  /** Seconds from the start of the performance (before 0 for a count-in at the start). */
  time: number;
  /** The first beat of a bar, clicked louder. */
  downbeat: boolean;
}

/** The beat a metronome clicks in a time signature (whole notes), and how many a full bar has. */
function beatOf(time: { beats: number; beatType: number }): { beat: number; perBar: number } {
  // Compound time (6/8, 9/8, 12/8) is counted in dotted quarters.
  const compound = time.beatType === 8 && time.beats % 3 === 0 && time.beats > 3;
  return compound ? { beat: 3 / time.beatType, perBar: time.beats / 3 } : { beat: 1 / time.beatType, perBar: Math.max(1, time.beats) };
}

/** The beats of a played bar, and where its first one falls in a full bar (a pickup starts late). */
function barBeats(score: Score, performance: Performance, index: number) {
  const bar = performance.measures[index]!;
  const { beat, perBar } = beatOf(timeSignatures(score)[bar.measureIndex] ?? { beats: 4, beatType: 4 });
  const count = Math.max(1, Math.round(bar.length / beat));
  const first = index === 0 && count < perBar ? perBar - count : 0;
  const seconds = bar.length > 0 ? (bar.duration / bar.length) * beat : 0;
  return { bar, perBar, count, first, seconds };
}

/**
 * The beats a metronome clicks through a performance: quarter notes in 4/4, half notes in 2/2,
 * dotted quarters in 6/8 and 12/8, eighths in 5/8. A pickup has the last beats of a full bar.
 */
export function metronomeClicks(score: Score, performance: Performance): Click[] {
  const clicks: Click[] = [];
  performance.measures.forEach((_, i) => {
    const { bar, perBar, count, first, seconds } = barBeats(score, performance, i);
    if (bar.length <= 0) return;
    for (let k = 0; k < count; k++) clicks.push({ time: bar.start + k * seconds, downbeat: (first + k) % perBar === 0 });
  });
  return clicks;
}

/**
 * The clicks that count in before playing from a played bar: a full bar of beats at its tempo, or
 * the beats before a pickup ("1, 2, 3" before a pickup on 4); a bar more when that would be fewer
 * than three clicks (2/2, 6/8).
 */
export function countInClicks(score: Score, performance: Performance, index: number): Click[] {
  if (!performance.measures[index]) return [];
  const { bar, perBar, first, seconds } = barBeats(score, performance, index);
  const beat = seconds > 0 ? seconds : 0.6;
  let before = first;
  while (before < 3) before += perBar;
  return Array.from({ length: before }, (_, k) => ({
    time: bar.start - (before - k) * beat,
    downbeat: (((first - before + k) % perBar) + perBar) % perBar === 0,
  }));
}

/** Where bars `from` to `to` of the score play (the first time through), in seconds and played bars. */
export function playedRange(performance: Performance, from: number, to: number): { start: number; end: number; firstBar: number; lastBar: number } | null {
  const bars = performance.measures;
  const first = bars.findIndex((m) => m.measureIndex === from);
  if (first < 0) return null;
  let last = -1;
  for (let k = first; k < bars.length && last < 0; k++) if (bars[k]!.measureIndex === to) last = k;
  if (last < 0) return null;
  return { start: bars[first]!.start, end: bars[last]!.start + bars[last]!.duration, firstBar: first, lastBar: last };
}
