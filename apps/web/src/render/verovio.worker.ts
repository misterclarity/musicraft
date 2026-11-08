/// Renders MusicXML to SVG pages with Verovio (WebAssembly) off the main thread.
import type { VerovioOptions } from "verovio";
import { VerovioToolkit } from "verovio/esm";
import createVerovioModule from "verovio/wasm";

export type RenderRequest =
  | { id: number; kind: "render"; xml: string; options: Record<string, unknown> }
  | { id: number; kind: "mei"; xml: string };

export type RenderResponse =
  | { id: number; svgs: string[] }
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
    const count = tk.getPageCount();
    const svgs: string[] = [];
    for (let page = 1; page <= count; page++) svgs.push(tk.renderToSVG(page, false));
    scope.postMessage({ id: request.id, svgs });
  } catch (error) {
    scope.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
};
