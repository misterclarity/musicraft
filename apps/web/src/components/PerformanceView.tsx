import { ActionIcon, Center, Group, Loader, Select, Switch, Text } from "@mantine/core";
import { prettyName, type Score } from "@musicraft/score-core";
import { IconPlayerPause, IconPlayerPlay, IconPlayerSkipBack, IconX, IconZoomIn, IconZoomOut } from "@tabler/icons-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from "react";
import { performSteps, shownPages, stepFor, stepLabel, type PageLines, type PerformView } from "../lib/performance";
import { performanceOptions } from "../render/renderer";
import { useRenderedScore } from "../render/useRenderedScore";
import { onPlaybackFrame, usePlayback } from "../state/playback";
import { Tip } from "./Tip";

interface Props {
  score: Score;
  concert: boolean;
  /** The part to show first (the whole score when null). */
  partId: string | null;
  onClose: () => void;
}

interface Preferences {
  half: boolean;
  follow: boolean;
  zoom: number;
}

const PREFERENCES_KEY = "musicraft.perform";
const DEFAULTS: Preferences = { half: true, follow: true, zoom: 1 };
const ALL = "all";

function storedPreferences(): Preferences {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(PREFERENCES_KEY) ?? "null") as Partial<Preferences> | null) };
  } catch {
    return DEFAULTS;
  }
}

/** Where each page's lines of music are, and where its bars sit (fractions of the page height). */
interface Measured {
  lines: PageLines[];
  /** Bar id → page and height on it. */
  bars: Map<string, { page: number; y: number }>;
}

function measurePages(layers: HTMLElement[]): Measured {
  const bars = new Map<string, { page: number; y: number }>();
  const lines = layers.map((layer, page) => {
    const box = layer.getBoundingClientRect();
    if (!box.height) return { gaps: [] };
    const fraction = (y: number) => (y - box.top) / box.height;
    const systems = Array.from(layer.querySelectorAll("g.system"))
      .map((s) => s.getBoundingClientRect())
      .filter((r) => r.height > 0)
      .sort((a, b) => a.top - b.top);
    for (const bar of layer.querySelectorAll("g.measure")) {
      const r = bar.getBoundingClientRect();
      if (bar.id && !bars.has(bar.id)) bars.set(bar.id, { page, y: fraction((r.top + r.bottom) / 2) });
    }
    return { gaps: systems.slice(1).map((s, i) => fraction((systems[i]!.bottom + s.top) / 2)) };
  });
  return { lines, bars };
}

/** How a page layer is placed for a view: hidden, whole, cut, or on one side. */
function layerStyle(view: PerformView | undefined, page: number, twoUp: boolean): CSSProperties {
  const base: CSSProperties = twoUp ? { width: "50%", left: 0 } : { width: "100%", left: 0 };
  const hidden = { ...base, visibility: "hidden" as const };
  if (!view) return hidden;
  if (view.kind === "page") return view.page === page ? base : hidden;
  if (view.kind === "half") {
    if (view.top === page) return { ...base, clipPath: `inset(0 0 ${(1 - view.topCut) * 100}% 0)` };
    if (view.bottom === page) return { ...base, clipPath: `inset(${view.bottomCut * 100}% 0 0 0)` };
    return hidden;
  }
  if (view.left === page) return { ...base, left: 0 };
  if (view.right === page) return { ...base, left: "50%" };
  return hidden;
}

/**
 * Performance mode: the music full screen, in pages the size of the screen, to play from on a
 * tablet or a stand. Pages turn with a tap (right side forward, left side back), a swipe, the arrow
 * or page keys (what page-turn pedals send), and by themselves while the music plays.
 */
export function PerformanceView({ score, concert, partId: initialPart, onClose }: Props) {
  const [preferences, setPreferences] = useState(storedPreferences);
  const [part, setPart] = useState<string>(initialPart && score.parts.some((p) => p.id === initialPart) ? initialPart : ALL);
  const [size, setSize] = useState({ width: window.innerWidth, height: window.innerHeight });
  const [index, setIndex] = useState(0);
  const [measured, setMeasured] = useState<Measured | null>(null);
  const [chrome, setChrome] = useState(true);
  const stageRef = useRef<HTMLDivElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const playing = usePlayback((s) => s.playing);

  const update = (changes: Partial<Preferences>) => {
    const next = { ...preferences, ...changes };
    setPreferences(next);
    try {
      localStorage.setItem(PREFERENCES_KEY, JSON.stringify(next));
    } catch {
      // Not remembered in this browser.
    }
  };

  // The screen's size (and the pages with it), after rotating or resizing.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const onResize = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setSize({ width: window.innerWidth, height: window.innerHeight }), 200);
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (timer) clearTimeout(timer);
    };
  }, []);

  // Two pages side by side on a wide screen (a tablet held sideways).
  const twoUp = size.width >= 900 && size.width > size.height * 1.15;
  const pageWidth = twoUp ? Math.floor(size.width / 2) : size.width;
  const layout = useMemo(() => performanceOptions(pageWidth, size.height, preferences.zoom), [pageWidth, size.height, preferences.zoom]);
  const partIds = useMemo(() => (part === ALL ? undefined : [part]), [part]);
  const rendered = useRenderedScore(score, { concert, widthPx: pageWidth, zoom: preferences.zoom, partIds, layout, multiRests: part !== ALL });
  const steps = useMemo(() => (measured ? performSteps(measured.lines, { twoUp, half: preferences.half }) : []), [measured, twoUp, preferences.half]);
  const current = Math.min(index, Math.max(0, steps.length - 1));
  const view = steps[current]?.view;

  // Measure the pages once engraved; keep the bar that was being read in view.
  const anchor = useRef<string | null>(null);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || !rendered.svgs.length || rendered.loading) return;
    const next = measurePages(Array.from(stage.querySelectorAll<HTMLElement>(":scope > .perform-page")));
    setMeasured(next);
    const place = anchor.current ? next.bars.get(anchor.current) : undefined;
    if (place) {
      const at = stepFor(performSteps(next.lines, { twoUp, half: preferences.half }), place.page, 0);
      if (at !== null) setIndex(at);
    }
  }, [rendered.svgs, rendered.loading, twoUp, preferences.half]);

  // Remember the first bar of what is being read, to find it again in new pages.
  useEffect(() => {
    if (!measured || !steps[current]) return;
    const page = steps[current].reads[0]?.page;
    anchor.current = [...measured.bars].find(([, place]) => place.page === page)?.[0] ?? null;
  }, [measured, steps, current]);

  const turn = useCallback(
    (by: number) => {
      setIndex((i) => Math.max(0, Math.min(steps.length - 1, Math.min(i, steps.length - 1) + by)));
    },
    [steps.length],
  );

  // Arrow and page keys turn (page-turn pedals send them); Escape leaves. Before the editor sees them.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = /^(input|textarea|select)$/i.test(target.tagName) && !/checkbox|radio/.test((target as HTMLInputElement).type);
      if (typing || target.closest("[role=listbox]")) return;
      const forward = ["ArrowRight", "ArrowDown", "PageDown"].includes(event.key);
      const back = ["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key);
      if (forward || back) turn(forward ? 1 : -1);
      else if (event.key === "Home") setIndex(0);
      else if (event.key === "End") setIndex(steps.length - 1);
      else if (event.key === "Escape") onClose();
      else if (event.key === " ") togglePlay.current();
      else return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [turn, steps.length, onClose]);

  // Turn by itself while the music plays: to the view for the bar being played.
  const follow = preferences.follow;
  const placeOf = useMemo(() => {
    // Bars hidden in a multi-bar rest are where the rest is.
    const places: ({ page: number; y: number } | undefined)[] = [];
    let last: { page: number; y: number } | undefined;
    for (const measure of score.measures) {
      last = measured?.bars.get(measure.id) ?? last;
      places.push(last);
    }
    return places;
  }, [score, measured]);
  useEffect(() => {
    if (!follow) return;
    let lastBar = -1;
    return onPlaybackFrame(({ notes }) => {
      const bar = notes[0]?.measureIndex;
      if (bar === undefined || bar === lastBar) return;
      lastBar = bar;
      const place = placeOf[bar];
      const at = place ? stepFor(steps, place.page, place.y) : null;
      if (at !== null) setIndex(at);
    });
  }, [follow, placeOf, steps]);

  // The notes sounding now, in colour.
  useEffect(() => {
    let lit: Element[] = [];
    return onPlaybackFrame(({ notes }) => {
      for (const el of lit) el.classList.remove("mc-playing");
      const stage = stageRef.current;
      lit = stage ? notes.flatMap((n) => n.noteIds).flatMap((id) => Array.from(stage.querySelectorAll(`[id="${id}"]`))) : [];
      for (const el of lit) el.classList.add("mc-playing");
    });
  }, []);

  // Keep the screen on while reading.
  useEffect(() => {
    let lock: WakeLockSentinel | null = null;
    let open = true;
    const request = () => {
      if (!("wakeLock" in navigator) || document.visibilityState !== "visible") return;
      navigator.wakeLock
        .request("screen")
        .then((sentinel) => {
          if (open) lock = sentinel;
          else void sentinel.release();
        })
        .catch(() => {
          // Not allowed (battery saver, or the page lost focus): the screen may dim as usual.
        });
    };
    request();
    document.addEventListener("visibilitychange", request);
    return () => {
      open = false;
      document.removeEventListener("visibilitychange", request);
      void lock?.release();
    };
  }, []);

  // The controls hide after a few seconds; a tap at the top, or the mouse, brings them back.
  const showChrome = useCallback(() => {
    setChrome(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setChrome(false), 4000);
  }, []);
  useEffect(() => {
    showChrome();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [showChrome]);

  // Taps and swipes on the music: right side forward, left side back; the top strip shows the controls.
  const press = useRef<{ x: number; y: number } | null>(null);
  const onPointerDown = (event: PointerEvent) => {
    press.current = { x: event.clientX, y: event.clientY };
  };
  const onPointerUp = (event: PointerEvent) => {
    const start = press.current;
    press.current = null;
    if (!start || (event.pointerType === "mouse" && event.button !== 0)) return;
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy)) {
      turn(dx < 0 ? 1 : -1);
    } else if (Math.abs(dx) < 12 && Math.abs(dy) < 12) {
      if (event.clientY < 64) showChrome();
      else turn(event.clientX < size.width / 3 ? -1 : 1);
    }
  };

  // Play on from where the music stopped if that is on screen, otherwise from the first bar read now.
  const togglePlay = useRef(() => {});
  togglePlay.current = () => {
    const playback = usePlayback.getState();
    if (playback.playing) {
      playback.pause();
      return;
    }
    const bars = playback.performance?.measures ?? [];
    const stoppedAt = bars.find((m) => m.start <= playback.position && playback.position < m.start + m.duration);
    const shown = view ? shownPages(view) : [];
    if (stoppedAt && shown.includes(placeOf[stoppedAt.measureIndex]?.page ?? -1)) {
      void playback.play();
      return;
    }
    const reading = steps[current]?.reads[0]?.page ?? 0;
    void playback.play(bars.find((m) => placeOf[m.measureIndex]?.page === reading)?.start);
  };

  const half = view?.kind === "half" ? view : null;
  const parts = [{ value: ALL, label: "Full score" }, ...score.parts.map((p) => ({ value: p.id, label: prettyName(p.name) || p.name }))];

  return (
    <div className="perform-view" data-testid="perform-view" onPointerMove={(e) => e.pointerType === "mouse" && showChrome()}>
      <div className="perform-stage" ref={stageRef} onPointerDown={onPointerDown} onPointerUp={onPointerUp}>
        {rendered.svgs.map((svg, i) => (
          <div key={i} className="perform-page" style={layerStyle(view, i, twoUp)} dangerouslySetInnerHTML={{ __html: svg }} />
        ))}
        {half && <div className="perform-cut" style={{ top: `${half.bottomCut * 100}%`, width: twoUp ? "50%" : "100%" }} />}
        {(rendered.loading && !rendered.svgs.length) || !measured ? (
          <Center className="perform-loading">
            <Loader />
          </Center>
        ) : null}
        {rendered.error && (
          <Center className="perform-loading">
            <Text c="red">{rendered.error}</Text>
          </Center>
        )}
      </div>
      <div className={`perform-chrome${chrome ? " perform-chrome-shown" : ""}`} onMouseEnter={showChrome} onPointerDown={showChrome}>
        <Group gap="xs" wrap="wrap" justify="space-between" p={8}>
          <Group gap={6} wrap="nowrap">
            <Tip label="Leave performance mode (Esc)">
              <ActionIcon variant="subtle" color="gray" onClick={onClose} aria-label="Leave performance mode">
                <IconX size={20} />
              </ActionIcon>
            </Tip>
            <Tip label={playing ? "Pause (Space)" : "Play along: the pages turn by themselves if “Turn while playing” is on (Space)"}>
              <ActionIcon variant="light" onClick={() => togglePlay.current()} aria-label={playing ? "Pause" : "Play"}>
                {playing ? <IconPlayerPause size={18} /> : <IconPlayerPlay size={18} />}
              </ActionIcon>
            </Tip>
            <Tip label="Back to the beginning: stop and show the first page (Home)">
              <ActionIcon
                variant="subtle"
                color="gray"
                onClick={() => {
                  usePlayback.getState().stop();
                  setIndex(0);
                }}
                aria-label="Back to the beginning"
              >
                <IconPlayerSkipBack size={18} />
              </ActionIcon>
            </Tip>
            <Text size="sm" fw={600} data-testid="perform-page-label">
              {view ? stepLabel(view, measured?.lines.length ?? 0) : "Engraving…"}
            </Text>
          </Group>
          <Group gap={8} wrap="wrap">
            <Tip label="What to show: the full score, or one part as its player reads it (with multi-bar rests)">
              <Select
                size="xs"
                w={170}
                data={parts}
                value={part}
                allowDeselect={false}
                onChange={(value) => {
                  // The place in the music stays (see the anchor above).
                  if (value) setPart(value);
                  // Back to the keys turning pages.
                  (document.activeElement as HTMLElement | null)?.blur();
                }}
                aria-label="What to show"
                comboboxProps={{ zIndex: 400 }}
              />
            </Tip>
            <Tip label="Half-page turns: first the top of the next page replaces the lines already played, while you finish this page">
              <Switch size="xs" label="Half-page turns" checked={preferences.half} onChange={(e) => update({ half: e.currentTarget.checked })} />
            </Tip>
            <Tip label="Turn the pages by themselves while the music plays, following the bar being played">
              <Switch size="xs" label="Turn while playing" checked={preferences.follow} onChange={(e) => update({ follow: e.currentTarget.checked })} />
            </Tip>
            <Group gap={0} wrap="nowrap">
              <Tip label="Smaller notes: more music on each page">
                <ActionIcon variant="subtle" color="gray" onClick={() => update({ zoom: Math.max(0.6, preferences.zoom / 1.15) })} aria-label="Smaller notes">
                  <IconZoomOut size={18} />
                </ActionIcon>
              </Tip>
              <Tip label="Larger notes: easier to read from further away">
                <ActionIcon variant="subtle" color="gray" onClick={() => update({ zoom: Math.min(2.2, preferences.zoom * 1.15) })} aria-label="Larger notes">
                  <IconZoomIn size={18} />
                </ActionIcon>
              </Tip>
            </Group>
          </Group>
        </Group>
      </div>
    </div>
  );
}
