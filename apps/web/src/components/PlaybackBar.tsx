import { ActionIcon, Button, Checkbox, Group, Menu, NumberInput, SegmentedControl, Select, Slider, Stack, Switch, Text } from "@mantine/core";
import { prettyName, type Score } from "@musicraft/score-core";
import { IconHeadphones, IconMetronome, IconPlayerPause, IconPlayerPlay, IconPlayerStop, IconVolume } from "@tabler/icons-react";
import { useEffect } from "react";
import type { Selection } from "../state/project";
import { onPlaybackFrame, usePlayback } from "../state/playback";
import { setPlayingNotes } from "./ScoreView";
import { Tip } from "./Tip";

const SPEEDS = [0.5, 0.75, 1, 1.25];

/** The speed choices, with the current one when the speed trainer set another. */
function speedOptions(tempo: number) {
  const values = SPEEDS.includes(tempo) ? SPEEDS : [...SPEEDS, tempo].sort((a, b) => a - b);
  return values.map((v) => ({ value: String(v), label: `${Math.round(v * 100)}%` }));
}

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
    await state.play(from, selection.measures);
  }

  const soloCount = playback.solo.length;
  const mixChanged = playback.muted.length > 0 || soloCount > 0 || Object.values(playback.volumes).some((v) => v !== 1);

  return (
    <Group gap={4} wrap="nowrap">
      <Tip
        label={
          playback.loadingSounds
            ? "Downloading the instruments' recorded sounds (only the first time)"
            : playback.playing
              ? "Pause (space)"
              : "Play (space): from the selected bar, if any, or from where it stopped"
        }
      >
        <ActionIcon variant="filled" size="lg" loading={playback.loadingSounds} onClick={() => void toggle()} aria-label={playback.playing ? "Pause" : "Play"} data-testid="play">
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
          data={speedOptions(playback.tempo)}
        />
      </Tip>
      <PracticeMenu selection={selection} />
      <Menu closeOnItemClick={false} position="bottom-end" withinPortal>
        <Menu.Target>
          <Tip label="Choose which parts you hear and how: mute parts, play only the solo ones, recorded instruments or a simple synthesizer">
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
          <Menu.Divider />
          <Menu.Label>Sound</Menu.Label>
          <Stack gap={4} px="sm" pb="xs" w={260}>
            <SegmentedControl
              size="xs"
              fullWidth
              value={playback.recorded ? "recorded" : "simple"}
              onChange={(value) => playback.setRecorded(value === "recorded")}
              data={[
                { value: "recorded", label: "Recorded" },
                { value: "simple", label: "Synthesizer" },
              ]}
              aria-label="Instrument sound"
            />
            <Text size="xs" c="dimmed">
              {playback.recorded
                ? "Real recordings of the instruments, soft and loud, downloaded the first time each one plays (about half a megabyte each)."
                : "A simple synthesized sound: no downloads, and each instrument family still sounds different."}
            </Text>
          </Stack>
        </Menu.Dropdown>
      </Menu>
    </Group>
  );
}

/** Practising: metronome, count-in, a loop of the selected bars, and a loop that speeds up. */
function PracticeMenu({ selection }: { selection: Selection }) {
  const practice = usePlayback((s) => s.practice);
  const playing = usePlayback((s) => s.playing);
  const pass = usePlayback((s) => s.pass);
  const tempo = usePlayback((s) => s.tempo);
  const set = usePlayback((s) => s.setPractice);
  const on = practice.metronome || practice.countIn || practice.loop;
  const bars = selection.measures;
  const percent = (value: number) => Math.round(value * 100);
  const fromPercent = (value: string | number, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.round(n) / 100 : fallback;
  };
  return (
    <Menu closeOnItemClick={false} position="bottom-end" withinPortal>
      <Menu.Target>
        <Tip label="Practise: metronome, count-in, loop the selected bars, and a speed trainer that plays them a little faster each time">
          <ActionIcon variant={on ? "light" : "subtle"} size="lg" aria-label="Practice" data-testid="practice">
            <IconMetronome size={18} />
          </ActionIcon>
        </Tip>
      </Menu.Target>
      <Menu.Dropdown>
        <Stack gap="sm" p="xs" w={300}>
          <Switch
            label="Metronome"
            description="A click on every beat, louder on the first beat of each bar"
            checked={practice.metronome}
            onChange={(e) => set({ metronome: e.currentTarget.checked })}
          />
          {practice.metronome && (
            <Slider
              size="sm"
              min={0.1}
              max={1}
              step={0.05}
              value={practice.clickVolume}
              onChange={(clickVolume) => set({ clickVolume })}
              label={(v) => `${percent(v)}%`}
              aria-label="Click volume"
            />
          )}
          <Switch
            label="Count in"
            description="A bar of clicks before the music starts (before a pickup, the beats that lead to it)"
            checked={practice.countIn}
            onChange={(e) => set({ countIn: e.currentTarget.checked })}
          />
          <Switch
            label="Loop"
            description={
              bars
                ? `Repeat ${bars.from === bars.to ? "the selected bar" : "the selected bars"} until you stop`
                : "Repeat the whole piece until you stop; select bars first to repeat only those"
            }
            checked={practice.loop}
            onChange={(e) => set({ loop: e.currentTarget.checked })}
          />
          <Switch
            label="Speed trainer"
            description="Loop, starting slower and a little faster each time round"
            checked={practice.trainer}
            onChange={(e) => set({ trainer: e.currentTarget.checked })}
          />
          {practice.trainer && (
            <Group gap="xs" grow>
              <NumberInput size="xs" label="From" suffix="%" min={25} max={150} step={5} value={percent(practice.start)} onChange={(v) => set({ start: fromPercent(v, practice.start) })} />
              <NumberInput size="xs" label="Faster by" suffix="%" min={1} max={25} value={percent(practice.step)} onChange={(v) => set({ step: fromPercent(v, practice.step) })} />
              <NumberInput size="xs" label="Up to" suffix="%" min={25} max={150} step={5} value={percent(practice.target)} onChange={(v) => set({ target: fromPercent(v, practice.target) })} />
            </Group>
          )}
          {playing && practice.loop && (
            <Text size="xs" c="dimmed" data-testid="practice-pass">
              Round {pass + 1}, at {percent(tempo)}%
            </Text>
          )}
        </Stack>
      </Menu.Dropdown>
    </Menu>
  );
}
