/**
 * Optional robustness test over a folder of real-world MusicXML files (not part of the repository).
 * Run with: MUSICRAFT_CORPUS_DIR=/path/to/files npx vitest run test/corpus.test.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkScore,
  durationValue,
  exportMidi,
  exportMusicXml,
  formatPitch,
  fracToString,
  importMusicFile,
  importMusicXml,
  type Score,
} from "../src";
import { printBars, writeBars } from "../src/ai/notation";
import { parser } from "./helpers";

const dir = process.env.MUSICRAFT_CORPUS_DIR;

function walk(path: string): string[] {
  return readdirSync(path).flatMap((name) => {
    const full = join(path, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function signature(score: Score): string[] {
  return score.parts.map((part) =>
    part.measures
      .map((pm) =>
        [...pm.voices]
          .sort((a, b) => a.staff - b.staff || a.voice - b.voice)
          .map((v) =>
            v.events
              .filter((e) => !(e.kind === "rest" && e.hidden))
              .map((e) =>
                e.kind === "note"
                  ? `${e.notes.map((n) => formatPitch(n.pitch)).join("+")}:${e.grace ? "grace" : fracToString(durationValue(e.duration))}`
                  : `r:${e.measureRest ? "M" : fracToString(durationValue(e.duration))}`,
              )
              .join(" "),
          )
          .join(" | "),
      )
      .join("\n"),
  );
}

describe.skipIf(!dir)("corpus round trip", () => {
  it("imports, exports and re-imports every score unchanged", () => {
    const files = walk(dir!).filter((f) => /\.(mxl|musicxml|xml)$/i.test(f));
    const failures: string[] = [];
    let scores = 0;
    let issues = 0;
    let warnings = 0;
    const warningKinds = new Map<string, number>();
    const issueKinds = new Map<string, number>();
    for (const file of files) {
      const data = new Uint8Array(readFileSync(file));
      if (!file.endsWith(".mxl") && !new TextDecoder().decode(data.subarray(0, 4000)).includes("<score-partwise")) continue;
      try {
        const result = importMusicFile(data, { parser });
        scores++;
        warnings += result.warnings.length;
        for (const w of result.warnings) {
          const kind = w.replace(/"[^"]*"/g, '"…"').replace(/\d+/g, "#");
          warningKinds.set(kind, (warningKinds.get(kind) ?? 0) + 1);
        }
        const xml = exportMusicXml(result.score);
        const again = importMusicXml(xml, { parser }).score;
        const a = signature(result.score);
        const b = signature(again);
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          const p = a.findIndex((x, i) => x !== b[i]);
          const lines = a[p]!.split("\n");
          const linesB = b[p]!.split("\n");
          const m = lines.findIndex((x, i) => x !== linesB[i]);
          failures.push(`${file}: part ${p} bar ${m + 1}\n  before: ${lines[m]}\n  after:  ${linesB[m]}`);
        }
        const found = checkScore(result.score, { comfortableRange: false });
        issues += found.length;
        for (const i of found) {
          const inst = result.score.parts.find((p) => p.id === i.partId)?.instrument ?? "?";
          const key = i.code === "out-of-range" ? `${i.code} ${inst} ${/(below|above)/.exec(i.message)?.[0]}` : i.code;
          issueKinds.set(key, (issueKinds.get(key) ?? 0) + 1);
        }
        exportMidi(result.score);
      } catch (err) {
        failures.push(`${file}: ${(err as Error).message}`);
      }
    }
    console.log(`${scores} scores, ${warnings} import warnings, ${issues} check issues, ${failures.length} failures`);
    console.log("warnings:", [...warningKinds.entries()].sort((a, b) => b[1] - a[1]));
    console.log("issues:", [...issueKinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25));
    if (failures.length) console.log(failures.slice(0, 30).join("\n"));
    expect(failures).toEqual([]);
  }, 900_000);

  it("prints every bar as AI notation and writes it back unchanged", () => {
    const files = walk(dir!).filter((f) => /\.(mxl|musicxml|xml)$/i.test(f));
    const failures: string[] = [];
    let bars = 0;
    for (const file of files) {
      const data = new Uint8Array(readFileSync(file));
      if (!file.endsWith(".mxl") && !new TextDecoder().decode(data.subarray(0, 4000)).includes("<score-partwise")) continue;
      let score: Score;
      try {
        score = importMusicFile(data, { parser }).score;
      } catch {
        continue;
      }
      const before = signature(score);
      score.parts.forEach((_, p) => {
        for (const frame of ["concert", "written"] as const) {
          const text = printBars(score, p, 0, score.measures.length - 1, frame).join("\n");
          try {
            const again = writeBars(score, p, text, frame).score;
            const after = signature(again);
            if (after[p] !== before[p]) {
              const a = before[p]!.split("\n");
              const b = after[p]!.split("\n");
              const m = a.findIndex((x, i) => x !== b[i]);
              // Some sources put two whole-bar rests in one voice; they come back as two rests.
              const junk = a.every((x, i) => x === b[i] || x.replace(/r:M/g, "r:1") === b[i]);
              if (!junk) failures.push(`${file} part ${p} ${frame} bar ${m + 1}\n  before: ${a[m]}\n  after:  ${b[m]}`);
            }
            const reprinted = printBars(again, p, 0, score.measures.length - 1, frame).join("\n");
            if (reprinted !== text) {
              const a = text.split("\n");
              const b = reprinted.split("\n");
              const i = a.findIndex((x, k) => x !== b[k]);
              failures.push(`${file} part ${p} ${frame} reprint\n  first:  ${a[i]}\n  second: ${b[i]}`);
            }
          } catch (err) {
            failures.push(`${file} part ${p} ${frame}: ${(err as Error).message}`);
          }
          bars += score.measures.length;
        }
      });
    }
    console.log(`${bars} bars written back, ${failures.length} failures`);
    const kinds = new Map<string, number>();
    for (const f of failures) {
      const kind = f.replace(/^\S+ /, "").replace(/\d+/g, "#").split("\n")[0]!;
      kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    }
    console.log([...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20));
    const shown = new Map<string, number>();
    for (const f of failures) {
      const kind = f.replace(/^\S+ /, "").replace(/\d+/g, "#").split("\n")[0]!;
      const n = shown.get(kind) ?? 0;
      if (n < 3) console.log(f);
      shown.set(kind, n + 1);
    }
    expect(failures).toEqual([]);
  }, 900_000);
});
