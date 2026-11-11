import { Alert, Button, Group, Modal, Radio, Select, Stack, Text, TextInput } from "@mantine/core";
import {
  addIntervals,
  changeInstrument,
  checkScore,
  describeTransposition,
  getInstrument,
  intervalWords,
  isUnison,
  negateInterval,
  prettyName,
  renameKey,
  type InstrumentChangeMode,
  type Score,
} from "@musicraft/score-core";
import { useMemo, useState } from "react";
import { instrumentOptions } from "./NewScoreModal";
import { Tip } from "./Tip";

export function ChangeInstrumentModal({
  opened,
  onClose,
  score,
  partId,
  onApply,
}: {
  opened: boolean;
  onClose: () => void;
  score: Score;
  partId: string;
  onApply: (next: Score, label: string) => void;
}) {
  const part = score.parts.find((p) => p.id === partId)!;
  const current = getInstrument(part.instrument);
  const [instrumentId, setInstrumentId] = useState(part.instrument);
  const [mode, setMode] = useState<InstrumentChangeMode>("keep-sounding");
  const target = getInstrument(instrumentId);
  const keepsName = part.name !== current.name;
  const [name, setName] = useState(keepsName ? part.name : target.name);

  const preview = useMemo(() => {
    if (instrumentId === part.instrument) return null;
    let explanation: string;
    if (mode === "keep-sounding") {
      // Written notes move by old transposition − new transposition.
      const delta = addIntervals(current.transposition, negateInterval(target.transposition));
      const down = delta.diatonic < 0 || (delta.diatonic === 0 && delta.chromatic < 0);
      explanation = isUnison(delta)
        ? "The written notes stay the same; only the name, sound and range checks change."
        : `The music sounds the same. The written notes move ${down ? "down" : "up"} ${intervalWords(delta)}.`;
    } else {
      const delta = addIntervals(target.transposition, negateInterval(current.transposition));
      const down = delta.diatonic < 0 || (delta.diatonic === 0 && delta.chromatic < 0);
      explanation = isUnison(delta)
        ? "The written notes stay the same and so does the sound."
        : `The written notes stay the same. The music will sound ${down ? "lower" : "higher"} by ${intervalWords(delta)}.`;
    }
    let next: Score | undefined;
    let outOfRange = 0;
    let uncomfortable = 0;
    try {
      next = changeInstrument(score, partId, instrumentId, { mode, name: name.trim() || undefined });
      for (const issue of checkScore(next)) {
        if (issue.partId !== partId) continue;
        if (issue.code === "out-of-range") outOfRange++;
        if (issue.code === "uncomfortable-range") uncomfortable++;
      }
    } catch {
      next = undefined;
    }
    return { explanation, next, outOfRange, uncomfortable };
  }, [instrumentId, mode, name, score, partId, part.instrument, current, target]);

  return (
    <Modal opened={opened} onClose={onClose} title={`Change instrument of ${prettyName(part.name)}`} size="lg">
      <Stack>
        <Text size="sm" c="dimmed">
          Now: {prettyName(current.name)} — {describeTransposition(current)}.
        </Text>
        <Select
          label="New instrument"
          searchable
          value={instrumentId}
          onChange={(v) => {
            const id = v ?? part.instrument;
            setInstrumentId(id);
            // A custom name keeps its wording; only the pitch word follows ("1st Bb Trumpet" → "1st C Trumpet").
            setName(keepsName ? renameKey(part.name, current, getInstrument(id)) : getInstrument(id).name);
          }}
          data={instrumentOptions()}
          allowDeselect={false}
          data-autofocus
        />
        <Text size="xs" c="dimmed">
          {prettyName(target.name)} {describeTransposition(target)}.
        </Text>
        <Radio.Group value={mode} onChange={(v) => setMode(v as InstrumentChangeMode)} label="What should stay the same?">
          <Stack gap="xs" mt="xs">
            <Radio value="keep-sounding" label="How it sounds — rewrite the part for the new instrument (e.g. B♭ trumpet → C trumpet)" />
            <Radio value="keep-written" label="The written notes — the part was really written for this instrument" />
          </Stack>
        </Radio.Group>
        <TextInput label="Part name" value={name} onChange={(e) => setName(e.currentTarget.value)} />
        {preview && (
          <Alert color={preview.outOfRange ? "orange" : "blue"} variant="light">
            <Stack gap={4}>
              <Text size="sm">{preview.explanation}</Text>
              {preview.outOfRange > 0 && (
                <Text size="sm">
                  {preview.outOfRange} bar{preview.outOfRange > 1 ? "s" : ""} will have notes outside the range of{" "}
                  {prettyName(target.name)}; you can move them by octaves afterwards.
                </Text>
              )}
              {preview.outOfRange === 0 && preview.uncomfortable > 0 && (
                <Text size="sm">
                  {preview.uncomfortable} bar{preview.uncomfortable > 1 ? "s" : ""} go outside the comfortable range.
                </Text>
              )}
            </Stack>
          </Alert>
        )}
        <Group justify="flex-end">
          <Tip label="Close without changing the instrument">
            <Button variant="default" onClick={onClose}>
              Cancel
            </Button>
          </Tip>
          <Tip label={!preview?.next && name === part.name ? "Choose another instrument or name first" : "Rewrite the part for the new instrument (Undo takes it back)"}>
            <Button
              data-disabled={(!preview?.next && name === part.name) || undefined}
              onClick={() => {
                if (!preview?.next && name === part.name) return;
                const next = preview?.next ?? changeInstrument(score, partId, instrumentId, { mode, name: name.trim() || undefined });
                onApply(next, `${prettyName(part.name)}: ${prettyName(current.name)} → ${prettyName(target.name)}`);
                onClose();
              }}
            >
              Change
            </Button>
          </Tip>
        </Group>
      </Stack>
    </Modal>
  );
}
