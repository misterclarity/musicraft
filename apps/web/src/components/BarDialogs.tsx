import { Button, Checkbox, Group, Modal, NumberInput, Select, Stack, Text, TextInput } from "@mantine/core";
import {
  concertKeys,
  getInstrument,
  isUnison,
  keyName,
  setBarline,
  setClef,
  setKeySignature,
  setRehearsal,
  setTempo,
  setText,
  setTimeSignature,
  transposeKey,
  writtenKeyToConcert,
  type BarlineStyle,
  type Clef,
  type KeySignature,
  type NoteType,
  type Score,
} from "@musicraft/score-core";
import { useState, type ReactNode } from "react";
import type { Selection } from "../state/project";

export type BarDialog = "key" | "time" | "clef" | "tempo" | "rehearsal" | "barline" | "text";

const KEY_OPTIONS = Array.from({ length: 15 }, (_, i) => i - 7);

const CLEFS: { value: string; label: string; clef: Clef }[] = [
  { value: "treble", label: "Treble", clef: { sign: "G", line: 2 } },
  { value: "bass", label: "Bass", clef: { sign: "F", line: 4 } },
  { value: "alto", label: "Alto", clef: { sign: "C", line: 3 } },
  { value: "tenor", label: "Tenor", clef: { sign: "C", line: 4 } },
  { value: "treble8vb", label: "Treble 8vb (tenor voice, guitar)", clef: { sign: "G", line: 2, octaveChange: -1 } },
  { value: "percussion", label: "Percussion", clef: { sign: "percussion", line: 3 } },
];

const BEAT_UNITS: { value: string; label: string; unit: NoteType; dots: number }[] = [
  { value: "quarter", label: "♩ quarter", unit: "quarter", dots: 0 },
  { value: "quarter.", label: "♩. dotted quarter", unit: "quarter", dots: 1 },
  { value: "half", label: "𝅗𝅥 half", unit: "half", dots: 0 },
  { value: "half.", label: "𝅗𝅥. dotted half", unit: "half", dots: 1 },
  { value: "eighth", label: "♪ eighth", unit: "eighth", dots: 0 },
];

function clefValue(clef: Clef | undefined): string {
  if (!clef) return "treble";
  return CLEFS.find((c) => c.clef.sign === clef.sign && c.clef.line === clef.line && (c.clef.octaveChange ?? 0) === (clef.octaveChange ?? 0))?.value ?? "treble";
}

interface Props {
  dialog: BarDialog | null;
  score: Score;
  selection: Selection;
  concert: boolean;
  onClose: () => void;
  onApply: (next: Score, label: string) => void;
}

/** Dialogs for bar-level settings: key, time, clef, tempo, rehearsal marks, barlines and text. */
export function BarDialogs({ dialog, score, selection, concert, onClose, onApply }: Props) {
  const measureIndex = selection.measures?.from ?? 0;
  const part = score.parts.find((p) => p.id === selection.partIds?.[0]) ?? score.parts[0];
  const info = score.measures[measureIndex];
  const barLabel = info ? `bar ${info.number}` : "";
  const done = (next: Score, label: string) => {
    onApply(next, label);
    onClose();
  };

  if (!dialog || !info || !part) return null;
  const title = {
    key: `Key signature from ${barLabel}`,
    time: `Time signature from ${barLabel}`,
    clef: `Clef from ${barLabel}`,
    tempo: `Tempo at ${barLabel}`,
    rehearsal: `Rehearsal mark at ${barLabel}`,
    barline: `Barline at the end of ${barLabel}`,
    text: "Text at the selected note",
  }[dialog];

  return (
    <Modal opened onClose={onClose} title={title} centered>
      {dialog === "key" && <KeyForm score={score} measureIndex={measureIndex} partId={part.id} concert={concert} onDone={done} />}
      {dialog === "time" && <TimeForm score={score} measureIndex={measureIndex} onDone={done} />}
      {dialog === "clef" && <ClefForm score={score} measureIndex={measureIndex} partId={part.id} onDone={done} />}
      {dialog === "tempo" && <TempoForm score={score} measureIndex={measureIndex} onDone={done} />}
      {dialog === "rehearsal" && <RehearsalForm score={score} measureIndex={measureIndex} onDone={done} />}
      {dialog === "barline" && <BarlineForm score={score} measureIndex={measureIndex} onDone={done} />}
      {dialog === "text" && <TextForm score={score} eventId={selection.eventIds[0]} onDone={done} />}
    </Modal>
  );
}

type Done = (next: Score, label: string) => void;

function Actions({ onSave, onRemove, removeLabel, saveDisabled }: { onSave: () => void; onRemove?: () => void; removeLabel?: string; saveDisabled?: boolean }) {
  return (
    <Group justify="space-between" mt="sm">
      <div>
        {onRemove && (
          <Button variant="subtle" color="red" onClick={onRemove}>
            {removeLabel ?? "Remove"}
          </Button>
        )}
      </div>
      <Button onClick={onSave} disabled={saveDisabled}>
        Apply
      </Button>
    </Group>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return (
    <Text size="xs" c="dimmed">
      {children}
    </Text>
  );
}

function KeyForm({ score, measureIndex, partId, concert, onDone }: { score: Score; measureIndex: number; partId: string; concert: boolean; onDone: Done }) {
  const part = score.parts.find((p) => p.id === partId)!;
  const instrument = getInstrument(part.instrument);
  // Keys are stored at concert pitch; show them as the selected part reads them.
  const written = !concert && !isUnison(instrument.transposition);
  const concertKey = concertKeys(score)[measureIndex] ?? { fifths: 0 };
  const shown = written ? transposeKey(concertKey, { diatonic: -instrument.transposition.diatonic, chromatic: -instrument.transposition.chromatic }).key : concertKey;
  const [fifths, setFifths] = useState(String(shown.fifths));
  const [mode, setMode] = useState<string>(shown.mode ?? "major");
  const hasChange = !!score.measures[measureIndex]?.key && measureIndex > 0;

  const save = () => {
    const chosen: KeySignature = { fifths: Number(fifths), mode: mode as "major" | "minor" };
    const stored = written ? writtenKeyToConcert(chosen, instrument).key : chosen;
    onDone(setKeySignature(score, measureIndex, stored), `Key: ${keyName(chosen)}`);
  };

  return (
    <Stack gap="sm">
      <Group grow>
        <Select
          label={written ? `Key for ${part.name} (written)` : "Key (concert pitch)"}
          data={KEY_OPTIONS.map((f) => ({ value: String(f), label: `${keyName({ fifths: f, mode: mode as "major" | "minor" })} (${f === 0 ? "no sharps or flats" : f > 0 ? `${f}♯` : `${-f}♭`})` }))}
          value={fifths}
          onChange={(v) => v && setFifths(v)}
          allowDeselect={false}
          comboboxProps={{ withinPortal: true }}
        />
        <Select label="Mode" data={["major", "minor"]} value={mode} onChange={(v) => v && setMode(v)} allowDeselect={false} />
      </Group>
      <Hint>
        The key changes for every part from this bar on; transposing instruments get their own written key. To move the
        notes into another key, use Transpose instead.
      </Hint>
      <Actions
        onSave={save}
        onRemove={hasChange ? () => onDone(setKeySignature(score, measureIndex, null), "Remove key change") : undefined}
        removeLabel="Remove key change"
      />
    </Stack>
  );
}

function TimeForm({ score, measureIndex, onDone }: { score: Score; measureIndex: number; onDone: Done }) {
  let current = score.measures[0]!.time ?? { beats: 4, beatType: 4 };
  for (let i = 0; i <= measureIndex; i++) current = score.measures[i]!.time ?? current;
  const [beats, setBeats] = useState<number>(current.beats);
  const [beatType, setBeatType] = useState(String(current.beatType));
  const [symbol, setSymbol] = useState<string>(current.symbol ?? "none");
  const hasChange = !!score.measures[measureIndex]?.time && measureIndex > 0;
  const canSymbol = (beats === 4 && beatType === "4") || (beats === 2 && beatType === "2");

  return (
    <Stack gap="sm">
      <Group grow>
        <NumberInput label="Beats" min={1} max={32} value={beats} onChange={(v) => setBeats(Number(v) || 1)} />
        <Select label="Beat" data={["1", "2", "4", "8", "16"]} value={beatType} onChange={(v) => v && setBeatType(v)} allowDeselect={false} />
      </Group>
      {canSymbol && (
        <Select
          label="Show as"
          data={[
            { value: "none", label: `${beats}/${beatType}` },
            { value: beats === 4 ? "common" : "cut", label: beats === 4 ? "𝄴 common time" : "𝄵 cut time" },
          ]}
          value={symbol === "none" ? "none" : beats === 4 ? "common" : "cut"}
          onChange={(v) => v && setSymbol(v)}
          allowDeselect={false}
        />
      )}
      <Hint>Notes are not moved: bars that no longer add up are listed under Checks.</Hint>
      <Actions
        onSave={() =>
          onDone(
            setTimeSignature(score, measureIndex, {
              beats,
              beatType: Number(beatType),
              ...(canSymbol && symbol !== "none" ? { symbol: symbol as "common" | "cut" } : {}),
            }),
            `Time: ${beats}/${beatType}`,
          )
        }
        onRemove={hasChange ? () => onDone(setTimeSignature(score, measureIndex, null), "Remove time change") : undefined}
        removeLabel="Remove time change"
      />
    </Stack>
  );
}

function ClefForm({ score, measureIndex, partId, onDone }: { score: Score; measureIndex: number; partId: string; onDone: Done }) {
  const part = score.parts.find((p) => p.id === partId)!;
  // The clef in force at this bar on a staff.
  const clefAt = (staffIndex: number) => {
    let clef = part.clefs[staffIndex - 1];
    for (let i = 1; i <= measureIndex; i++) {
      const change = part.measures[i]?.clefChanges?.filter((c) => c.staff === staffIndex).at(-1);
      if (change) clef = change.clef;
    }
    return clefValue(clef);
  };
  const [staff, setStaff] = useState("1");
  const staffIndex = Number(staff);
  const [value, setValue] = useState(() => clefAt(1));

  return (
    <Stack gap="sm">
      <Text size="sm">{part.name}</Text>
      {part.staves > 1 && (
        <Select
          label="Staff"
          data={Array.from({ length: part.staves }, (_, i) => ({ value: String(i + 1), label: i === 0 ? "Upper staff" : i === 1 ? "Lower staff" : `Staff ${i + 1}` }))}
          value={staff}
          onChange={(v) => {
            if (!v) return;
            setStaff(v);
            setValue(clefAt(Number(v)));
          }}
          allowDeselect={false}
        />
      )}
      <Select label="Clef" data={CLEFS.map((c) => ({ value: c.value, label: c.label }))} value={value} onChange={(v) => v && setValue(v)} allowDeselect={false} />
      <Hint>The notes keep their pitch; only how they are written changes.</Hint>
      <Actions onSave={() => onDone(setClef(score, partId, staffIndex, measureIndex, CLEFS.find((c) => c.value === value)!.clef), `Clef: ${value}`)} />
    </Stack>
  );
}

function TempoForm({ score, measureIndex, onDone }: { score: Score; measureIndex: number; onDone: Done }) {
  const existing = score.measures[measureIndex]!.tempo;
  const [bpm, setBpm] = useState<number>(existing?.bpm ?? 100);
  const [unit, setUnit] = useState(existing ? `${existing.beatUnit}${existing.beatUnitDots ? "." : ""}` : "quarter");
  const [text, setTextValue] = useState(existing?.text ?? "");
  const beat = BEAT_UNITS.find((b) => b.value === unit) ?? BEAT_UNITS[0]!;

  return (
    <Stack gap="sm">
      <Group grow>
        <Select label="Beat" data={BEAT_UNITS.map((b) => ({ value: b.value, label: b.label }))} value={unit} onChange={(v) => v && setUnit(v)} allowDeselect={false} />
        <NumberInput label="Beats per minute" min={20} max={320} value={bpm} onChange={(v) => setBpm(Number(v) || 100)} />
      </Group>
      <TextInput label="Text (optional)" placeholder="Allegro, Swing, Slowly…" value={text} onChange={(e) => setTextValue(e.currentTarget.value)} />
      <Actions
        onSave={() =>
          onDone(
            setTempo(score, measureIndex, { bpm, beatUnit: beat.unit, ...(beat.dots ? { beatUnitDots: beat.dots } : {}), ...(text.trim() ? { text: text.trim() } : {}) }),
            `Tempo ${bpm}`,
          )
        }
        onRemove={existing ? () => onDone(setTempo(score, measureIndex, null), "Remove tempo") : undefined}
        removeLabel="Remove tempo"
      />
    </Stack>
  );
}

function nextRehearsal(score: Score, measureIndex: number): string {
  let last = "";
  for (let i = 0; i < measureIndex; i++) last = score.measures[i]!.rehearsal ?? last;
  if (/^[A-Y]$/.test(last)) return String.fromCharCode(last.charCodeAt(0) + 1);
  if (/^\d+$/.test(last)) return String(Number(last) + 1);
  return last ? "" : "A";
}

function RehearsalForm({ score, measureIndex, onDone }: { score: Score; measureIndex: number; onDone: Done }) {
  const existing = score.measures[measureIndex]!.rehearsal;
  const [text, setTextValue] = useState(existing ?? nextRehearsal(score, measureIndex));
  return (
    <Stack gap="sm">
      <TextInput label="Mark" value={text} onChange={(e) => setTextValue(e.currentTarget.value)} data-autofocus />
      <Actions
        onSave={() => onDone(setRehearsal(score, measureIndex, text), `Rehearsal ${text}`)}
        saveDisabled={!text.trim()}
        onRemove={existing ? () => onDone(setRehearsal(score, measureIndex, null), "Remove rehearsal mark") : undefined}
      />
    </Stack>
  );
}

function BarlineForm({ score, measureIndex, onDone }: { score: Score; measureIndex: number; onDone: Done }) {
  const m = score.measures[measureIndex]!;
  const [style, setStyle] = useState<string>(m.barline ?? "regular");
  const [repeatStart, setRepeatStart] = useState(!!m.repeatStart);
  const [repeatEnd, setRepeatEnd] = useState(!!m.repeatEnd);
  const [times, setTimes] = useState<number>(m.repeatEnd?.times ?? 2);

  return (
    <Stack gap="sm">
      <Select
        label="Barline"
        data={[
          { value: "regular", label: "Single" },
          { value: "double", label: "Double" },
          { value: "final", label: "Final" },
          { value: "dashed", label: "Dashed" },
          { value: "heavy", label: "Heavy" },
        ]}
        value={style}
        onChange={(v) => v && setStyle(v)}
        allowDeselect={false}
      />
      <Checkbox label="Start repeat at the beginning of this bar" checked={repeatStart} onChange={(e) => setRepeatStart(e.currentTarget.checked)} />
      <Checkbox label="End repeat at the end of this bar" checked={repeatEnd} onChange={(e) => setRepeatEnd(e.currentTarget.checked)} />
      {repeatEnd && <NumberInput label="Times played in total" min={2} max={8} value={times} onChange={(v) => setTimes(Number(v) || 2)} w={180} />}
      <Actions
        onSave={() =>
          onDone(
            setBarline(score, measureIndex, {
              barline: style as BarlineStyle,
              repeatStart,
              repeatEnd: repeatEnd ? (times === 2 ? {} : { times }) : undefined,
            }),
            "Barline",
          )
        }
      />
    </Stack>
  );
}

function TextForm({ score, eventId, onDone }: { score: Score; eventId: string | undefined; onDone: Done }) {
  const [text, setTextValue] = useState("");
  if (!eventId) return <Text size="sm">Select a note first.</Text>;
  return (
    <Stack gap="sm">
      <TextInput label="Text above the staff" placeholder="solo, dolce, cresc., mute…" value={text} onChange={(e) => setTextValue(e.currentTarget.value)} data-autofocus />
      <Actions onSave={() => onDone(setText(score, eventId, text), `Text "${text}"`)} onRemove={() => onDone(setText(score, eventId, ""), "Remove text")} removeLabel="Remove text here" />
    </Stack>
  );
}
