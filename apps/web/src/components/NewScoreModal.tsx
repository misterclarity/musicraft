import { Button, Group, Modal, NumberInput, Select, SimpleGrid, Stack, TextInput } from "@mantine/core";
import {
  ENSEMBLES,
  INSTRUMENTS,
  keyName,
  newScore,
  prettyName,
  type Mode,
} from "@musicraft/score-core";
import { useState } from "react";

const TIME_SIGNATURES = ["4/4", "3/4", "2/4", "2/2", "6/8", "9/8", "12/8", "5/4", "3/8"];

export function keyOptions(mode: Mode = "major") {
  return Array.from({ length: 15 }, (_, i) => {
    const fifths = i - 7;
    return { value: String(fifths), label: keyName({ fifths, mode }) };
  });
}

export const FAMILY_LABELS: Record<string, string> = {
  brass: "Brass",
  woodwind: "Woodwinds",
  strings: "Strings",
  keyboard: "Keyboards",
  voice: "Voices",
  other: "Other",
};

export function instrumentOptions() {
  const groups = new Map<string, { value: string; label: string }[]>();
  for (const i of INSTRUMENTS) {
    const group = FAMILY_LABELS[i.family] ?? "Other";
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push({ value: i.id, label: prettyName(i.name) });
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }));
}

export function NewScoreModal({
  opened,
  onClose,
  onCreate,
}: {
  opened: boolean;
  onClose: () => void;
  onCreate: (name: string, score: ReturnType<typeof newScore>) => void;
}) {
  const [title, setTitle] = useState("");
  const [composer, setComposer] = useState("");
  const [ensemble, setEnsemble] = useState<string>("brass-quintet");
  const [instrument, setInstrument] = useState<string>("trumpet-bb");
  const [fifths, setFifths] = useState("0");
  const [mode, setMode] = useState<Mode>("major");
  const [time, setTime] = useState("4/4");
  const [measures, setMeasures] = useState<number>(16);
  const [tempo, setTempo] = useState<number>(100);

  function create() {
    const [beats, beatType] = time.split("/").map(Number) as [number, number];
    const parts =
      ensemble === "single"
        ? [{ instrument }]
        : ENSEMBLES.find((e) => e.id === ensemble)!.parts.map((p) => ({ instrument: p.instrument, name: p.name }));
    const score = newScore({
      title: title.trim() || "Untitled",
      composer: composer.trim() || undefined,
      parts,
      measures,
      time: { beats, beatType },
      key: { fifths: Number(fifths), mode },
      // Compound time (6/8, 9/8, 12/8) is counted in dotted quarters.
      tempo: beatType === 8 && beats % 3 === 0 ? { bpm: tempo, beatUnit: "quarter", beatUnitDots: 1 } : { bpm: tempo, beatUnit: "quarter" },
    });
    onCreate(title.trim() || "Untitled", score);
  }

  return (
    <Modal opened={opened} onClose={onClose} title="New score" size="lg">
      <Stack>
        <SimpleGrid cols={{ base: 1, sm: 2 }}>
          <TextInput label="Title" value={title} onChange={(e) => setTitle(e.currentTarget.value)} data-autofocus />
          <TextInput label="Composer / arranger" value={composer} onChange={(e) => setComposer(e.currentTarget.value)} />
        </SimpleGrid>
        <Select
          label="Ensemble"
          value={ensemble}
          onChange={(v) => setEnsemble(v ?? "brass-quintet")}
          allowDeselect={false}
          data={[
            ...ENSEMBLES.map((e) => ({ value: e.id, label: `${e.name} — ${e.description}` })),
            { value: "single", label: "Single instrument…" },
          ]}
        />
        {ensemble === "single" && (
          <Select
            label="Instrument"
            searchable
            value={instrument}
            onChange={(v) => setInstrument(v ?? "trumpet-bb")}
            allowDeselect={false}
            data={instrumentOptions()}
          />
        )}
        <SimpleGrid cols={{ base: 2, sm: 4 }}>
          <Select label="Key (concert)" value={fifths} onChange={(v) => setFifths(v ?? "0")} data={keyOptions(mode)} allowDeselect={false} />
          <Select
            label="Mode"
            value={mode}
            onChange={(v) => setMode((v as Mode) ?? "major")}
            data={[
              { value: "major", label: "Major" },
              { value: "minor", label: "Minor" },
            ]}
            allowDeselect={false}
          />
          <Select label="Time" value={time} onChange={(v) => setTime(v ?? "4/4")} data={TIME_SIGNATURES} allowDeselect={false} />
          <NumberInput label="Bars" value={measures} min={1} max={500} onChange={(v) => setMeasures(Number(v) || 16)} />
        </SimpleGrid>
        <NumberInput label="Tempo (beats per minute)" value={tempo} min={20} max={300} onChange={(v) => setTempo(Number(v) || 100)} w={220} />
        <Group justify="flex-end">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={create}>Create</Button>
        </Group>
      </Stack>
    </Modal>
  );
}
