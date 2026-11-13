/** Exact rational numbers for musical time. Durations are measured in whole notes (a quarter is 1/4). */
export interface Fraction {
  readonly n: number;
  readonly d: number;
}

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) [a, b] = [b, a % b];
  return a || 1;
}

export function lcm(a: number, b: number): number {
  return Math.abs((a / gcd(a, b)) * b);
}

export function frac(n: number, d = 1): Fraction {
  if (!Number.isInteger(n) || !Number.isInteger(d)) throw new Error(`Fraction parts must be integers: ${n}/${d}`);
  if (d === 0) throw new Error("Fraction with zero denominator");
  if (d < 0) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}

export const ZERO: Fraction = { n: 0, d: 1 };

export const add = (a: Fraction, b: Fraction): Fraction => frac(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a: Fraction, b: Fraction): Fraction => frac(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a: Fraction, b: Fraction): Fraction => frac(a.n * b.n, a.d * b.d);
export const div = (a: Fraction, b: Fraction): Fraction => {
  if (b.n === 0) throw new Error("Division by zero fraction");
  return frac(a.n * b.d, a.d * b.n);
};

export function cmp(a: Fraction, b: Fraction): -1 | 0 | 1 {
  const x = a.n * b.d - b.n * a.d;
  return x < 0 ? -1 : x > 0 ? 1 : 0;
}
export const eq = (a: Fraction, b: Fraction) => a.n === b.n && a.d === b.d;
export const lt = (a: Fraction, b: Fraction) => cmp(a, b) < 0;
export const lte = (a: Fraction, b: Fraction) => cmp(a, b) <= 0;
export const gt = (a: Fraction, b: Fraction) => cmp(a, b) > 0;
export const gte = (a: Fraction, b: Fraction) => cmp(a, b) >= 0;
export const isZero = (a: Fraction) => a.n === 0;
export const max = (a: Fraction, b: Fraction) => (gte(a, b) ? a : b);
export const min = (a: Fraction, b: Fraction) => (lte(a, b) ? a : b);
export const toNumber = (a: Fraction) => a.n / a.d;

export function sum(values: Iterable<Fraction>): Fraction {
  let total = ZERO;
  for (const v of values) total = add(total, v);
  return total;
}

export function fracToString(a: Fraction): string {
  return a.d === 1 ? String(a.n) : `${a.n}/${a.d}`;
}
