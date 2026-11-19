import { describe, expect, it } from "vitest";
import { idsIn, stableIds } from "./stableIds";

// A page as Verovio writes it: generated ids on the page, its glyphs, a slur and a page break.
const page = (doc: string, glyph: string, slur: string, start: string) =>
  `<svg id="${doc}"><defs><g id="E050-${doc}"><path d="M0 0"/></g></defs>` +
  `<style type="text/css">#${doc} g.tempo {font-weight:bold;} #${doc} g.cursor {fill:#1c7ed6;}</style>` +
  `<g id="mabcdefghij" class="measure"><g id="${glyph}" class="staff" data-n="1"><use href="#E050-${doc}"/></g>` +
  `<g id="eabcdefghij" class="note"/><g id="${slur}" class="slur id-${slur} spanning"/></g>` +
  `<g id="${start}" class="pageMilestoneEnd ${start}"/><a href="https://example.org/">link</a></svg>`;

describe("stable ids", () => {
  const keep = idsIn('<measure number="1" id="mabcdefghij"><note id="eabcdefghij"/></measure>');

  it("keeps the score's ids and renames Verovio's everywhere they are used", () => {
    const svg = stableIds(page("l19nj5e9", "s1x2y3z", "q9w8e7r", "p0o9i8u"), 3, keep);
    expect(svg).toContain('id="mabcdefghij"');
    expect(svg).toContain('id="eabcdefghij"');
    expect(svg).toContain('<svg id="v3-1">');
    expect(svg).toContain('<g id="v3-2"><path');
    expect(svg).toContain('<use href="#v3-2"/>');
    expect(svg).toContain("#v3-1 g.tempo");
    expect(svg).toContain('class="slur id-v3-4 spanning"');
    expect(svg).toContain('class="pageMilestoneEnd v3-5"');
    // Colours and links are not ids.
    expect(svg).toContain("fill:#1c7ed6");
    expect(svg).toContain('href="https://example.org/"');
    expect(svg).not.toMatch(/l19nj5e9|s1x2y3z|q9w8e7r|p0o9i8u/);
  });

  it("writes an unchanged page exactly as before, whatever ids Verovio generated this time", () => {
    const before = stableIds(page("l19nj5e9", "s1x2y3z", "q9w8e7r", "p0o9i8u"), 2, keep);
    const after = stableIds(page("k5j4h3g2", "a1b2c3d", "z9y8x7w", "c4v5b6n"), 2, keep);
    expect(after).toBe(before);
  });
});
