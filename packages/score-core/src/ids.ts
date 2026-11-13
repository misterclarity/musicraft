/** Element ids. They start with a letter so they are valid XML ids in exported MusicXML. */

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function randomId(prefix: string): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  let out = prefix;
  for (const b of bytes) out += ALPHABET[b % 36];
  return out;
}

export function newId(prefix: "s" | "p" | "m" | "e" | "n" | "d" | "x" = "x"): string {
  return randomId(prefix);
}
