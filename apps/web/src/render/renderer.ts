import type { RenderRequest, RenderResponse } from "./verovio.worker";

type Pending = { resolve: (value: RenderResponse) => void; reject: (error: Error) => void };
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

/** Promise-based client for the Verovio worker. One worker is shared by the whole app. */
class Renderer {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./verovio.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<RenderResponse>) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      this.pending.delete(event.data.id);
      pending.resolve(event.data);
    };
    worker.onerror = (event) => {
      for (const p of this.pending.values()) p.reject(new Error(event.message || "The engraver crashed."));
      this.pending.clear();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  private request<T extends RenderResponse>(message: WithoutId<RenderRequest>): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => ("error" in value ? reject(new Error(value.error)) : resolve(value as T)),
        reject,
      });
      this.ensureWorker().postMessage({ ...message, id } as RenderRequest);
    });
  }

  async render(xml: string, options: Record<string, unknown>): Promise<string[]> {
    const response = await this.request<{ id: number; svgs: string[] }>({ kind: "render", xml, options });
    return response.svgs;
  }

  async mei(xml: string): Promise<string> {
    const response = await this.request<{ id: number; mei: string }>({ kind: "mei", xml });
    return response.mei;
  }
}

export const renderer = new Renderer();

/** Verovio layout options for on-screen display at a given container width (CSS pixels). */
export function screenOptions(widthPx: number, zoom: number): Record<string, unknown> {
  const scale = Math.round(36 * zoom);
  return {
    scale,
    pageWidth: Math.max(500, Math.floor((widthPx * 100) / scale)),
    pageHeight: 60000,
    adjustPageHeight: true,
    pageMarginLeft: 40,
    pageMarginRight: 40,
    pageMarginTop: 40,
    pageMarginBottom: 40,
    header: "auto",
  };
}

export type PageSize = "a4" | "letter";

export const PAGE_MM: Record<PageSize, [number, number]> = { a4: [210, 297], letter: [215.9, 279.4] };

/** Verovio layout for printed pages. `staffSize` scales the music (100 = 7.2 mm staves). */
export function printOptions(size: PageSize, staffSize: number): Record<string, unknown> {
  const [w, h] = PAGE_MM[size];
  return {
    scale: staffSize,
    // Verovio works in tenths of a millimetre at scale 100.
    pageWidth: Math.round((w * 10 * 100) / staffSize),
    pageHeight: Math.round((h * 10 * 100) / staffSize),
    adjustPageHeight: false,
    pageMarginLeft: Math.round((120 * 100) / staffSize),
    pageMarginRight: Math.round((120 * 100) / staffSize),
    pageMarginTop: Math.round((120 * 100) / staffSize),
    pageMarginBottom: Math.round((140 * 100) / staffSize),
    header: "auto",
    breaks: "auto",
  };
}
