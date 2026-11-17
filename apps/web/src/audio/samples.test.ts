import { INSTRUMENTS, midiNumber, transposePitch } from "@musicraft/score-core";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nearestNote, onsetOf, type Manifest } from "./samples";

// Tests run from apps/web.
const publicDir = join(process.cwd(), "public/samples/");
const manifest = JSON.parse(readFileSync(`${publicDir}manifest.json`, "utf8")) as Manifest;

describe("recorded notes", () => {
  it("plays the nearest recorded note, the one above when two are as near", () => {
    const notes = [{ midi: 60 }, { midi: 63 }, { midi: 66 }];
    expect(nearestNote(notes, 61).midi).toBe(60);
    expect(nearestNote(notes, 62).midi).toBe(63);
    expect(nearestNote(notes, 50).midi).toBe(60);
    expect(nearestNote([{ midi: 60 }, { midi: 64 }], 62).midi).toBe(64);
  });

  it("finds where a recording starts", () => {
    const samples = new Float32Array(1000);
    samples.fill(0.5, 100);
    expect(onsetOf(samples, 1000)).toBe(0.1);
    expect(onsetOf(new Float32Array(10), 1000)).toBe(0);
  });

  it("has a set for every instrument, with a note within a semitone of every note it can play", () => {
    for (const instrument of INSTRUMENTS) {
      const set = Object.values(manifest.sets).find((s) => s.program === instrument.midiProgram);
      expect(set, instrument.id).toBeDefined();
      const low = midiNumber(transposePitch(instrument.range.low, instrument.transposition));
      const high = midiNumber(transposePitch(instrument.range.high, instrument.transposition));
      for (let midi = low; midi <= high; midi++) {
        expect(Math.abs(nearestNote(set!.notes, midi).midi - midi), `${instrument.id} ${midi}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("lists files that are there, and loops inside the sustained notes", () => {
    for (const [name, set] of Object.entries(manifest.sets)) {
      for (const note of set.notes) {
        expect(existsSync(`${publicDir}${note.file}`), note.file).toBe(true);
        if (set.sustains) {
          expect(note.loop, `${name} ${note.midi}`).toBeDefined();
          expect(note.loop![0]).toBeGreaterThan(note.onset);
          expect(note.loop![1] - note.loop![0]).toBeGreaterThan(0.3);
        } else {
          expect(note.loop).toBeUndefined();
        }
      }
    }
  });
});
