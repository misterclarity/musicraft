/// Renders MusicXML to SVG pages with Verovio (WebAssembly) off the main thread.
import type { VerovioOptions } from "verovio";
import { VerovioToolkit } from "verovio/esm";
import createVerovioModule from "verovio/wasm";
import { idsIn, stableIds } from "./stableIds";

export type RenderRequest =
  /**
   * `first`: the index of the page to engrave and send ahead of the others (the one on screen).
   * `ids`: what generated ids start with (each view on screen has its own; see stableIds).
   */
  | { id: number; kind: "render"; xml: string; options: Record<string, unknown>; first?: number; ids?: string }
  | { id: number; kind: "mei"; xml: string };

/** A page sent ahead of the rest of the score. */
export interface PageAhead {
  index: number;
  svg: string;
  /** How many pages the score has now. */
  count: number;
}

export type RenderResponse =
  | { id: number; svgs: string[] }
  | { id: number; ahead: PageAhead }
  | { id: number; mei: string }
  | { id: number; error: string };

interface WorkerScope {
  onmessage: ((event: MessageEvent<RenderRequest>) => void) | null;
  postMessage(message: RenderResponse): void;
}

const scope = self as unknown as WorkerScope;

const BASE_OPTIONS: VerovioOptions = {
  svgViewBox: true,
  svgRemoveXlink: true,
  svgAdditionalAttribute: ["staff@n", "measure@n"],
  smuflTextFont: "embedded",
  breaks: "auto",
  footer: "none",
};

let toolkit: VerovioToolkit | null = null;
const ready = createVerovioModule().then((module) => {
  toolkit = new VerovioToolkit(module);
});

scope.onmessage = async (event) => {
  const request = event.data;
  try {
    await ready;
    const tk = toolkit!;
    if (request.kind === "mei") {
      tk.setOptions(BASE_OPTIONS);
      if (!tk.loadData(request.xml)) throw new Error("The score could not be converted.");
      scope.postMessage({ id: request.id, mei: tk.getMEI() });
      return;
    }
    // Layout options must be set before loading so they apply to this score.
    tk.setOptions({ ...BASE_OPTIONS, ...(request.options as VerovioOptions) });
    if (!tk.loadData(request.xml)) throw new Error("The score could not be engraved.");
    const keep = idsIn(request.xml);
    const engrave = (page: number) => stableIds(tk.renderToSVG(page, false), page, keep, request.ids);
    const count = tk.getPageCount();
    const svgs: string[] = new Array<string>(count);
    // The page on screen first: an edit shows before the rest of the score is drawn.
    if (request.first !== undefined && count > 1) {
      const index = Math.min(Math.max(0, request.first), count - 1);
      svgs[index] = engrave(index + 1);
      scope.postMessage({ id: request.id, ahead: { index, svg: svgs[index], count } });
    }
    for (let page = 1; page <= count; page++) svgs[page - 1] ??= engrave(page);
    scope.postMessage({ id: request.id, svgs });
  } catch (error) {
    scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
};
