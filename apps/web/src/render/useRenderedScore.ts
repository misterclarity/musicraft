import { exportMusicXml, type Id, type Score } from "@musicraft/score-core";
import { useEffect, useId, useRef, useState } from "react";
import { renderer, screenOptions, SupersededError } from "./renderer";

export interface RenderedScore {
  svgs: string[];
  loading: boolean;
  error?: string;
}

/**
 * Engrave a score for the screen. Re-renders when the score, view or width changes. `firstPage`
 * names the page to draw first (the one being edited or read): it is shown as soon as it is ready,
 * and pages the change didn't touch come back identical, so React leaves them alone.
 */
export function useRenderedScore(
  score: Score | null,
  options: {
    concert: boolean;
    widthPx: number;
    zoom: number;
    partIds?: Id[];
    firstPage?: () => number;
    /** Verovio's layout instead of the editor's (see screenOptions). */
    layout?: Record<string, unknown>;
    /** Gather runs of empty bars into multi-bar rests, as in a printed part. */
    multiRests?: boolean;
  },
): RenderedScore {
  const [state, setState] = useState<RenderedScore>({ svgs: [], loading: true });
  const slot = `screen-${useId()}`;
  const { concert, widthPx, zoom, partIds, multiRests = false } = options;
  const partKey = partIds?.join(",") ?? "";
  const layoutKey = options.layout ? JSON.stringify(options.layout) : "";
  const firstPage = useRef(options.firstPage);
  firstPage.current = options.firstPage;

  useEffect(() => {
    if (!score || widthPx <= 0) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    // One frame: changes made together (an edit and its new selection) engrave once.
    const timer = setTimeout(() => {
      let xml: string;
      try {
        xml = exportMusicXml(score, { pitch: concert ? "concert" : "written", partIds: partKey ? partKey.split(",") : undefined, multiRests });
      } catch (error) {
        setState({ svgs: [], loading: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      renderer
        .renderLatest(slot, xml, layoutKey ? (JSON.parse(layoutKey) as Record<string, unknown>) : screenOptions(widthPx, zoom), {
          first: firstPage.current?.() ?? 0,
          onPage: ({ index, svg, count }) => {
            if (cancelled) return;
            setState((s) => {
              // A score just opened: show this page while the others are engraved.
              if (!s.svgs.length) return { ...s, svgs: Array.from({ length: count }, (_, i) => (i === index ? svg : "")) };
              // Only into the same number of pages: otherwise its neighbours would no longer match.
              if (s.svgs.length !== count || s.svgs[index] === svg) return s;
              return { ...s, svgs: s.svgs.map((old, i) => (i === index ? svg : old)) };
            });
          },
        })
        .then((svgs) => {
          if (!cancelled) setState({ svgs, loading: false });
        })
        .catch((error: Error) => {
          // A newer version of the score is on its way.
          if (error instanceof SupersededError) return;
          if (!cancelled) setState({ svgs: [], loading: false, error: error.message });
        });
    }, 16);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [score, concert, widthPx, zoom, partKey, layoutKey, multiRests, slot]);

  return state;
}
