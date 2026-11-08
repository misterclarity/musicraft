import { exportMusicXml, type Id, type Score } from "@musicraft/score-core";
import { useEffect, useId, useState } from "react";
import { renderer, screenOptions, SupersededError } from "./renderer";

export interface RenderedScore {
  svgs: string[];
  loading: boolean;
  error?: string;
}

/** Engrave a score for the screen. Re-renders (debounced) when the score, view or width changes. */
export function useRenderedScore(
  score: Score | null,
  options: { concert: boolean; widthPx: number; zoom: number; partIds?: Id[] },
): RenderedScore {
  const [state, setState] = useState<RenderedScore>({ svgs: [], loading: true });
  const slot = `screen-${useId()}`;
  const { concert, widthPx, zoom, partIds } = options;
  const partKey = partIds?.join(",") ?? "";

  useEffect(() => {
    if (!score || widthPx <= 0) return;
    let cancelled = false;
    setState((s) => ({ ...s, loading: true }));
    const timer = setTimeout(() => {
      let xml: string;
      try {
        xml = exportMusicXml(score, { pitch: concert ? "concert" : "written", partIds: partKey ? partKey.split(",") : undefined });
      } catch (error) {
        setState({ svgs: [], loading: false, error: error instanceof Error ? error.message : String(error) });
        return;
      }
      renderer
        .renderLatest(slot, xml, screenOptions(widthPx, zoom))
        .then((svgs) => {
          if (!cancelled) setState({ svgs, loading: false });
        })
        .catch((error: Error) => {
          // A newer version of the score is on its way.
          if (error instanceof SupersededError) return;
          if (!cancelled) setState({ svgs: [], loading: false, error: error.message });
        });
    }, 60);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [score, concert, widthPx, zoom, partKey, slot]);

  return state;
}
