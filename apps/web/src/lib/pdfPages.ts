/** Page thumbnails of PDFs, using pdf.js (loaded only when a PDF is opened). */

export interface PdfPreview {
  pageCount: number;
  thumbnail(index: number, maxSide?: number): Promise<string>;
  destroy(): void;
}

export async function openPdf(file: Blob): Promise<PdfPreview> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).href;
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  const doc = await task.promise;
  return {
    pageCount: doc.numPages,
    async thumbnail(index, maxSide = 360) {
      const page = await doc.getPage(index + 1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: maxSide / Math.max(base.width, base.height) });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport, canvas }).promise;
      return canvas.toDataURL("image/jpeg", 0.85);
    },
    destroy() {
      void task.destroy();
    },
  };
}
