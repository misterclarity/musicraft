import { Alert, Button, Checkbox, Group, List, Modal, MultiSelect, Radio, Select, Stack, Text } from "@mantine/core";
import { arrangeForEnsemble, ENSEMBLES, getInstrument, prettyName, type Score } from "@musicraft/score-core";
import { IconWand } from "@tabler/icons-react";
import { useState } from "react";
import { createProject } from "../lib/projects";
import { instrumentOptions } from "./NewScoreModal";
import { Tip } from "./Tip";
import { unavailable } from "./unavailable";

interface Props {
  opened: boolean;
  onClose: () => void;
  score: Score;
  projectName: string;
  /** Replace the current score (undoable). */
  onApply: (next: Score, label: string) => void;
}

/** Write a first-draft arrangement for an ensemble, as a new score or in place. */
export function ArrangeModal({ opened, onClose, score, projectName, onApply }: Props) {
  const [ensemble, setEnsemble] = useState<string>("brass-quintet");
  const [custom, setCustom] = useState<string[]>(["flute", "clarinet-bb", "bassoon"]);
  const [sources, setSources] = useState<string[]>(() => score.parts.map((p) => p.id));
  const [keepSource, setKeepSource] = useState(false);
  const [target, setTarget] = useState<"new" | "replace">("new");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ report: string[]; projectId?: string } | null>(null);

  const label = ensemble === "custom" ? custom.map((id) => prettyName(getInstrument(id).name)).join(", ") : (ENSEMBLES.find((e) => e.id === ensemble)?.name ?? ensemble);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = arrangeForEnsemble(score, {
        ...(ensemble === "custom" ? { instruments: custom.map((instrument) => ({ instrument })) } : { ensemble }),
        sourcePartIds: sources,
        keepSource,
      });
      if (target === "new") {
        const name = `${projectName} – ${label}`;
        const id = await createProject(name, { ...result.score, meta: { ...result.score.meta } }, "new", [], `Arranged for ${label}`);
        setDone({ report: result.report, projectId: id });
      } else {
        onApply(result.score, `Arrange for ${label}`);
        setDone({ report: result.report });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setDone(null);
    setError(null);
    onClose();
  };

  return (
    <Modal opened={opened} onClose={close} title="Arrange for an ensemble" size="lg">
      {done ? (
        <Stack>
          <Text size="sm" fw={600}>
            Arranged for {label}.
          </Text>
          <List size="sm" spacing={4}>
            {done.report.map((line) => (
              <List.Item key={line}>{line}</List.Item>
            ))}
          </List>
          <Text size="sm" c="dimmed">
            This is a first draft. Listen to it, then refine it by hand or ask the assistant, e.g. &ldquo;give bars 9–16 of the melody to
            the horn&rdquo; or &ldquo;make the trumpet 2 part easier&rdquo;.
          </Text>
          <Group justify="flex-end">
            <Tip label="Stay with this score; the arrangement is saved in your scores">
              <Button variant="default" onClick={close}>
                Close
              </Button>
            </Tip>
            {done.projectId && (
              <Tip label="Open the new score with the arrangement">
                <Button
                  onClick={() => {
                    close();
                    window.location.hash = `#/project/${done.projectId}`;
                  }}
                >
                  Open the arrangement
                </Button>
              </Tip>
            )}
          </Group>
        </Stack>
      ) : (
        <Stack>
          <Text size="sm" c="dimmed">
            The top line becomes the melody, the lowest line the bass, and the other instruments play the harmony as chords, with
            breathing places and ranges that suit each instrument.
          </Text>
          <Select
            label="Ensemble"
            value={ensemble}
            onChange={(v) => setEnsemble(v ?? "brass-quintet")}
            allowDeselect={false}
            data={[...ENSEMBLES.map((e) => ({ value: e.id, label: `${e.name} — ${e.description}` })), { value: "custom", label: "Choose instruments…" }]}
          />
          {ensemble === "custom" && (
            <MultiSelect
              label="Instruments, highest first"
              searchable
              value={custom}
              onChange={setCustom}
              data={instrumentOptions()}
              description="The first plays the melody, the last the bass."
            />
          )}
          {score.parts.length > 1 && (
            <MultiSelect
              label="Arrange from"
              value={sources}
              onChange={setSources}
              data={score.parts.map((p) => ({ value: p.id, label: prettyName(p.name) }))}
            />
          )}
          <Checkbox label="Keep the original parts below the new ones, for reference" checked={keepSource} onChange={(e) => setKeepSource(e.currentTarget.checked)} />
          <Radio.Group label="Where" value={target} onChange={(v) => setTarget(v as "new" | "replace")}>
            <Stack gap={6} mt={6}>
              <Radio value="new" label="A new score (this one stays as it is)" />
              <Radio value="replace" label="Replace the parts of this score (can be undone)" />
            </Stack>
          </Radio.Group>
          {error && <Alert color="red">{error}</Alert>}
          <Group justify="flex-end">
            <Tip label="Close without arranging">
              <Button variant="default" onClick={close}>
                Cancel
              </Button>
            </Tip>
            <Tip
              label={
                !sources.length
                  ? "Choose at least one part to arrange from"
                  : ensemble === "custom" && custom.length < 2
                    ? "Choose at least two instruments"
                    : "Make the arrangement as a new score (this score stays as it is)"
              }
            >
              <Button
                leftSection={<IconWand size={14} />}
                onClick={() => sources.length && !(ensemble === "custom" && custom.length < 2) && void run()}
                loading={busy}
                {...unavailable(!sources.length || (ensemble === "custom" && custom.length < 2))}
              >
                Arrange
              </Button>
            </Tip>
          </Group>
        </Stack>
      )}
    </Modal>
  );
}
