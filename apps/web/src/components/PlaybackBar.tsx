import { ActionIcon, Button, Checkbox, Group, Menu, Select, Text } from "@mantine/core";
import { prettyName, type Score } from "@musicraft/score-core";
import { IconHeadphones, IconPlayerPause, IconPlayerPlay, IconPlayerStop, IconVolume } from "@tabler/icons-react";
import { useEffect } from "react";
import type { Selection } from "../state/project";
import { onPlaybackFrame, usePlayback } from "../state/playback";
import { setPlayingNotes } from "./ScoreView";
import { Tip } from "./Tip";

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function PlaybackBar({ score, selection }: { score: Score; selection: Selection }) {
  const playback = usePlayback();
  const duration = playback.performance?.duration ?? 0;

  useEffect(() => {
    usePlayback.getState().load(score);
  }, [score]);

  // The score view highlights the notes that are sounding.
  useEffect(() => onPlaybackFrame(({ notes }) => setPlayingNotes(notes.flatMap((n) => n.noteIds))), []);

  // Leaving the project stops playback.
  useEffect(() => () => usePlayback.getState().stop(), []);

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
    const state = usePlayback.getState();
    if (state.playing) {
      state.pause();
      return;
    }
    let from: number | undefined;
    if (selection.measures && state.performance) {
      const bar = state.performance.measures.find((m) => m.measureIndex === selection.measures!.from);
      if (bar) from = bar.start;
    }
    await state.play(from);
  }

  const soloCount = playback.solo.length;
  const mixChanged = playback.muted.length > 0 || soloCount > 0 || Object.values(playback.volumes).some((v) => v !== 1);

  return (
    <Group gap={4} wrap="nowrap">
      <Tip label={playback.playing ? "Pause (space)" : "Play (space): from the selected bar, if any, or from where it stopped"}>
        <ActionIcon variant="filled" size="lg" onClick={() => void toggle()} aria-label={playback.playing ? "Pause" : "Play"} data-testid="play">
          {playback.playing ? <IconPlayerPause size={18} /> : <IconPlayerPlay size={18} />}
        </ActionIcon>
      </Tip>
      <Tip label="Stop and go back to the start">
        <ActionIcon variant="default" size="lg" onClick={() => playback.stop()} aria-label="Stop">
          <IconPlayerStop size={18} />
        </ActionIcon>
      </Tip>
      <Text size="xs" c="dimmed" w={70} ta="center" visibleFrom="sm">
        {formatTime(playback.position)} / {formatTime(duration)}
      </Text>
      <Tip label="Playback speed: slower helps to follow fast passages">
        <Select
          size="xs"
          w={84}
          value={String(playback.tempo)}
          onChange={(v) => playback.setTempo(Number(v ?? "1"))}
          allowDeselect={false}
          aria-label="Tempo"
          data={[
            { value: "0.5", label: "50%" },
            { value: "0.75", label: "75%" },
            { value: "1", label: "100%" },
            { value: "1.25", label: "125%" },
          ]}
        />
      </Tip>
      <Menu closeOnItemClick={false} position="bottom-end" withinPortal>
        <Menu.Target>
          <Tip label="Choose which parts you hear: mute parts, or play only the solo ones">
            <ActionIcon variant={mixChanged ? "light" : "subtle"} size="lg" aria-label="Mute parts">
              {soloCount ? <IconHeadphones size={18} /> : <IconVolume size={18} />}
            </ActionIcon>
          </Tip>
        </Menu.Target>
        <Menu.Dropdown>
          <Menu.Label>Play these parts</Menu.Label>
          {score.parts.map((p) => (
            <Group key={p.id} gap={6} px="sm" py={4} wrap="nowrap" justify="space-between">
              <Checkbox
                size="xs"
                label={prettyName(p.name)}
                checked={!playback.muted.includes(p.id)}
                onChange={() => playback.toggleMute(p.id)}
              />
              <Tip label={`Solo: hear only the solo parts${soloCount ? "" : ` (${prettyName(p.name)} alone)`}`}>
                <Button
                  size="compact-xs"
                  variant={playback.solo.includes(p.id) ? "filled" : "default"}
                  onClick={() => playback.toggleSolo(p.id)}
                  aria-label={`Solo ${prettyName(p.name)}`}
                >
                  S
                </Button>
              </Tip>
            </Group>
          ))}
          {mixChanged && (
            <>
              <Menu.Divider />
              <Menu.Item onClick={() => playback.resetMix()}>Hear every part again</Menu.Item>
            </>
          )}
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}
