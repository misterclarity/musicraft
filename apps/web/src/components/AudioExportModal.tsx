import { Button, Checkbox, Group, Modal, NumberInput, Progress, SegmentedControl, Select, Stack, Switch, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import { buildPerformance, prettyName, type Score } from "@musicraft/score-core";
import { useMemo, useState } from "react";
import { encodeWav, renderAudio } from "../audio/render";
import { downloadBlob, safeFileName } from "../lib/files";
import { arrangeSeats, soundPositions } from "../stage/layout";
import { partAudible, usePlayback } from "../state/playback";
import { useStage } from "../state/stage";
import { Tip } from "./Tip";
import { unavailable } from "./unavailable";

type Who = "all" | "without" | "choose";

/** WAV files are 16-bit stereo at 44.1 kHz: about 10 MB a minute. */
const BYTES_PER_SECOND = 44100 * 2 * 2;

/** Export the score as audio: every part, a play-along without your own part, or the parts you choose. */
export function AudioExportModal({ score, name, onClose }: { score: Score; name: string; onClose: () => void }) {
  const playback = useMemo(() => usePlayback.getState(), []);
  const stage = useStage();
  const all = score.parts.map((p) => p.id);
  const [who, setWho] = useState<Who>("all");
  const [without, setWithout] = useState(all[0] ?? "");
  const [chosen, setChosen] = useState<string[]>(() => all.filter((id) => partAudible(playback, id)));
  const [speed, setSpeed] = useState(Math.round(playback.tempo * 100));
  const [countIn, setCountIn] = useState(false);
  const [metronome, setMetronome] = useState(false);
  const [hall, setHall] = useState(true);
  const [recorded, setRecorded] = useState(playback.recorded);
  const [progress, setProgress] = useState<number | null>(null);

  const partIds = who === "all" ? all : who === "without" ? all.filter((id) => id !== without) : chosen;
  const nameOf = (id: string) => prettyName(score.parts.find((p) => p.id === id)?.name ?? "");
  const seconds = useMemo(() => buildPerformance(score, { tempoScale: speed / 100 }).duration, [score, speed]);
  const megabytes = Math.max(1, Math.round((seconds * BYTES_PER_SECOND) / 1e6));

  function fileName() {
    let suffix = "";
    if (who === "without") suffix = ` (play-along without ${nameOf(without)})`;
    else if (who === "choose" && partIds.length < all.length) suffix = ` (${partIds.map(nameOf).join(", ")})`;
    if (speed !== 100) suffix += ` at ${speed}%`;
    return `${safeFileName(name)}${suffix}.wav`.replace(/\s+\.wav$/, ".wav");
  }

  async function run() {
    setProgress(0);
    try {
      const positions = soundPositions(arrangeSeats(score, stage.venue, stage.seats));
      const buffer = await renderAudio(score, {
        partIds,
        speed: speed / 100,
        countIn,
        metronome,
        recorded,
        room: hall ? "hall" : "dry",
        volumes: playback.volumes,
        positions,
        onProgress: (fraction) => setProgress(Math.round(fraction * 100)),
      });
      downloadBlob(encodeWav(buffer), fileName());
      onClose();
    } catch (error) {
      notifications.show({ color: "red", title: "Export failed", message: (error as Error).message });
      setProgress(null);
    }
  }

  const nothing = partIds.length === 0;
  return (
    <Modal opened onClose={onClose} title="Audio file (WAV)">
      <Stack>
        <Stack gap={4}>
          <Text size="sm" fw={500}>
            Parts
          </Text>
          <Tip label="Every part; or a play-along without the part you play yourself; or just the parts you tick">
            <SegmentedControl
              value={who}
              onChange={(v) => setWho(v as Who)}
              data={[
                { value: "all", label: "Every part" },
                { value: "without", label: "Play-along" },
                { value: "choose", label: "Choose" },
              ]}
            />
          </Tip>
          {who === "without" && (
            <Select
              label="Leave out the part you play"
              value={without}
              onChange={(v) => v && setWithout(v)}
              allowDeselect={false}
              data={score.parts.map((p) => ({ value: p.id, label: prettyName(p.name) }))}
            />
          )}
          {who === "choose" &&
            score.parts.map((p) => (
              <Checkbox
                key={p.id}
                label={prettyName(p.name)}
                checked={chosen.includes(p.id)}
                onChange={(e) => setChosen((ids) => (e.currentTarget.checked ? [...ids, p.id] : ids.filter((id) => id !== p.id)))}
              />
            ))}
        </Stack>
        <NumberInput
          label="Speed"
          description="Slower for practising; the pitch stays the same"
          suffix="%"
          min={25}
          max={200}
          step={5}
          value={speed}
          onChange={(v) => setSpeed(Math.max(25, Math.min(200, Math.round(Number(v) || 100))))}
          w={160}
        />
        <Stack gap="xs">
          <Switch label="Count in" description="A bar of clicks before the music starts" checked={countIn} onChange={(e) => setCountIn(e.currentTarget.checked)} />
          <Switch label="Metronome" description="A click on every beat" checked={metronome} onChange={(e) => setMetronome(e.currentTarget.checked)} />
          <Switch label="Concert hall" description="The hall's reverberation; off for a dry sound" checked={hall} onChange={(e) => setHall(e.currentTarget.checked)} />
          <Switch
            label="Recorded instruments"
            description="Off: the simple synthesizer"
            checked={recorded}
            onChange={(e) => setRecorded(e.currentTarget.checked)}
          />
        </Stack>
        <Text size="xs" c="dimmed">
          {Math.round(seconds)} seconds of stereo audio, about {megabytes} MB. The parts keep their seats from the stage, and the volumes set in the play bar.
        </Text>
        {progress !== null && <Progress value={progress} animated />}
        <Group justify="flex-end">
          <Tip label="Close without exporting">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
          </Tip>
          <Tip label={nothing ? "Choose at least one part first" : "Make the audio file and save it"}>
            <Button onClick={() => !nothing && void run()} loading={progress !== null} {...unavailable(nothing)}>
              Download WAV
            </Button>
          </Tip>
        </Group>
      </Stack>
    </Modal>
  );
}
