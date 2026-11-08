import { ActionIcon, Button, Divider, Group, Kbd, Menu, Modal, ScrollArea, Stack, Table, Text, Tooltip } from "@mantine/core";
import { useDisclosure } from "@mantine/hooks";
import { DYNAMICS, type Articulation } from "@musicraft/score-core";
import {
  IconArrowBarLeft,
  IconArrowBarRight,
  IconClipboard,
  IconCopy,
  IconHelp,
  IconMusicPlus,
  IconSettings2,
  IconTrash,
} from "@tabler/icons-react";
import { useState, type ReactNode } from "react";
import { DURATIONS, editor, useEditor } from "../lib/editor";
import type { Selection } from "../state/project";
import type { BarDialog } from "./BarDialogs";

const ARTICULATIONS: { value: Articulation; label: string; name: string }[] = [
  { value: "accent", label: ">", name: "Accent" },
  { value: "marcato", label: "^", name: "Marcato" },
  { value: "staccato", label: "•", name: "Staccato" },
  { value: "tenuto", label: "–", name: "Tenuto" },
  { value: "staccatissimo", label: "▾", name: "Staccatissimo" },
  { value: "fermata", label: "𝄐", name: "Fermata" },
  { value: "breath", label: "’", name: "Breath mark" },
];

function Tool({ label, tip, onClick, active, disabled }: { label: ReactNode; tip: string; onClick: () => void; active?: boolean; disabled?: boolean }) {
  return (
    <Tooltip label={tip} openDelay={300}>
      <ActionIcon variant={active ? "filled" : "default"} size="lg" onClick={onClick} disabled={disabled} aria-label={tip} style={{ fontWeight: 700 }}>
        {label}
      </ActionIcon>
    </Tooltip>
  );
}

/** Note and bar editing tools; works with a mouse/touch and mirrors the keyboard shortcuts. */
export function EditToolbar({ selection, onBarDialog }: { selection: Selection; onBarDialog: (dialog: BarDialog) => void }) {
  const input = useEditor((s) => s.inputDuration);
  const clipboard = useEditor((s) => s.clipboard);
  const [helpOpen, help] = useDisclosure(false);
  const [dynamicsOpen, setDynamicsOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  const hasNotes = selection.eventIds.length > 0;
  const hasBars = !!selection.measures;

  return (
    <ScrollArea type="never" offsetScrollbars={false}>
      <Group gap={4} wrap="nowrap" px="sm" py={6} data-testid="edit-toolbar">
        {DURATIONS.map((d) => (
          <Tool
            key={d.key}
            label={d.label}
            tip={`${d.name} (${d.key})`}
            active={input.type === d.duration.type}
            onClick={() => (hasNotes ? editor.duration(d.duration) : useEditor.getState().setInputDuration(d.duration))}
          />
        ))}
        <Tool label="." tip="Dot (.)" onClick={editor.dot} disabled={!hasNotes} />
        <Divider orientation="vertical" />
        <Menu withinPortal position="bottom" opened={notesOpen} onChange={setNotesOpen}>
          <Menu.Target>
            <Button variant="default" size="compact-md" disabled={!hasNotes} aria-label="Enter a note">
              A–G
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Group gap={4} p={4}>
              {(["C", "D", "E", "F", "G", "A", "B"] as const).map((step) => (
                <Button
                  key={step}
                  size="compact-md"
                  variant="default"
                  onClick={() => {
                    editor.enter(step);
                    setNotesOpen(false);
                  }}
                >
                  {step}
                </Button>
              ))}
            </Group>
          </Menu.Dropdown>
        </Menu>
        <Tool label="▲" tip="Up a semitone (↑)" onClick={() => editor.move({ semitones: 1 })} disabled={!hasNotes} />
        <Tool label="▼" tip="Down a semitone (↓)" onClick={() => editor.move({ semitones: -1 })} disabled={!hasNotes} />
        <Tool label="8▲" tip="Up an octave (Ctrl+↑)" onClick={() => editor.move({ octaves: 1 })} disabled={!hasNotes} />
        <Tool label="8▼" tip="Down an octave (Ctrl+↓)" onClick={() => editor.move({ octaves: -1 })} disabled={!hasNotes} />
        <Tool label="♭" tip="Flatten (-)" onClick={() => editor.alter(-1)} disabled={!hasNotes} />
        <Tool label="♯" tip="Sharpen (#)" onClick={() => editor.alter(1)} disabled={!hasNotes} />
        <Tool label="⇄" tip="Respell C♯ ↔ D♭ (J)" onClick={editor.respell} disabled={!hasNotes} />
        <Tool label="⌒" tip="Tie to next note (+)" onClick={editor.tie} disabled={!hasNotes} />
        <Tool label={<IconTrash size={16} />} tip="Make rest (Delete or 0)" onClick={editor.remove} disabled={!hasNotes} />
        <Divider orientation="vertical" />
        {ARTICULATIONS.map((a) => (
          <Tool key={a.value} label={a.label} tip={a.name} onClick={() => editor.articulation(a.value)} disabled={!hasNotes} />
        ))}
        <Menu withinPortal position="bottom" opened={dynamicsOpen} onChange={setDynamicsOpen}>
          <Menu.Target>
            <Button variant="default" size="compact-md" disabled={!hasNotes} style={{ fontStyle: "italic", fontWeight: 700, fontFamily: "Times, serif" }} aria-label="Dynamics">
              mf
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Group gap={4} p={4} maw={260}>
              {DYNAMICS.map((d) => (
                <Button
                  key={d}
                  size="compact-sm"
                  variant="default"
                  style={{ fontStyle: "italic", fontFamily: "Times, serif" }}
                  onClick={() => {
                    editor.dynamic(d);
                    setDynamicsOpen(false);
                  }}
                >
                  {d}
                </Button>
              ))}
            </Group>
            <Menu.Item onClick={() => editor.dynamic(null)}>Remove dynamic</Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <Menu withinPortal position="bottom">
          <Menu.Target>
            <Tooltip label="Add a note above (Alt+3 = third)">
              <ActionIcon variant="default" size="lg" disabled={!hasNotes} aria-label="Add a note above">
                <IconMusicPlus size={16} />
              </ActionIcon>
            </Tooltip>
          </Menu.Target>
          <Menu.Dropdown>
            {[
              [1, "Second"],
              [2, "Third"],
              [3, "Fourth"],
              [4, "Fifth"],
              [5, "Sixth"],
              [7, "Octave"],
            ].map(([steps, name]) => (
              <Menu.Item key={steps} onClick={() => editor.chord(steps as number)}>
                {name} above
              </Menu.Item>
            ))}
            <Menu.Item onClick={() => editor.chord(-2)}>Third below</Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <Divider orientation="vertical" />
        <Menu withinPortal position="bottom">
          <Menu.Target>
            <Button variant="default" size="compact-md" leftSection={<IconSettings2 size={14} />} disabled={!hasBars}>
              Bar
            </Button>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<IconArrowBarLeft size={14} />} onClick={() => editor.insertBars("before")}>
              Insert bar before
            </Menu.Item>
            <Menu.Item leftSection={<IconArrowBarRight size={14} />} onClick={() => editor.insertBars("after")}>
              Insert bar after
            </Menu.Item>
            <Menu.Item color="red" leftSection={<IconTrash size={14} />} onClick={editor.deleteBars}>
              Delete selected bars
            </Menu.Item>
            <Menu.Divider />
            <Menu.Item onClick={() => onBarDialog("key")}>Key signature…</Menu.Item>
            <Menu.Item onClick={() => onBarDialog("time")}>Time signature…</Menu.Item>
            <Menu.Item onClick={() => onBarDialog("clef")}>Clef…</Menu.Item>
            <Menu.Item onClick={() => onBarDialog("tempo")}>Tempo…</Menu.Item>
            <Menu.Item onClick={() => onBarDialog("rehearsal")}>Rehearsal mark…</Menu.Item>
            <Menu.Item onClick={() => onBarDialog("barline")}>Barline and repeats…</Menu.Item>
            <Menu.Item disabled={!hasNotes} onClick={() => onBarDialog("text")}>
              Text at the selected note…
            </Menu.Item>
            <Menu.Divider />
            <Menu.Item leftSection={<IconCopy size={14} />} onClick={editor.copy}>
              Copy bars (Ctrl+C)
            </Menu.Item>
            <Menu.Item leftSection={<IconClipboard size={14} />} disabled={!clipboard} onClick={editor.paste}>
              Paste bars (Ctrl+V)
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <Tool label={<IconHelp size={16} />} tip="Keyboard shortcuts" onClick={help.open} />
      </Group>
      <Modal opened={helpOpen} onClose={help.close} title="Keyboard shortcuts" size="lg">
        <Stack gap="xs">
          <Text size="sm" c="dimmed">
            Click a note or rest to select it. Notes you type use the pitch you see (written pitch, or concert pitch when
            "Concert pitch" is on).
          </Text>
          <Table>
            <Table.Tbody>
              {(
                [
                  ["A – G", "Enter that note (nearest octave); on a rest it uses the selected length and moves on"],
                  ["↑ / ↓", "Up / down a semitone"],
                  ["Alt + ↑ / ↓", "Up / down a step in the key"],
                  ["Ctrl + ↑ / ↓", "Up / down an octave"],
                  ["← / →", "Previous / next note"],
                  ["1 – 7", "Length: 2 = 32nd, 3 = 16th, 4 = eighth, 5 = quarter, 6 = half, 7 = whole"],
                  [".", "Add or remove a dot"],
                  ["0, Delete", "Turn into a rest"],
                  ["+", "Tie to the next note"],
                  ["# / -", "Sharpen / flatten"],
                  ["J", "Respell (C♯ ↔ D♭)"],
                  ["Alt + 2…8", "Add a 2nd…octave above"],
                  ["Ctrl + C / V", "Copy / paste selected bars"],
                  ["Ctrl + Z / Y", "Undo / redo"],
                  ["Space", "Play / pause"],
                  ["Esc", "Clear the selection"],
                ] as const
              ).map(([keys, what]) => (
                <Table.Tr key={keys}>
                  <Table.Td style={{ whiteSpace: "nowrap" }}>
                    <Kbd>{keys}</Kbd>
                  </Table.Td>
                  <Table.Td>
                    <Text size="sm">{what}</Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Stack>
      </Modal>
    </ScrollArea>
  );
}
