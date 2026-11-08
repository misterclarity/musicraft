import { ActionIcon, Checkbox, Group, Menu, Select, Text, Tooltip } from "@mantine/core";
import { buildPerformance, prettyName, type Score } from "@musicraft/score-core";
import { IconPlayerPause, IconPlayerPlay, IconPlayerStop, IconVolume } from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Player } from "../audio/player";
import type { Selection } from "../state/project";
import { setPlayingNotes } from "./ScoreView";

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function PlaybackBar({ score, selection }: { score: Score; selection: Selection }) {
  const [tempo, setTempo] = useState("1");
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [muted, setMuted] = useState<string[]>([]);
  const lastUpdate = useRef(0);
  const performance = useMemo(() => buildPerformance(score, { tempoScale: Number(tempo) }), [score, tempo]);

  const playerRef = useRef<Player | null>(null);
  if (!playerRef.current) {
    playerRef.current = new Player({
      onTick: (time, ids) => {
        setPlayingNotes(ids);
        const now = Date.now();
        if (now - lastUpdate.current > 200) {
          lastUpdate.current = now;
          setPosition(time);
        }
      },
      onEnd: () => {
        setPlaying(false);
        setPosition(0);
        setPlayingNotes([]);
      },
    });
  }
  const player = playerRef.current;

  useEffect(() => {
    player.load(score, performance);
  }, [player, score, performance]);

  useEffect(() => {
    player.setMuted(muted);
  }, [player, muted]);

  useEffect(() => () => player.dispose(), [player]);

  // Space toggles playback (unless typing in a field).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.code !== "Space" || /input|textarea|select/i.test(target.tagName) || target.isContentEditable) return;
      e.preventDefault();
      void toggle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  async function toggle() {
    if (player.isPlaying) {
      player.pause();
      setPlaying(false);
      setPlayingNotes([]);
      return;
    }
    let from = player.position;
    if (selection.measures) {
      const bar = performance.measures.find((m) => m.measureIndex === selection.measures!.from);
      if (bar) from = bar.start;
    }
    await player.play(from);
    setPlaying(true);
  }

  function stop() {
    player.stop(false);
    player.reset();
    setPlaying(false);
    setPosition(0);
    setPlayingNotes([]);
  }

  return (
    <Group gap={4} wrap="nowrap">
      <Tooltip label={playing ? "Pause (space)" : "Play (space) — from the selected bar if any"}>
        <ActionIcon variant="filled" size="lg" onClick={() => void toggle()} aria-label={playing ? "Pause" : "Play"} data-testid="play">
          {playing ? <IconPlayerPause size={18} /> : <IconPlayerPlay size={18} />}
        </ActionIcon>
      </Tooltip>
      <Tooltip label="Stop">
        <ActionIcon variant="default" size="lg" onClick={stop} aria-label="Stop">
          <IconPlayerStop size={18} />
        </ActionIcon>
      </Tooltip>
      <Text size="xs" c="dimmed" w={70} ta="center" visibleFrom="sm">
        {formatTime(position)} / {formatTime(performance.duration)}
      </Text>
      <Select
        size="xs"
        w={84}
        value={tempo}
        onChange={(v) => setTempo(v ?? "1")}
        allowDeselect={false}
        aria-label="Tempo"
        data={[
          { value: "0.5", label: "50%" },
          { value: "0.75", label: "75%" },
          { value: "1", label: "100%" },
          { value: "1.25", label: "125%" },
        ]}
      />
      <Menu closeOnItemClick={false} position="bottom-end" withinPortal>
        <Menu.Target>
          <ActionIcon variant="subtle" size="lg" aria-label="Mute parts">
            <IconVolume size={18} />
          </ActionIcon>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>Play these parts</Menu.Label>
          {score.parts.map((p) => (
            <Menu.Item key={p.id}>
              <Checkbox
                size="xs"
                label={prettyName(p.name)}
                checked={!muted.includes(p.id)}
                onChange={(e) => setMuted((m) => (e.currentTarget.checked ? m.filter((id) => id !== p.id) : [...m, p.id]))}
              />
            </Menu.Item>
          ))}
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}
