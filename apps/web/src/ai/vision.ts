/** Images of the original scanned pages for the assistant: crops of the systems that hold some bars. */
import { aiBarLabels, barIndex, type Score } from "@musicraft/score-core";
import type { PageRecord } from "../lib/db";
import type { BrowserTool } from "./agent";

export interface SystemCrop {
  page: number;
  /** First and last measure index in the crop. */
  measures: [number, number];
  /** Normalised box on the page. */
  box: { x: number; y: number; width: number; height: number };
}

/** The systems (lines of music) of the scanned pages, with the bars each one holds. */
export function pageSystems(pages: PageRecord[], measureCount: number): SystemCrop[] {
  const systems: SystemCrop[] = [];
  pages.forEach((page, pageIndex) => {
    const layout = page.layout;
    if (!layout?.measureRange) return;
    const [first, last] = layout.measureRange;
    const starts = layout.systemStarts?.length ? layout.systemStarts : [0];
    const perSystem = Math.max(1, layout.staffsPerSystem ?? 1);
    starts.forEach((start, i) => {
      const from = first + start;
      const to = i + 1 < starts.length ? first + starts[i + 1]! - 1 : last;
      const staffs = layout.staffs.slice(i * perSystem, i * perSystem + perSystem);
      if (!staffs.length || from > to || from >= measureCount) return;
      const x = Math.min(...staffs.map((s) => s.x));
      const y = Math.min(...staffs.map((s) => s.y));
      const right = Math.max(...staffs.map((s) => s.x + s.width));
      const bottom = Math.max(...staffs.map((s) => s.y + s.height));
      // Room above and below the staves for ledger lines, dynamics and text.
      const pad = Math.max(0.02, (bottom - y) * 0.6);
      const box = {
        x: Math.max(0, x - 0.02),
        y: Math.max(0, y - pad),
        width: Math.min(1, right + 0.02) - Math.max(0, x - 0.02),
        height: Math.min(1, bottom + pad) - Math.max(0, y - pad),
      };
      systems.push({ page: pageIndex, measures: [from, Math.min(to, measureCount - 1)], box });
    });
  });
  return systems;
}

/** Crop part of a page image to a JPEG data URL no wider than maxWidth. */
export async function cropPage(page: PageRecord, box: SystemCrop["box"], maxWidth = 1400): Promise<string> {
  const bitmap = await createImageBitmap(page.blob);
  try {
    const sx = Math.round(box.x * bitmap.width);
    const sy = Math.round(box.y * bitmap.height);
    const sw = Math.max(1, Math.round(box.width * bitmap.width));
    const sh = Math.max(1, Math.round(box.height * bitmap.height));
    const scale = Math.min(1, maxWidth / sw);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(sw * scale);
    canvas.height = Math.round(sh * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("This browser can't draw images.");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    bitmap.close();
  }
}

const WHOLE_PAGE = { x: 0, y: 0, width: 1, height: 1 };

/** The look_at_page tool: crops of the systems that contain some bars. */
export function lookAtPageTool(pages: PageRecord[]): BrowserTool {
  return {
    name: "look_at_page",
    description:
      "See the original scanned page for some bars (an image of those lines of music), to compare the recognised notes with the printed ones. The printed notes are written pitch.",
    parameters: {
      type: "object",
      properties: {
        from: { anyOf: [{ type: "integer" }, { type: "string" }], description: "First bar" },
        to: { anyOf: [{ type: "integer" }, { type: "string" }], description: "Last bar (default: same as from)" },
      },
      required: ["from"],
    },
    async run(args, score: Score) {
      const a = args as { from?: string | number; to?: string | number };
      if (a.from === undefined) return { error: true, result: "Error: give the first bar (from)." };
      let from: number;
      let to: number;
      try {
        from = barIndex(score, a.from);
        to = a.to === undefined ? from : barIndex(score, a.to);
      } catch (err) {
        return { error: true, result: `Error: ${(err as Error).message}` };
      }
      if (to < from) [from, to] = [to, from];
      const systems = pageSystems(pages, score.measures.length).filter((s) => s.measures[1] >= from && s.measures[0] <= to);
      const labels = aiBarLabels(score);
      if (!systems.length) {
        if (!pages.length) return { error: true, result: "Error: this score has no scanned pages." };
        // No layout information: show the first page whole.
        const image = await cropPage(pages[0]!, WHOLE_PAGE, 1600);
        return { result: "The page layout is unknown; here is page 1 whole.", images: [image] };
      }
      const chosen = systems.slice(0, 3);
      const images = await Promise.all(chosen.map((s) => cropPage(pages[s.page]!, s.box)));
      const described = chosen.map((s) => `page ${s.page + 1}, bars ${labels[s.measures[0]]}–${labels[s.measures[1]]}`).join("; ");
      const more = systems.length > chosen.length ? ` (${systems.length - chosen.length} more lines not shown; ask for fewer bars)` : "";
      return { result: `Showing ${chosen.length} line${chosen.length > 1 ? "s" : ""} of music: ${described}${more}.`, images };
    },
  };
}
