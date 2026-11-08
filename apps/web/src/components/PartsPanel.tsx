import { ActionIcon, Button, Group, Menu, Modal, Paper, Select, Stack, Text } from "@mantine/core";
import {
  addPart,
  describeTransposition,
  getInstrument,
  movePart,
  prettyName,
  removePart,
  renamePart,
  shiftOctaves,
  type Score,
} from "@musicraft/score-core";
import {
  IconArrowDown,
  IconArrowsExchange,
  IconArrowUp,
  IconDots,
  IconMusic,
  IconPencil,
  IconPlus,
  IconTransfer,
  IconTrash,
  IconWand,
} from "@tabler/icons-react";
import { useState } from "react";
import { modals } from "../lib/modals";
import { ArrangeModal } from "./ArrangeModal";
import { ChangeInstrumentModal } from "./ChangeInstrumentModal";
import { instrumentOptions } from "./NewScoreModal";
import { TransposeModal } from "./TransposeModal";

type Dialog =
  | { kind: "instrument"; partId: string }
  | { kind: "transpose"; partId?: string }
  | { kind: "add" }
  | { kind: "arrange" }
  | null;

export function PartsPanel({
  score,
  projectName,
  onApply,
  selectedPartIds,
  onSelectPart,
}: {
  score: Score;
  projectName: string;
  onApply: (next: Score, label: string, checkpoint?: boolean) => void;
  selectedPartIds?: string[];
  onSelectPart?: (partId: string) => void;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const [newInstrument, setNewInstrument] = useState("trumpet-bb");

  return (
    <Stack gap="sm">
      <Group gap="xs">
        <Button size="xs" leftSection={<IconTransfer size={14} />} onClick={() => setDialog({ kind: "transpose" })}>
          Transpose score
        </Button>
        <Button size="xs" variant="default" leftSection={<IconPlus size={14} />} onClick={() => setDialog({ kind: "add" })}>
          Add part
        </Button>
        <Button size="xs" variant="default" leftSection={<IconWand size={14} />} onClick={() => setDialog({ kind: "arrange" })}>
          Arrange for…
        </Button>
      </Group>
      {score.parts.map((part, index) => {
        const instrument = getInstrument(part.instrument);
        const selected = selectedPartIds?.includes(part.id);
        return (
          <Paper
            key={part.id}
            withBorder
            p="sm"
            radius="md"
            style={{ borderColor: selected ? "var(--mantine-color-blue-5)" : undefined, cursor: "pointer" }}
            onClick={() => onSelectPart?.(part.id)}
            data-testid="part-card"
          >
            <Group justify="space-between" wrap="nowrap" align="flex-start">
              <Stack gap={2} style={{ minWidth: 0 }}>
                <Text fw={600} size="sm" truncate>
                  {prettyName(part.name)}
                </Text>
                <Text size="xs" c="dimmed">
                  {prettyName(instrument.name)} · {describeTransposition(instrument)}
                </Text>
              </Stack>
              <Menu position="bottom-end" withinPortal>
                <Menu.Target>
                  <ActionIcon variant="subtle" aria-label={`Actions for ${part.name}`} onClick={(e) => e.stopPropagation()}>
                    <IconDots size={16} />
                  </ActionIcon>
                </Menu.Target>
                <Menu.Dropdown onClick={(e) => e.stopPropagation()}>
                  <Menu.Item leftSection={<IconArrowsExchange size={14} />} onClick={() => setDialog({ kind: "instrument", partId: part.id })}>
                    Change instrument…
                  </Menu.Item>
                  <Menu.Item leftSection={<IconTransfer size={14} />} onClick={() => setDialog({ kind: "transpose", partId: part.id })}>
                    Transpose part…
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<IconArrowUp size={14} />}
                    onClick={() => onApply(shiftOctaves(score, 1, { partIds: [part.id] }), `${prettyName(part.name)}: up an octave`)}
                  >
                    Octave up
                  </Menu.Item>
                  <Menu.Item
                    leftSection={<IconArrowDown size={14} />}
                    onClick={() => onApply(shiftOctaves(score, -1, { partIds: [part.id] }), `${prettyName(part.name)}: down an octave`)}
                  >
                    Octave down
                  </Menu.Item>
                  <Menu.Divider />
                  <Menu.Item
                    leftSection={<IconPencil size={14} />}
                    onClick={async () => {
                      const name = await modals.prompt("Rename part", part.name);
                      if (name) onApply(renamePart(score, part.id, name), `Rename part to ${name}`);
                    }}
                  >
                    Rename…
                  </Menu.Item>
                  <Menu.Item disabled={index === 0} leftSection={<IconArrowUp size={14} />} onClick={() => onApply(movePart(score, part.id, index - 1), "Move part up")}>
                    Move up
                  </Menu.Item>
                  <Menu.Item
                    disabled={index === score.parts.length - 1}
                    leftSection={<IconArrowDown size={14} />}
                    onClick={() => onApply(movePart(score, part.id, index + 1), "Move part down")}
                  >
                    Move down
                  </Menu.Item>
                  <Menu.Divider />
                  <Menu.Item
                    color="red"
                    disabled={score.parts.length <= 1}
                    leftSection={<IconTrash size={14} />}
                    onClick={async () => {
                      if (await modals.confirm(`Remove ${prettyName(part.name)}?`, "Its music is removed from the score. You can undo this.", { confirmLabel: "Remove" })) {
                        onApply(removePart(score, part.id), `Remove ${prettyName(part.name)}`, true);
                      }
                    }}
                  >
                    Remove part
                  </Menu.Item>
                </Menu.Dropdown>
              </Menu>
            </Group>
          </Paper>
        );
      })}

      {dialog?.kind === "instrument" && (
        <ChangeInstrumentModal opened onClose={() => setDialog(null)} score={score} partId={dialog.partId} onApply={(next, label) => onApply(next, label, true)} />
      )}
      {dialog?.kind === "transpose" && (
        <TransposeModal opened onClose={() => setDialog(null)} score={score} partId={dialog.partId} onApply={(next, label) => onApply(next, label, true)} />
      )}
      {dialog?.kind === "arrange" && (
        <ArrangeModal opened onClose={() => setDialog(null)} score={score} projectName={projectName} onApply={(next, label) => onApply(next, label, true)} />
      )}
      {dialog?.kind === "add" && (
        <Modal opened onClose={() => setDialog(null)} title="Add a part">
          <Stack>
            <Select label="Instrument" searchable value={newInstrument} onChange={(v) => setNewInstrument(v ?? "trumpet-bb")} data={instrumentOptions()} allowDeselect={false} />
            <Group justify="flex-end">
              <Button variant="default" onClick={() => setDialog(null)}>
                Cancel
              </Button>
              <Button
                leftSection={<IconMusic size={14} />}
                onClick={() => {
                  onApply(addPart(score, newInstrument), `Add ${prettyName(getInstrument(newInstrument).name)}`, true);
                  setDialog(null);
                }}
              >
                Add
              </Button>
            </Group>
          </Stack>
        </Modal>
      )}
    </Stack>
  );
}
