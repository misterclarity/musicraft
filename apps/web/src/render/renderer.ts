import type { PageAhead, RenderRequest, RenderResponse } from "./verovio.worker";

export type { PageAhead };

/** Ask for one page ahead of the rest: `first` is its index, `onPage` gets it. */
export interface Ahead {
  first: number;
  onPage: (page: PageAhead) => void;
}

type Pending = { resolve: (value: RenderResponse) => void; reject: (error: Error) => void; ahead?: (page: PageAhead) => void };
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

/** A screen render that was replaced by a newer one before it started. */
export class SupersededError extends Error {
  constructor() {
    super("A newer render replaced this one.");
    this.name = "SupersededError";
  }
}

interface Slot {
  busy: boolean;
  queued?: { xml: string; options: Record<string, unknown>; ahead?: Ahead; resolve: (svgs: string[]) => void; reject: (error: Error) => void };
}

/** Promise-based client for the Verovio worker. One worker is shared by the whole app. */
export class Renderer {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private slots = new Map<string, Slot>();

  constructor(private readonly createWorker: () => Worker = () => new Worker(new URL("./verovio.worker.ts", import.meta.url), { type: "module" })) {}

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = this.createWorker();
    worker.onmessage = (event: MessageEvent<RenderResponse>) => {
      const pending = this.pending.get(event.data.id);
      if (!pending) return;
      if ("ahead" in event.data) {
        pending.ahead?.(event.data.ahead);
        return;
      }
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

  private request<T extends RenderResponse>(message: WithoutId<RenderRequest>, ahead?: (page: PageAhead) => void): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => ("error" in value ? reject(new Error(value.error)) : resolve(value as T)),
        reject,
        ahead,
      });
      this.ensureWorker().postMessage({ ...message, id } as RenderRequest);
    });
  }

  /** Engrave every page; with `ahead`, one page is engraved first and handed over early. */
  async render(xml: string, options: Record<string, unknown>, ahead?: Ahead): Promise<string[]> {
    const response = await this.request<{ id: number; svgs: string[] }>(
      { kind: "render", xml, options, ...(ahead ? { first: ahead.first } : {}) },
      ahead?.onPage,
    );
    return response.svgs;
  }

  /**
   * Render for a view that only needs the newest result (the score on screen). While one render runs,
   * newer requests replace each other, so the worker never works through outdated versions while the
   * user types. Replaced requests reject with SupersededError.
   */
  renderLatest(key: string, xml: string, options: Record<string, unknown>, ahead?: Ahead): Promise<string[]> {
    let slot = this.slots.get(key);
    if (!slot) this.slots.set(key, (slot = { busy: false }));
    slot.queued?.reject(new SupersededError());
    const queued = slot;
    return new Promise<string[]>((resolve, reject) => {
      queued.queued = { xml, options, ahead, resolve, reject };
      this.pump(queued);
    });
  }

  private pump(slot: Slot) {
    if (slot.busy || !slot.queued) return;
    const job = slot.queued;
    slot.queued = undefined;
    slot.busy = true;
    this.render(job.xml, job.options, job.ahead)
      .then(job.resolve, job.reject)
      .finally(() => {
        slot.busy = false;
        this.pump(slot);
      });
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
  const pageWidth = Math.max(500, Math.floor((widthPx * 100) / scale));
  return {
    scale,
    pageWidth,
    // Pages of paper proportions: an edit redraws one of them, not the whole score.
    pageHeight: Math.round(pageWidth * Math.SQRT2),
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
