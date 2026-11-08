import { Alert, Center, Loader, Text } from "@mantine/core";
import { locate, type Score } from "@musicraft/score-core";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useRenderedScore } from "../render/useRenderedScore";
import type { Selection } from "../state/project";

export interface MeasureMark {
  measureIndex: number;
  /** Limit the mark to one part; whole system otherwise. */
  partId?: string;
  color: "red" | "orange" | "blue" | "green" | "violet";
  label?: string;
}

interface ScoreViewProps {
  score: Score;
  concert: boolean;
  zoom: number;
  selection: Selection;
  onSelect: (selection: Selection) => void;
  marks?: MeasureMark[];
  /** Scroll this bar into view when it changes. */
  focusMeasure?: number | null;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// The score container currently on screen, so playback can highlight notes without re-rendering React.
let activeContainer: HTMLElement | null = null;
let playing = new Set<string>();

/** Highlight the notes that are sounding (called by the player every frame). */
export function setPlayingNotes(ids: string[]) {
  const next = new Set(ids);
  if (activeContainer) {
    for (const id of playing) if (!next.has(id)) activeContainer.querySelector(`[id="${id}"]`)?.classList.remove("mc-playing");
    let first: Element | null = null;
    for (const id of next) {
      if (playing.has(id)) continue;
      const el = activeContainer.querySelector(`[id="${id}"]`);
      el?.classList.add("mc-playing");
      first ??= el;
    }
    if (first) scrollIntoViewIfNeeded(first, activeContainer);
  }
  playing = next;
}

/** The element whose box is closest to the point, if within `tolerance` pixels (0 = must contain it). */
function nearest(elements: NodeListOf<Element>, point: { x: number; y: number }, tolerance: number): Element | null {
  let best: Element | null = null;
  let bestDistance = tolerance * tolerance;
  for (const el of elements) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const dx = Math.max(0, r.left - point.x, point.x - r.right);
    const dy = Math.max(0, r.top - point.y, point.y - r.bottom);
    const distance = dx * dx + dy * dy;
    if (distance <= bestDistance) {
      // Prefer the smallest box among those that contain the point (a note inside a chord, a staff in a bar).
      if (best && distance === 0 && bestDistance === 0) {
        const b = best.getBoundingClientRect();
        if (r.width * r.height >= b.width * b.height) continue;
      }
      best = el;
      bestDistance = distance;
    }
  }
  return best;
}

function scrollIntoViewIfNeeded(el: Element, container: HTMLElement) {
  const box = el.getBoundingClientRect();
  const view = container.getBoundingClientRect();
  if (box.top < view.top + 40 || box.bottom > view.bottom - 40) {
    container.scrollBy({ top: box.top - view.top - view.height / 3, behavior: "smooth" });
  }
}

export function ScoreView({ score, concert, zoom, selection, onSelect, marks = [], focusMeasure }: ScoreViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [rects, setRects] = useState<{ key: string; rect: Rect; color: string; title?: string }[]>([]);

  // Track the available width (debounced) so the music reflows to the screen.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setWidth(Math.floor(el.clientWidth - 24)), 120);
    });
    observer.observe(el);
    setWidth(Math.floor(el.clientWidth - 24));
    activeContainer = el;
    return () => {
      observer.disconnect();
      if (timer) clearTimeout(timer);
      if (activeContainer === el) activeContainer = null;
    };
  }, []);

  const rendered = useRenderedScore(score, { concert, widthPx: width, zoom });

  // staff number in the engraving (1-based, across parts) → part and staff.
  const staffMap = useMemo(() => {
    const map: { partIndex: number; staff: number }[] = [];
    score.parts.forEach((part, partIndex) => {
      for (let s = 1; s <= part.staves; s++) map.push({ partIndex, staff: s });
    });
    return map;
  }, [score]);

  const measureIndexById = useMemo(() => new Map(score.measures.map((m, i) => [m.id, i])), [score]);

  const handleClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target as Element;
      const pages = pagesRef.current;
      const point = { x: event.clientX, y: event.clientY };
      let itemEl = target.closest("g.note, g.rest, g.mRest");
      if (!itemEl) {
        const chord = target.closest("g.chord");
        itemEl = chord?.querySelector("g.note") ?? null;
      }
      // Hollow noteheads and the space between staff lines are transparent: use geometry instead.
      if (!itemEl && pages) itemEl = nearest(pages.querySelectorAll("g.note, g.rest, g.mRest"), point, 9);
      if (itemEl?.id) {
        const loc = locate(score, itemEl.id);
        if (loc) {
          const voice = score.parts[loc.partIndex]!.measures[loc.measureIndex]!.voices[loc.voiceIndex]!;
          const ev = voice.events[loc.eventIndex]!;
          const additive = event.shiftKey || event.metaKey || event.ctrlKey;
          const eventIds = additive
            ? Array.from(new Set([...selection.eventIds, ev.id]))
            : [ev.id];
          onSelect({
            eventIds,
            noteId: loc.noteIndex !== undefined && ev.kind === "note" ? ev.notes[loc.noteIndex]!.id : undefined,
            measures: { from: loc.measureIndex, to: loc.measureIndex },
            partIds: [score.parts[loc.partIndex]!.id],
          });
          return;
        }
      }
      const measureEl = target.closest("g.measure") ?? (pages ? nearest(pages.querySelectorAll("g.measure"), point, 0) : null);
      const measureIndex = measureEl ? measureIndexById.get(measureEl.id) : undefined;
      if (!measureEl || measureIndex === undefined) {
        onSelect({ eventIds: [] });
        return;
      }
      const staffEl = target.closest("g.staff") ?? nearest(measureEl.querySelectorAll("g.staff"), point, 30);
      const staffNumber = Number(staffEl?.getAttribute("data-n") ?? 0);
      const staffInfo = staffMap[staffNumber - 1];
      const partId = staffInfo ? score.parts[staffInfo.partIndex]!.id : undefined;
      if (event.shiftKey && selection.measures) {
        onSelect({
          eventIds: [],
          measures: {
            from: Math.min(selection.measures.from, measureIndex),
            to: Math.max(selection.measures.to, measureIndex),
          },
          partIds: selection.partIds,
        });
      } else {
        onSelect({ eventIds: [], measures: { from: measureIndex, to: measureIndex }, partIds: partId ? [partId] : [] });
      }
    },
    [score, selection, onSelect, measureIndexById, staffMap],
  );

  // Ids to color as selected: chord tones of selected notes, and selected rests.
  const selectionCss = useMemo(() => {
    const ids: string[] = [];
    for (const id of selection.eventIds) {
      const loc = locate(score, id);
      if (!loc) continue;
      const ev = score.parts[loc.partIndex]!.measures[loc.measureIndex]!.voices[loc.voiceIndex]!.events[loc.eventIndex]!;
      if (ev.kind === "note") ids.push(...ev.notes.map((n) => n.id));
      else ids.push(ev.id);
    }
    if (!ids.length) return "";
    return `${ids.map((id) => `.score-pages [id="${id}"]`).join(",")} { color: var(--mc-selection); }`;
  }, [selection.eventIds, score]);

  // Rectangles for bar selections and marks, measured from the engraved SVG.
  const allMarks = useMemo(() => {
    const list: MeasureMark[] = [...marks];
    if (selection.measures && selection.eventIds.length === 0) {
      for (let m = selection.measures.from; m <= selection.measures.to; m++) {
        if (selection.partIds?.length) {
          for (const partId of selection.partIds) list.push({ measureIndex: m, partId, color: "blue" });
        } else list.push({ measureIndex: m, color: "blue" });
      }
    }
    return list;
  }, [marks, selection]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const pages = pagesRef.current;
    if (!container || !pages) return;
    const origin = pages.getBoundingClientRect();
    const result: { key: string; rect: Rect; color: string; title?: string }[] = [];
    allMarks.forEach((mark, i) => {
      const id = score.measures[mark.measureIndex]?.id;
      if (!id) return;
      const measureEl = pages.querySelector(`[id="${id}"]`);
      if (!measureEl) return;
      let box = measureEl.getBoundingClientRect();
      if (mark.partId) {
        const partIndex = score.parts.findIndex((p) => p.id === mark.partId);
        const staffNumbers = staffMap.map((s, n) => (s.partIndex === partIndex ? n + 1 : 0)).filter(Boolean);
        const staffBoxes = staffNumbers
          .map((n) => measureEl.querySelector(`g.staff[data-n="${n}"]`)?.getBoundingClientRect())
          .filter((b): b is DOMRect => !!b);
        if (staffBoxes.length) {
          const top = Math.min(...staffBoxes.map((b) => b.top));
          const bottom = Math.max(...staffBoxes.map((b) => b.bottom));
          box = new DOMRect(box.left, top, box.width, bottom - top);
        }
      }
      result.push({
        key: `${i}`,
        color: mark.color,
        title: mark.label,
        rect: { left: box.left - origin.left - 4, top: box.top - origin.top - 4, width: box.width + 8, height: box.height + 8 },
      });
    });
    setRects(result);
  }, [allMarks, rendered.svgs, score, staffMap]);

  useEffect(() => {
    if (focusMeasure === null || focusMeasure === undefined) return;
    const id = score.measures[focusMeasure]?.id;
    const el = id ? pagesRef.current?.querySelector(`[id="${id}"]`) : null;
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [focusMeasure, score, rendered.svgs]);

  return (
    <div className="score-view" ref={containerRef} onClick={handleClick} data-testid="score-view">
      {rendered.error && (
        <Alert color="red" title="The score could not be displayed" m="md">
          {rendered.error}
        </Alert>
      )}
      {rendered.loading && rendered.svgs.length === 0 && (
        <Center h={240}>
          <Loader />
        </Center>
      )}
      <div className="score-pages" ref={pagesRef} style={{ opacity: rendered.loading ? 0.7 : 1 }}>
        <style>{selectionCss}</style>
        {rendered.svgs.map((svg, i) => (
          <div key={i} className="score-page" dangerouslySetInnerHTML={{ __html: svg }} />
        ))}
        {rects.map((r) => (
          <div
            key={r.key}
            className={`measure-mark measure-mark-${r.color}`}
            title={r.title}
            style={{ left: r.rect.left, top: r.rect.top, width: r.rect.width, height: r.rect.height }}
          />
        ))}
      </div>
      {!rendered.loading && rendered.svgs.length === 0 && !rendered.error && (
        <Center h={200}>
          <Text c="dimmed">Nothing to show.</Text>
        </Center>
      )}
    </div>
  );
}
