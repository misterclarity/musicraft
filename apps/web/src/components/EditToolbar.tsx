import { ActionIcon, Button, Divider, Group, Kbd, Menu, Modal, Stack, Table, Text } from "@mantine/core";
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
import { Tip } from "./Tip";

const ARTICULATIONS: { value: Articulation; label: string; name: string; tip: string }[] = [
  { value: "accent", label: ">", name: "Accent", tip: "Accent: start the note with emphasis" },
  { value: "marcato", label: "^", name: "Marcato", tip: "Marcato: a strong, heavy accent" },
  { value: "staccato", label: "•", name: "Staccato", tip: "Staccato: short and detached" },
  { value: "tenuto", label: "–", name: "Tenuto", tip: "Tenuto: hold the note for its full length" },
  { value: "staccatissimo", label: "▾", name: "Staccatissimo", tip: "Staccatissimo: very short" },
  { value: "fermata", label: "𝄐", name: "Fermata", tip: "Fermata: hold the note longer than written" },
  { value: "breath", label: "’", name: "Breath mark", tip: "Breath mark: a short break after the note" },
];

/** What each dynamic marking asks for. */
const DYNAMIC_MEANINGS: Record<string, string> = {
  ppp: "as quietly as possible",
  pp: "very quiet (pianissimo)",
  p: "quiet (piano)",
  mp: "moderately quiet (mezzo-piano)",
  mf: "moderately loud (mezzo-forte)",
  f: "loud (forte)",
  ff: "very loud (fortissimo)",
  fff: "as loudly as possible",
  sf: "a sudden strong accent (sforzando)",
  sfz: "a sudden strong accent (sforzando)",
  sffz: "a very strong sudden accent",
  fp: "loud, then at once quiet (forte-piano)",
  sfp: "a strong accent, then at once quiet",
  rf: "a sudden increase (rinforzando)",
  rfz: "a sudden increase (rinforzando)",
  fz: "a strong accent (forzando)",
};

/** Why a tool can't be used right now, added to its tip. */
const NEEDS_NOTE = "Select a note or rest first.";
const NEEDS_BAR = "Select a bar first.";

function Tool({
  label,
  name,
  tip,
  onClick,
  active,
  disabled,
  needs = NEEDS_NOTE,
}: {
  label: ReactNode;
  /** The button's name for screen readers (defaults to the tip). */
  name?: string;
  tip: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  needs?: string;
}) {
  return (
    <Tip label={disabled ? `${tip}. ${needs}` : tip}>
      <ActionIcon
        variant={active ? "filled" : "default"}
        size="lg"
        onClick={disabled ? undefined : onClick}
        data-disabled={disabled || undefined}
        aria-disabled={disabled || undefined}
        aria-label={name ?? tip}
        style={{ fontWeight: 700 }}
      >
        {label}
      </ActionIcon>
    </Tip>
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
    <div>
      <Group gap={4} wrap="wrap" px="sm" py={6} data-testid="edit-toolbar">
        {DURATIONS.map((d) => (
          <Tool
            key={d.key}
            label={d.label}
            name={`${d.name} (${d.key})`}
            tip={hasNotes ? `${d.name} (${d.key}): make the selected notes this long` : `${d.name} (${d.key}): the length of the next notes you enter`}
            active={input.type === d.duration.type}
            onClick={() => (hasNotes ? editor.duration(d.duration) : useEditor.getState().setInputDuration(d.duration))}
          />
        ))}
        <Tool label="." name="Dot (.)" tip="Dot (.): make the selected notes half as long again (press again to remove)" onClick={editor.dot} disabled={!hasNotes} />
        <Divider orientation="vertical" />
        <Menu withinPortal position="bottom" opened={notesOpen} onChange={(open) => setNotesOpen(open && hasNotes)}>
          <Menu.Target>
            <Tip label={hasNotes ? "Enter a note by its letter, in the nearest octave (or type A–G)" : `Enter a note by its letter. ${NEEDS_NOTE}`}>
              <Button variant="default" size="compact-md" data-disabled={!hasNotes || undefined} aria-disabled={!hasNotes || undefined} aria-label="Enter a note">
                A–G
              </Button>
            </Tip>
          </Menu.Target>
          <Menu.Dropdown>
            <Group gap={4} p={4}>
              {(["C", "D", "E", "F", "G", "A", "B"] as const).map((step) => (
                <Tip key={step} label={`Enter ${step}, in the octave nearest the note before (key ${step})`}>
                  <Button
                    size="compact-md"
                    variant="default"
                    onClick={() => {
                      editor.enter(step);
                      setNotesOpen(false);
                    }}
                  >
                    {step}
                  </Button>
                </Tip>
              ))}
            </Group>
          </Menu.Dropdown>
        </Menu>
        <Tool label="▲" name="Up a semitone (↑)" tip="Up a semitone (↑). Alt+↑ moves up a step in the key instead" onClick={() => editor.move({ semitones: 1 })} disabled={!hasNotes} />
        <Tool label="▼" name="Down a semitone (↓)" tip="Down a semitone (↓). Alt+↓ moves down a step in the key instead" onClick={() => editor.move({ semitones: -1 })} disabled={!hasNotes} />
        <Tool label="8▲" name="Up an octave (Ctrl+↑)" tip="Up an octave (Ctrl+↑)" onClick={() => editor.move({ octaves: 1 })} disabled={!hasNotes} />
        <Tool label="8▼" name="Down an octave (Ctrl+↓)" tip="Down an octave (Ctrl+↓)" onClick={() => editor.move({ octaves: -1 })} disabled={!hasNotes} />
        <Tool label="♭" name="Flatten (-)" tip="Flatten (-): lower the note a semitone with a flat, e.g. B → B♭" onClick={() => editor.alter(-1)} disabled={!hasNotes} />
        <Tool label="♯" name="Sharpen (#)" tip="Sharpen (#): raise the note a semitone with a sharp, e.g. F → F♯" onClick={() => editor.alter(1)} disabled={!hasNotes} />
        <Tool label="⇄" name="Respell C♯ ↔ D♭ (J)" tip="Respell (J): the same sound under its other name, e.g. C♯ ↔ D♭" onClick={editor.respell} disabled={!hasNotes} />
        <Tool label="⌒" name="Tie to next note (+)" tip="Tie (+): join the note to the next one of the same pitch, so they sound as one" onClick={editor.tie} disabled={!hasNotes} />
        <Tool label={<IconTrash size={16} />} name="Make rest (Delete or 0)" tip="Make rest (Delete or 0): turn the selected notes into rests" onClick={editor.remove} disabled={!hasNotes} />
        <Divider orientation="vertical" />
        {ARTICULATIONS.map((a) => (
          <Tool key={a.value} label={a.label} name={a.name} tip={`${a.tip} (press again to remove)`} onClick={() => editor.articulation(a.value)} disabled={!hasNotes} />
        ))}
        <Menu withinPortal position="bottom" opened={dynamicsOpen} onChange={(open) => setDynamicsOpen(open && hasNotes)}>
          <Menu.Target>
            <Tip label={hasNotes ? "Put a dynamic (ppp … fff, sf, fp) at the selected note" : `Dynamics. ${NEEDS_NOTE}`}>
              <Button
                variant="default"
                size="compact-md"
                data-disabled={!hasNotes || undefined}
                aria-disabled={!hasNotes || undefined}
                style={{ fontStyle: "italic", fontWeight: 700, fontFamily: "Times, serif" }}
                aria-label="Dynamics"
              >
                mf
              </Button>
            </Tip>
          </Menu.Target>
          <Menu.Dropdown>
            <Group gap={4} p={4} maw={260}>
              {DYNAMICS.map((d) => (
                <Tip key={d} label={`${d}: ${DYNAMIC_MEANINGS[d] ?? "dynamic"}`}>
                  <Button
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
                </Tip>
              ))}
            </Group>
            <Menu.Item onClick={() => editor.dynamic(null)}>Remove dynamic</Menu.Item>
          </Menu.Dropdown>
        </Menu>
        <Menu withinPortal position="bottom" disabled={!hasNotes}>
          <Menu.Target>
            <Tip label={hasNotes ? "Add a note above the selected one to make a chord (Alt+3 adds a third)" : `Add a note to make a chord. ${NEEDS_NOTE}`}>
              <ActionIcon variant="default" size="lg" data-disabled={!hasNotes || undefined} aria-disabled={!hasNotes || undefined} aria-label="Add a note above">
                <IconMusicPlus size={16} />
              </ActionIcon>
            </Tip>
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
        <Menu withinPortal position="bottom" disabled={!hasBars}>
          <Menu.Target>
            <Tip
              label={
                hasBars
                  ? "Bar settings: insert or delete bars, key and time signatures, clef, tempo, rehearsal marks, barlines and repeats, multi-bar rests, copy and paste"
                  : `Bar settings. ${NEEDS_BAR}`
              }
            >
              <Button variant="default" size="compact-md" leftSection={<IconSettings2 size={14} />} data-disabled={!hasBars || undefined} aria-disabled={!hasBars || undefined}>
                Bar
              </Button>
            </Tip>
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
            <Menu.Item onClick={() => onBarDialog("multirest")}>Multi-bar rest…</Menu.Item>
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
        <Tool label={<IconHelp size={16} />} name="Keyboard shortcuts" tip="Keyboard shortcuts: every key for entering and editing notes" onClick={help.open} />
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
                  ["2 – 7", "Length: 2 = 32nd, 3 = 16th, 4 = eighth, 5 = quarter, 6 = half, 7 = whole"],
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
    </div>
  );
}
