import { INSTRUMENTS, midiNumber, transposePitch } from "@musicraft/score-core";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decoderDelay, ENCODER_DELAY, layerFor, nearestNote, onsetOf, type Manifest } from "./samples";

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

  it("plays the soft recording up to mf and the loud one from f", () => {
    const layers = [{ velocity: 60 }, { velocity: 105 }];
    // Velocities of the dynamics: p 50, mf 76, f 90, ff 104.
    expect([50, 76, 90, 104].map((v) => layerFor(layers, v).velocity)).toEqual([60, 60, 105, 105]);
    expect(layerFor([{ velocity: 80 }], 30).velocity).toBe(80);
  });

  it("moves the loop only for a decoder that left the encoder's delay in", () => {
    expect(decoderDelay(0.0005, 0.0005)).toBe(0);
    // The codec blurs an attack by a few milliseconds: not a delay.
    expect(decoderDelay(0.0032, 0.0005)).toBe(0);
    expect(decoderDelay(0.0005, 0.0032)).toBe(0);
    expect(decoderDelay(0.0255, 0.0005)).toBe(ENCODER_DELAY);
  });

  it("finds where a recording starts", () => {
    const samples = new Float32Array(1000);
    samples.fill(0.5, 100);
    expect(onsetOf(samples, 1000)).toBe(0.1);
    expect(onsetOf(new Float32Array(10), 1000)).toBe(0);
  });

  it("has a set for every instrument, with a recording within three semitones of every note it can play, at every dynamic", () => {
    for (const instrument of INSTRUMENTS) {
      const set = Object.values(manifest.sets).find((s) => s.program === instrument.midiProgram);
      expect(set, instrument.id).toBeDefined();
      const low = midiNumber(transposePitch(instrument.range.low, instrument.transposition));
      const high = midiNumber(transposePitch(instrument.range.high, instrument.transposition));
      for (const layer of set!.layers) {
        for (let midi = low; midi <= high; midi++) {
          expect(Math.abs(nearestNote(layer.notes, midi).midi - midi), `${instrument.id} ${midi} at ${layer.velocity}`).toBeLessThanOrEqual(3);
        }
      }
    }
  });

  it("lists files that are there, tunings within a quarter tone, and loops inside the sustained notes", () => {
    for (const [name, set] of Object.entries(manifest.sets)) {
      expect(set.layers.length, name).toBeGreaterThanOrEqual(1);
      expect(set.sources?.length, name).toBeGreaterThanOrEqual(1);
      for (const note of set.layers.flatMap((l) => l.notes)) {
        expect(existsSync(`${publicDir}${note.file}`), note.file).toBe(true);
        expect(Math.abs(note.cents ?? 0), note.file).toBeLessThanOrEqual(60);
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

  it("uses real recordings for every instrument the free libraries have", () => {
    const recorded = Object.entries(manifest.sets)
      .filter(([, set]) => set.sources?.some((s) => s.includes("CC0")))
      .map(([name]) => name);
    expect(recorded).toEqual(
      expect.arrayContaining(["trumpet", "trombone", "tuba", "horn", "flute", "oboe", "clarinet", "bassoon", "tenor-sax", "violin", "viola", "cello", "double-bass", "piano", "organ"]),
    );
  });
});
