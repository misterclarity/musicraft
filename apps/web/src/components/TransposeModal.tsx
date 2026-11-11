import { Alert, Button, Group, Modal, SegmentedControl, Select, Stack, Text } from "@mantine/core";
import {
  concertKeys,
  intervalFifths,
  intervalToKey,
  intervalWords,
  keyName,
  parseInterval,
  prettyName,
  shiftOctaves,
  transposeDiatonic,
  transposeScore,
  type Interval,
  type Score,
} from "@musicraft/score-core";
import { useMemo, useState } from "react";
import { keyOptions } from "./NewScoreModal";
import { Tip } from "./Tip";

const INTERVALS = [
  { value: "m2", label: "minor 2nd (1 semitone)" },
  { value: "M2", label: "major 2nd (2 semitones)" },
  { value: "m3", label: "minor 3rd (3 semitones)" },
  { value: "M3", label: "major 3rd (4 semitones)" },
  { value: "P4", label: "perfect 4th (5 semitones)" },
  { value: "A4", label: "augmented 4th (tritone)" },
  { value: "d5", label: "diminished 5th (tritone)" },
  { value: "P5", label: "perfect 5th (7 semitones)" },
  { value: "m6", label: "minor 6th (8 semitones)" },
  { value: "M6", label: "major 6th (9 semitones)" },
  { value: "m7", label: "minor 7th (10 semitones)" },
  { value: "M7", label: "major 7th (11 semitones)" },
  { value: "P8", label: "octave" },
];

const STEPS = [
  { value: "1", label: "a step (2nd)" },
  { value: "2", label: "a 3rd" },
  { value: "3", label: "a 4th" },
  { value: "4", label: "a 5th" },
  { value: "5", label: "a 6th" },
  { value: "6", label: "a 7th" },
];

type Mode = "interval" | "key" | "octave" | "diatonic";

export function TransposeModal({
  opened,
  onClose,
  score,
  partId,
  range,
  onApply,
}: {
  opened: boolean;
  onClose: () => void;
  score: Score;
  /** Transpose only this part; the whole score otherwise. */
  partId?: string;
  /** Only these bars (measure indexes). */
  range?: { from: number; to: number };
  onApply: (next: Score, label: string) => void;
}) {
  const [mode, setMode] = useState<Mode>(partId || range ? "octave" : "key");
  const [direction, setDirection] = useState<"up" | "down" | "nearest">(partId || range ? "up" : "nearest");
  const [interval, setInterval] = useState("M2");
  const [octaves, setOctaves] = useState("1");
  const [steps, setSteps] = useState("2");
  const currentKey = concertKeys(score)[range?.from ?? 0] ?? { fifths: 0 };
  const [targetKey, setTargetKey] = useState(String(currentKey.fifths));
  const part = partId ? score.parts.find((p) => p.id === partId) : undefined;
  const scopeLabel = `${part ? prettyName(part.name) : "the whole score"}${range ? `, bars ${score.measures[range.from]?.number}–${score.measures[range.to]?.number}` : ""}`;
  const options = { partIds: partId ? [partId] : undefined, from: range?.from, to: range?.to };

  const plan = useMemo((): { describe: string; apply: () => Score; warn?: string } | null => {
    const sign = direction === "down" ? -1 : 1;
    if (mode === "octave") {
      const n = Number(octaves) * (direction === "down" ? -1 : 1);
      return {
        describe: `${direction === "down" ? "Down" : "Up"} ${Math.abs(n) === 1 ? "an octave" : `${Math.abs(n)} octaves`}`,
        apply: () => shiftOctaves(score, n, options),
      };
    }
    if (mode === "diatonic") {
      const n = Number(steps) * (direction === "down" ? -1 : 1);
      return {
        describe: `${direction === "down" ? "Down" : "Up"} ${STEPS.find((s) => s.value === steps)?.label} within the key`,
        apply: () => transposeDiatonic(score, n, options),
      };
    }
    let iv: Interval;
    if (mode === "key") {
      iv = intervalToKey(currentKey, { fifths: Number(targetKey), mode: currentKey.mode }, direction);
    } else {
      const base = parseInterval(interval);
      iv = { diatonic: sign * base.diatonic, chromatic: sign * base.chromatic };
    }
    const keyMoves = !partId && !range;
    const newKey = keyName({ fifths: currentKey.fifths + intervalFifths(iv), mode: currentKey.mode });
    const down = iv.diatonic < 0 || (iv.diatonic === 0 && iv.chromatic < 0);
    const ivText = iv.diatonic === 0 && iv.chromatic === 0 ? "no change" : `${down ? "down" : "up"} ${intervalWords(iv)}`;
    return {
      describe: keyMoves ? `${keyName(currentKey)} → ${newKey} (${ivText})` : ivText.charAt(0).toUpperCase() + ivText.slice(1),
      apply: () => transposeScore(score, iv, options),
      warn:
        !keyMoves && intervalFifths(iv) !== 0
          ? "Key signatures are shared by all parts, so only the notes move; they will be written with accidentals."
          : undefined,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, direction, interval, octaves, steps, targetKey, score, partId, range]);

  return (
    <Modal opened={opened} onClose={onClose} title={`Transpose ${scopeLabel}`} size="md">
      <Stack>
        <Tip label="To a key: move the music into another key. By interval: by any interval. Octaves: one or two octaves up or down. Within key: by steps of the current scale">
        <SegmentedControl
          value={mode}
          onChange={(v) => {
            setMode(v as Mode);
            if (v === "key") setDirection("nearest");
            else if (direction === "nearest") setDirection("up");
          }}
          data={[
            ...(!partId && !range ? [{ value: "key", label: "To a key" }] : []),
            { value: "interval", label: "By interval" },
            { value: "octave", label: "Octaves" },
            { value: "diatonic", label: "Within key" },
          ]}
        />
        </Tip>
        {mode === "key" && (
          <Select label="New key (concert pitch)" value={targetKey} onChange={(v) => setTargetKey(v ?? "0")} data={keyOptions(currentKey.mode)} allowDeselect={false} />
        )}
        {mode === "interval" && <Select label="Interval" value={interval} onChange={(v) => setInterval(v ?? "M2")} data={INTERVALS} allowDeselect={false} />}
        {mode === "octave" && (
          <Select
            label="How far"
            value={octaves}
            onChange={(v) => setOctaves(v ?? "1")}
            data={[
              { value: "1", label: "One octave" },
              { value: "2", label: "Two octaves" },
            ]}
            allowDeselect={false}
          />
        )}
        {mode === "diatonic" && <Select label="How far" value={steps} onChange={(v) => setSteps(v ?? "2")} data={STEPS} allowDeselect={false} />}
        <Tip label="Which way to move the notes (nearest picks the smaller move)">
        <SegmentedControl
          value={direction}
          onChange={(v) => setDirection(v as "up" | "down" | "nearest")}
          data={[
            ...(mode === "key" ? [{ value: "nearest", label: "Nearest" }] : []),
            { value: "up", label: "Up" },
            { value: "down", label: "Down" },
          ]}
        />
        </Tip>
        {plan && (
          <Text size="sm">
            <b>Result:</b> {plan.describe}
          </Text>
        )}
        {plan?.warn && (
          <Alert color="yellow" variant="light">
            {plan.warn}
          </Alert>
        )}
        <Group justify="flex-end">
          <Tip label="Close without transposing">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
          </Tip>
          <Tip label="Transpose now (Undo takes it back)">
          <Button
            onClick={() => {
              if (!plan) return;
              onApply(plan.apply(), `Transpose ${scopeLabel}: ${plan.describe}`);
              onClose();
            }}
          >
            Transpose
          </Button>
          </Tip>
        </Group>
      </Stack>
    </Modal>
  );
}
