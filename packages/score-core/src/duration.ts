import { add, cmp, frac, mul, sub, ZERO, type Fraction } from "./fraction";

export type NoteType = "breve" | "whole" | "half" | "quarter" | "eighth" | "16th" | "32nd" | "64th" | "128th";

export const NOTE_TYPES: readonly NoteType[] = [
  "breve",
  "whole",
  "half",
  "quarter",
  "eighth",
  "16th",
  "32nd",
  "64th",
  "128th",
];

/** Value of each undotted note type, in whole notes. */
export const TYPE_VALUE: Record<NoteType, Fraction> = {
  breve: frac(2),
  whole: frac(1),
  half: frac(1, 2),
  quarter: frac(1, 4),
  eighth: frac(1, 8),
  "16th": frac(1, 16),
  "32nd": frac(1, 32),
  "64th": frac(1, 64),
  "128th": frac(1, 128),
};

/** The usual short names: 1 = whole, 2 = half, 4 = quarter … */
export const TYPE_DENOMINATOR: Record<NoteType, number> = {
  breve: 0,
  whole: 1,
  half: 2,
  quarter: 4,
  eighth: 8,
  "16th": 16,
  "32nd": 32,
  "64th": 64,
  "128th": 128,
};

export interface Tuplet {
  /** Notes played … */
  actual: number;
  /** … in the time of: a triplet is 3 in the time of 2. */
  normal: number;
}

export interface Duration {
  type: NoteType;
  dots: number;
  tuplet?: Tuplet;
}

export function durationValue(d: Duration): Fraction {
  let value = TYPE_VALUE[d.type];
  let extra = TYPE_VALUE[d.type];
  for (let i = 0; i < d.dots; i++) {
    extra = mul(extra, frac(1, 2));
    value = add(value, extra);
  }
  if (d.tuplet) value = mul(value, frac(d.tuplet.normal, d.tuplet.actual));
  return value;
}

export function typeFromDenominator(denominator: number): NoteType | undefined {
  return (Object.keys(TYPE_DENOMINATOR) as NoteType[]).find((t) => TYPE_DENOMINATOR[t] === denominator);
}

/** A single (possibly dotted) note for exactly this value, without tuplets, or undefined. */
export function durationFromValue(value: Fraction, maxDots = 3): Duration | undefined {
  for (const type of NOTE_TYPES) {
    for (let dots = 0; dots <= maxDots; dots++) {
      if (cmp(durationValue({ type, dots }), value) === 0) return { type, dots };
    }
  }
  return undefined;
}

const isBinary = (f: Fraction) => f.d > 0 && (f.d & (f.d - 1)) === 0;

/** Greedy split of a value with a power-of-two denominator into (dotted) notes, largest first. */
function splitBinary(value: Fraction, allowDots: boolean): Duration[] {
  const result: Duration[] = [];
  let rest = value;
  let guard = 0;
  while (cmp(rest, ZERO) > 0 && guard++ < 64) {
    let picked: Duration | undefined;
    for (const type of NOTE_TYPES) {
      for (let dots = allowDots ? 2 : 0; dots >= 0; dots--) {
        const d = { type, dots };
        if (cmp(durationValue(d), rest) <= 0) {
          picked = d;
          break;
        }
      }
      if (picked) break;
    }
    if (!picked) break;
    result.push(picked);
    rest = sub(rest, durationValue(picked));
  }
  return result;
}

const TUPLET_RATIOS: [number, number][] = [
  [3, 2],
  [5, 4],
  [6, 4],
  [7, 4],
  [9, 8],
];

/**
 * Split a value into notes that can be tied together, largest first. Values that need tuplets
 * (e.g. 1/12, a triplet eighth) are written as tuplet notes. Returns [] for zero.
 */
export function splitValue(value: Fraction, allowDots = true): Duration[] {
  if (cmp(value, ZERO) <= 0) return [];
  if (isBinary(value)) return splitBinary(value, allowDots);
  for (const [actual, normal] of TUPLET_RATIOS) {
    const scaled = mul(value, frac(actual, normal));
    if (isBinary(scaled)) {
      return splitBinary(scaled, allowDots).map((d) => ({ ...d, tuplet: { actual, normal } }));
    }
  }
  // Rare odd values: one note with an exact (unusual) tuplet ratio, so timing is never lost.
  return [exactDuration(value)];
}

/** A single note value of exactly this length, using an arbitrary tuplet ratio if needed. */
export function exactDuration(value: Fraction): Duration {
  const plain = durationFromValue(value);
  if (plain) return plain;
  // The shortest note type at least as long as the value, scaled by normal/actual.
  let type: NoteType = "breve";
  for (const t of NOTE_TYPES) if (cmp(TYPE_VALUE[t], value) >= 0) type = t;
  const ratio = frac(value.n * TYPE_VALUE[type].d, value.d * TYPE_VALUE[type].n);
  return { type, dots: 0, tuplet: { actual: ratio.d, normal: ratio.n } };
}

export function durationLabel(d: Duration): string {
  const base = TYPE_DENOMINATOR[d.type] === 0 ? "breve" : `1/${TYPE_DENOMINATOR[d.type]}`;
  const dots = ".".repeat(d.dots);
  const tuplet = d.tuplet ? ` (${d.tuplet.actual}:${d.tuplet.normal})` : "";
  return `${base}${dots}${tuplet}`;
}
