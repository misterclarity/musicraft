/** Pitches, intervals and key signatures. Pitches keep their spelling (C# and Db are different). */

export type Step = "C" | "D" | "E" | "F" | "G" | "A" | "B";
export const STEPS: readonly Step[] = ["C", "D", "E", "F", "G", "A", "B"];
const STEP_SEMITONES = [0, 2, 4, 5, 7, 9, 11];

export interface Pitch {
  step: Step;
  /** Chromatic alteration: -2 double flat … +2 double sharp. */
  alter: number;
  /** Scientific octave: middle C is C4. */
  octave: number;
}

export interface Interval {
  /** Number of letter-name steps (a major third is 2). Negative means downwards. */
  diatonic: number;
  /** Number of semitones (a major third is 4). Negative means downwards. */
  chromatic: number;
}

export const stepIndex = (step: Step): number => STEPS.indexOf(step);

/** Position on the white-key line: C4 = 28. */
export function diatonicNumber(p: Pitch): number {
  return p.octave * 7 + stepIndex(p.step);
}

/** MIDI note number: C4 = 60. */
export function midiNumber(p: Pitch): number {
  return 12 * (p.octave + 1) + STEP_SEMITONES[stepIndex(p.step)]! + p.alter;
}

export function pitchFromDiatonic(diatonic: number, midi: number): Pitch {
  const octave = Math.floor(diatonic / 7);
  const step = STEPS[((diatonic % 7) + 7) % 7]!;
  const natural = 12 * (octave + 1) + STEP_SEMITONES[stepIndex(step)]!;
  return { step, alter: midi - natural, octave };
}

export function transposePitch(p: Pitch, iv: Interval): Pitch {
  return pitchFromDiatonic(diatonicNumber(p) + iv.diatonic, midiNumber(p) + iv.chromatic);
}

export function intervalBetween(from: Pitch, to: Pitch): Interval {
  return { diatonic: diatonicNumber(to) - diatonicNumber(from), chromatic: midiNumber(to) - midiNumber(from) };
}

export const samePitch = (a: Pitch, b: Pitch) => a.step === b.step && a.alter === b.alter && a.octave === b.octave;

const ACCIDENTAL_TEXT: Record<string, number> = {
  "": 0,
  n: 0,
  "♮": 0,
  "#": 1,
  "♯": 1,
  "##": 2,
  x: 2,
  "𝄪": 2,
  b: -1,
  "♭": -1,
  bb: -2,
  "𝄫": -2,
};

/** Parse "C4", "F#5", "Bb3", "Ebb2", "Cn4". */
export function parsePitch(text: string): Pitch {
  const m = /^\s*([A-Ga-g])(##|bb|#|b|x|n|♮|♯|♭|𝄪|𝄫)?(-?\d+)\s*$/.exec(text);
  if (!m) throw new Error(`Not a pitch: "${text}" (expected e.g. C4, F#5, Bb3)`);
  return { step: m[1]!.toUpperCase() as Step, alter: ACCIDENTAL_TEXT[m[2] ?? ""]!, octave: Number(m[3]) };
}

export function accidentalText(alter: number): string {
  if (alter === 0) return "";
  return alter > 0 ? "#".repeat(alter) : "b".repeat(-alter);
}

export function formatPitch(p: Pitch): string {
  return `${p.step}${accidentalText(p.alter)}${p.octave}`;
}

export function pitchClassName(p: Pick<Pitch, "step" | "alter">): string {
  return `${p.step}${accidentalText(p.alter)}`;
}

// ---------------------------------------------------------------------------
// Intervals
// ---------------------------------------------------------------------------

const PERFECT_CLASS = new Set([0, 3, 4]); // unison, fourth, fifth (0-based simple diatonic)

/** Parse "M2", "-P5", "+m3", "P8", "M9", "A4", "d5", "AA1". */
export function parseInterval(text: string): Interval {
  const m = /^\s*([+-])?\s*(AA|A|M|P|m|d|dd)(\d+)\s*$/.exec(text);
  if (!m) throw new Error(`Not an interval: "${text}" (expected e.g. M2, -P5, m3, P8)`);
  const sign = m[1] === "-" ? -1 : 1;
  const quality = m[2]!;
  const number = Number(m[3]);
  if (number < 1) throw new Error(`Interval number must be at least 1: "${text}"`);
  const diatonic = number - 1;
  const simple = diatonic % 7;
  const octaves = Math.floor(diatonic / 7);
  let adjust: number;
  if (PERFECT_CLASS.has(simple)) {
    const map: Record<string, number> = { P: 0, A: 1, AA: 2, d: -1, dd: -2 };
    if (!(quality in map)) throw new Error(`"${quality}" is not a valid quality for a ${number}: "${text}"`);
    adjust = map[quality]!;
  } else {
    const map: Record<string, number> = { M: 0, m: -1, A: 1, AA: 2, d: -2, dd: -3 };
    if (!(quality in map)) throw new Error(`"${quality}" is not a valid quality for a ${number}: "${text}"`);
    adjust = map[quality]!;
  }
  const chromatic = STEP_SEMITONES[simple]! + 12 * octaves + adjust;
  return { diatonic: sign * diatonic, chromatic: sign * chromatic };
}

export function intervalName(iv: Interval): string {
  const sign = iv.diatonic < 0 || (iv.diatonic === 0 && iv.chromatic < 0) ? -1 : 1;
  const diatonic = Math.abs(iv.diatonic);
  const chromatic = sign * iv.chromatic;
  const simple = diatonic % 7;
  const octaves = Math.floor(diatonic / 7);
  const adjust = chromatic - STEP_SEMITONES[simple]! - 12 * octaves;
  let quality: string;
  if (PERFECT_CLASS.has(simple)) {
    quality = { "-2": "dd", "-1": "d", "0": "P", "1": "A", "2": "AA" }[String(adjust)] ?? `?${adjust}`;
  } else {
    quality = { "-3": "dd", "-2": "d", "-1": "m", "0": "M", "1": "A", "2": "AA" }[String(adjust)] ?? `?${adjust}`;
  }
  return `${sign < 0 ? "-" : ""}${quality}${diatonic + 1}`;
}

const QUALITY_WORDS: Record<string, string> = {
  P: "perfect",
  M: "major",
  m: "minor",
  A: "augmented",
  d: "diminished",
  AA: "doubly augmented",
  dd: "doubly diminished",
};

function ordinal(n: number): string {
  if (n === 1) return "unison";
  const suffix = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";
  return `${n}${suffix}`;
}

/** "a major 2nd", "an octave", "an octave and a major 2nd" (direction not included). */
export function intervalWords(iv: Interval): string {
  const abs: Interval = iv.diatonic < 0 || (iv.diatonic === 0 && iv.chromatic < 0) ? negateInterval(iv) : iv;
  const octaves = Math.floor(abs.diatonic / 7);
  const simple: Interval = { diatonic: abs.diatonic - 7 * octaves, chromatic: abs.chromatic - 12 * octaves };
  const octaveText = octaves === 0 ? "" : octaves === 1 ? "an octave" : octaves === 2 ? "two octaves" : `${octaves} octaves`;
  if (simple.diatonic === 0 && simple.chromatic === 0) return octaveText || "a unison";
  const name = intervalName(simple);
  const match = /^(AA|dd|A|d|P|M|m)(\d+)$/.exec(name);
  const words = match ? `${QUALITY_WORDS[match[1]!]} ${ordinal(Number(match[2]))}` : name;
  const article = /^[aeiou]/.test(words) ? "an" : "a";
  return octaveText ? `${octaveText} and ${article} ${words}` : `${article} ${words}`;
}

export const negateInterval = (iv: Interval): Interval => ({ diatonic: -iv.diatonic, chromatic: -iv.chromatic });
export const addIntervals = (a: Interval, b: Interval): Interval => ({
  diatonic: a.diatonic + b.diatonic,
  chromatic: a.chromatic + b.chromatic,
});
export const UNISON: Interval = { diatonic: 0, chromatic: 0 };
export const OCTAVE: Interval = { diatonic: 7, chromatic: 12 };
export const isUnison = (iv: Interval) => iv.diatonic === 0 && iv.chromatic === 0;

/** How far an interval moves a key around the circle of fifths (a perfect fifth is +1, a major second +2). */
export function intervalFifths(iv: Interval): number {
  return 7 * iv.chromatic - 12 * iv.diatonic;
}

/** A diminished second: changes spelling without changing the sound (C# → Db). */
export const DIMINISHED_SECOND: Interval = { diatonic: 1, chromatic: 0 };

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

export type Mode = "major" | "minor";

export interface KeySignature {
  /** Sharps (positive) or flats (negative): G major = 1, F major = -1. */
  fifths: number;
  mode?: Mode;
}

const MAJOR_TONICS = ["Cb", "Gb", "Db", "Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#"];
const MINOR_TONICS = ["Ab", "Eb", "Bb", "F", "C", "G", "D", "A", "E", "B", "F#", "C#", "G#", "D#", "A#"];

export function keyName(key: KeySignature): string {
  const tonics = key.mode === "minor" ? MINOR_TONICS : MAJOR_TONICS;
  const tonic = tonics[key.fifths + 7];
  if (!tonic) return `${key.fifths > 0 ? key.fifths + " sharps" : -key.fifths + " flats"}`;
  return `${tonic} ${key.mode === "minor" ? "minor" : "major"}`;
}

/** Parse "Bb major", "F# minor", "Eb", "c minor", "C#m". */
export function parseKey(text: string): KeySignature {
  const m = /^\s*([A-Ga-g])(#|b|♯|♭)?\s*(major|minor|maj|min|m|M)?\s*$/.exec(text);
  if (!m) throw new Error(`Not a key: "${text}" (expected e.g. "Bb major" or "F# minor")`);
  const tonic = m[1]!.toUpperCase() + (m[2] === "♯" ? "#" : m[2] === "♭" ? "b" : (m[2] ?? ""));
  const word = m[3] ?? "";
  const mode: Mode = word === "minor" || word === "min" || word === "m" ? "minor" : "major";
  const tonics = mode === "minor" ? MINOR_TONICS : MAJOR_TONICS;
  const index = tonics.indexOf(tonic);
  if (index < 0) throw new Error(`Unsupported key: "${text}"`);
  return { fifths: index - 7, mode };
}

/** The tonic of a key (letter and accidental). */
export function keyTonic(key: KeySignature): Pick<Pitch, "step" | "alter"> {
  const name = (key.mode === "minor" ? MINOR_TONICS : MAJOR_TONICS)[key.fifths + 7] ?? "C";
  const accidental = name.slice(1);
  return { step: name[0] as Step, alter: accidental === "#" ? 1 : accidental === "b" ? -1 : 0 };
}

/** The interval that moves one key's tonic to another's, upwards, downwards or the nearest way. */
export function intervalToKey(from: KeySignature, to: KeySignature, direction: "up" | "down" | "nearest" = "nearest"): Interval {
  const a = keyTonic(from);
  const b = keyTonic(to);
  let iv = intervalBetween({ ...a, octave: 4 }, { ...b, octave: 4 });
  if (iv.chromatic < 0 || (iv.chromatic === 0 && iv.diatonic < 0)) iv = addIntervals(iv, OCTAVE);
  if (direction === "down" && !isUnison(iv)) iv = addIntervals(iv, negateInterval(OCTAVE));
  if (direction === "nearest" && iv.chromatic > 6) iv = addIntervals(iv, negateInterval(OCTAVE));
  return iv;
}

/**
 * Spell a MIDI pitch for a key: notes of the key first, then naturals, then sharps (going up) or
 * flats (going down).
 */
export function spellMidi(midi: number, keyFifths: number, prefer: "sharp" | "flat" = "sharp"): Pitch {
  const alterations = keyAlterations(keyFifths);
  const octaveGuess = Math.floor(midi / 12) - 1;
  let best: Pitch | undefined;
  let bestScore = Infinity;
  for (const step of STEPS) {
    for (let octave = octaveGuess - 1; octave <= octaveGuess + 1; octave++) {
      const alter = midi - midiNumber({ step, alter: 0, octave });
      if (Math.abs(alter) > 2) continue;
      let score: number;
      if (alter === alterations[step]) score = 0;
      else if (alter === 0) score = 1;
      else if ((alter > 0 && prefer === "sharp") || (alter < 0 && prefer === "flat")) score = Math.abs(alter) === 1 ? 2 : 6;
      else score = Math.abs(alter) === 1 ? 3 : 7;
      if (score < bestScore) {
        best = { step, alter, octave };
        bestScore = score;
      }
    }
  }
  return best!;
}

/** Other spellings of the same sound (C# → Db → B##…), at most double sharps/flats. */
export function enharmonics(p: Pitch): Pitch[] {
  const midi = midiNumber(p);
  const result: Pitch[] = [];
  for (const step of STEPS) {
    for (let octave = p.octave - 1; octave <= p.octave + 1; octave++) {
      const alter = midi - midiNumber({ step, alter: 0, octave });
      if (Math.abs(alter) <= 2) result.push({ step, alter, octave });
    }
  }
  return result.sort((a, b) => Math.abs(a.alter) - Math.abs(b.alter) || diatonicNumber(a) - diatonicNumber(b));
}

const SHARP_ORDER: Step[] = ["F", "C", "G", "D", "A", "E", "B"];
const FLAT_ORDER: Step[] = ["B", "E", "A", "D", "G", "C", "F"];

/** The alteration a key signature gives each letter name. */
export function keyAlterations(fifths: number): Record<Step, number> {
  const result: Record<Step, number> = { C: 0, D: 0, E: 0, F: 0, G: 0, A: 0, B: 0 };
  if (fifths > 0) {
    for (let i = 0; i < Math.min(fifths, 14); i++) result[SHARP_ORDER[i % 7]!] += 1;
  } else if (fifths < 0) {
    for (let i = 0; i < Math.min(-fifths, 14); i++) result[FLAT_ORDER[i % 7]!] -= 1;
  }
  return result;
}

/**
 * Pick the spelling of a transposition so the resulting key is readable: C# major (7 sharps)
 * becomes Db major (5 flats). Returns the interval to use for the notes and the resulting key.
 */
export function transposeKey(key: KeySignature, iv: Interval): { key: KeySignature; interval: Interval } {
  const candidates = [iv, addIntervals(iv, DIMINISHED_SECOND), addIntervals(iv, negateInterval(DIMINISHED_SECOND))];
  let best = candidates[0]!;
  let bestFifths = key.fifths + intervalFifths(best);
  for (const candidate of candidates.slice(1)) {
    const fifths = key.fifths + intervalFifths(candidate);
    if (Math.abs(fifths) < Math.abs(bestFifths) && Math.abs(bestFifths) > 6) {
      best = candidate;
      bestFifths = fifths;
    }
  }
  return { key: { fifths: bestFifths, mode: key.mode }, interval: best };
}
