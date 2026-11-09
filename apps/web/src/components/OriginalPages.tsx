import { Text } from "@mantine/core";
import { locate, type Score } from "@musicraft/score-core";
import { useEffect, useMemo, useRef } from "react";
import type { PageRecord } from "../lib/db";
import { resolveSystems, systemOfMeasure } from "../lib/pageLayout";
import type { Selection } from "../state/project";

interface Highlight {
  page: number;
  boxes: { x: number; y: number; width: number; height: number }[];
  point?: { x: number; y: number };
}

/** Which page and line of music a measure came from, and where a selected note sits on the page. */
export function locateOnPages(pages: PageRecord[], score: Score, selection: Selection): Highlight | null {
  let measure = selection.measures?.from;
  let eventId: string | undefined;
  if (selection.eventIds.length) {
    eventId = selection.eventIds[0];
    const loc = eventId ? locate(score, eventId) : undefined;
    if (loc) measure = loc.measureIndex;
  }
  if (measure === undefined) return null;
  const system = systemOfMeasure(resolveSystems(pages, score), measure);
  if (!system) return null;
  const page = pages[system.page]!;
  const position = eventId ? page.layout?.notePositions?.[eventId] : undefined;
  return {
    page: system.page,
    boxes: system.staffs,
    point: position ? { x: position.x / page.width, y: position.y / page.height } : undefined,
  };
}

export function OriginalPages({
  pages,
  score,
  selection,
  onSelectMeasure,
}: {
  pages: PageRecord[];
  score: Score;
  selection: Selection;
  onSelectMeasure: (measureIndex: number) => void;
}) {
  const urls = useMemo(() => pages.map((p) => URL.createObjectURL(p.blob)), [pages]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  const highlight = useMemo(() => locateOnPages(pages, score, selection), [pages, score, selection]);
  const systems = useMemo(() => resolveSystems(pages, score), [pages, score]);
  const highlightRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    highlightRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlight]);

  return (
    <div className="original-pages" data-testid="original-pages">
      {pages.map((page, i) => {
        const layout = page.layout;
        const perSystem = Math.max(1, layout?.staffsPerSystem ?? 1);
        return (
          <div key={page.id ?? i} className="original-page">
            <div className="original-frame">
            <img src={urls[i]} alt={page.name} />
            {layout?.staffs.map((staff, s) => {
              const system = Math.floor(s / perSystem);
              const firstMeasure = systems.find((x) => x.page === i && x.system === system)?.from ?? 0;
              return (
                <div
                  key={s}
                  className="original-staff"
                  title={`Line ${system + 1}`}
                  style={{ left: `${staff.x * 100}%`, top: `${staff.y * 100}%`, width: `${staff.width * 100}%`, height: `${staff.height * 100}%` }}
                  onClick={() => onSelectMeasure(firstMeasure)}
                />
              );
            })}
            {highlight?.page === i &&
              highlight.boxes.map((b, k) => (
                <div
                  key={`h${k}`}
                  ref={k === 0 ? highlightRef : undefined}
                  className="original-highlight"
                  style={{ left: `${b.x * 100}%`, top: `${b.y * 100}%`, width: `${b.width * 100}%`, height: `${b.height * 100}%` }}
                />
              ))}
            {highlight?.page === i && highlight.point && (
              <div className="original-point" style={{ left: `${highlight.point.x * 100}%`, top: `${highlight.point.y * 100}%` }} />
            )}
            </div>
            <Text size="xs" c="dimmed" ta="center" mt={4}>
              {page.name}
            </Text>
          </div>
        );
      })}
    </div>
  );
}
