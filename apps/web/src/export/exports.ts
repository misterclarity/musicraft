import { exportMidi, exportMusicXml, exportMxl, prettyName, type Id, type Score } from "@musicraft/score-core";
import { downloadBlob, downloadBytes, downloadText, safeFileName } from "../lib/files";
import { PAGE_MM, printOptions, renderer, type PageSize } from "../render/renderer";

export type PitchMode = "written" | "concert";

export function downloadMusicXml(score: Score, name: string, pitch: PitchMode = "written") {
  const xml = exportMusicXml(score, { pitch, includeIds: false });
  downloadText(xml, `${safeFileName(name)}.musicxml`, "application/vnd.recordare.musicxml+xml");
}

export function downloadMxl(score: Score, name: string, pitch: PitchMode = "written") {
  downloadBytes(exportMxl(score, { pitch, includeIds: false }), `${safeFileName(name)}.mxl`, "application/vnd.recordare.musicxml");
}

export function downloadMidi(score: Score, name: string) {
  downloadBytes(exportMidi(score), `${safeFileName(name)}.mid`, "audio/midi");
}

export async function downloadMei(score: Score, name: string, pitch: PitchMode = "written") {
  const mei = await renderer.mei(exportMusicXml(score, { pitch, includeIds: false }));
  downloadText(mei, `${safeFileName(name)}.mei`, "application/mei+xml");
}

export interface PrintLayout {
  pageSize: PageSize;
  /** Verovio scale: 100 = 7.2 mm staves (parts), 70–85 for full scores. */
  staffSize: number;
  pitch: PitchMode;
}

/** Engrave printed pages as SVG strings. */
export async function engravePages(score: Score, layout: PrintLayout, partIds?: Id[]): Promise<string[]> {
  const xml = exportMusicXml(score, {
    pitch: layout.pitch,
    includeIds: false,
    partIds,
    multiRests: partIds?.length === 1,
  });
  return renderer.render(xml, printOptions(layout.pageSize, layout.staffSize));
}

function svgToImage(svg: string, widthPx: number, heightPx: number): Promise<HTMLCanvasElement> {
  // Give the SVG an explicit size so it rasterises at the requested resolution.
  const sized = svg.replace(/<svg\b/, `<svg width="${widthPx}" height="${heightPx}" preserveAspectRatio="xMidYMin meet"`);
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(new Blob([sized], { type: "image/svg+xml" }));
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = widthPx;
      canvas.height = heightPx;
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, widthPx, heightPx);
      ctx.drawImage(image, 0, 0, widthPx, heightPx);
      URL.revokeObjectURL(url);
      resolve(canvas);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("A page could not be drawn."));
    };
    image.src = url;
  });
}

/**
 * Build a PDF from engraved pages. Pages are drawn by the browser at 300 dpi so the result
 * looks exactly like the screen (including music symbols inside text such as tempo marks).
 */
export async function pagesToPdf(pages: string[][], pageSize: PageSize, onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const [wMm, hMm] = PAGE_MM[pageSize];
  const dpi = 300;
  const wPx = Math.round((wMm / 25.4) * dpi);
  const hPx = Math.round((hMm / 25.4) * dpi);
  // Loaded on demand: jsPDF is only needed when exporting.
  const { jsPDF } = await import("jspdf");
  const pdf = new jsPDF({ unit: "mm", format: pageSize, compress: true });
  const total = pages.reduce((n, group) => n + group.length, 0);
  let done = 0;
  let first = true;
  for (const group of pages) {
    for (let i = 0; i < group.length; i++) {
      if (!first) pdf.addPage(pageSize);
      first = false;
      const canvas = await svgToImage(group[i]!, wPx, hPx);
      pdf.addImage(canvas.toDataURL("image/jpeg", 0.9), "JPEG", 0, 0, wMm, hMm, undefined, "FAST");
      if (group.length > 1) {
        pdf.setFontSize(9);
        pdf.setTextColor(90);
        pdf.text(`${i + 1} / ${group.length}`, wMm / 2, hMm - 6, { align: "center" });
      }
      onProgress?.(++done, total);
    }
  }
  return pdf.output("blob");
}

export async function downloadScorePdf(score: Score, name: string, layout: PrintLayout, onProgress?: (done: number, total: number) => void) {
  const pages = await engravePages(score, layout);
  downloadBlob(await pagesToPdf([pages], layout.pageSize, onProgress), `${safeFileName(name)}.pdf`);
}

/** One PDF with every part, each starting on a new page. */
export async function downloadPartsPdf(
  score: Score,
  name: string,
  layout: PrintLayout,
  partIds: Id[],
  onProgress?: (done: number, total: number) => void,
) {
  const groups: string[][] = [];
  for (const partId of partIds) groups.push(await engravePages(score, layout, [partId]));
  const label = partIds.length === 1 ? ` - ${prettyName(score.parts.find((p) => p.id === partIds[0])?.name ?? "part")}` : " - parts";
  downloadBlob(await pagesToPdf(groups, layout.pageSize, onProgress), `${safeFileName(name + label)}.pdf`);
}

/** Print through the browser (vector output; "Save as PDF" in the print dialog gives a vector PDF). */
export async function printPages(pages: string[], pageSize: PageSize) {
  const [wMm, hMm] = PAGE_MM[pageSize];
  const root = document.createElement("div");
  root.id = "print-root";
  const style = document.createElement("style");
  style.textContent = `@page { size: ${wMm}mm ${hMm}mm; margin: 0; }
@media print {
  body > *:not(#print-root) { display: none !important; }
  #print-root { display: block !important; }
  #print-root .print-page { width: ${wMm}mm; height: ${hMm}mm; page-break-after: always; break-after: page; overflow: hidden; }
  #print-root .print-page svg { width: 100%; height: 100%; }
}
#print-root { display: none; }`;
  root.appendChild(style);
  for (const svg of pages) {
    const page = document.createElement("div");
    page.className = "print-page";
    page.innerHTML = svg;
    root.appendChild(page);
  }
  document.body.appendChild(root);
  const cleanup = () => {
    root.remove();
    window.removeEventListener("afterprint", cleanup);
  };
  window.addEventListener("afterprint", cleanup);
  // Let the browser lay out the pages before printing.
  await new Promise((r) => setTimeout(r, 150));
  window.print();
  setTimeout(cleanup, 60_000);
}
