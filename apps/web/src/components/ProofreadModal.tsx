import { Alert, Badge, Button, Code, Group, Modal, Paper, Progress, ScrollArea, Stack, Text } from "@mantine/core";
import { aiBarLabels, partHandle, type Score } from "@musicraft/score-core";
import { IconCheck, IconEye, IconX } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { previewActive, useLlm } from "../ai/assistant";
import { applyFinding, findingBar, proofreadSystem, proofreadSystems, type Finding } from "../ai/proofread";
import type { PageRecord } from "../lib/db";
import { getSettings } from "../lib/settings";
import { useProject } from "../state/project";
import { Tip } from "./Tip";

type Status = "open" | "applied" | "ignored" | "failed";

interface Props {
  opened: boolean;
  onClose: () => void;
  pages: PageRecord[];
  onShow: (measureIndex: number, partId: string) => void;
}

/** Compare each line of the original pages with the recognised notes, using a vision model. */
export function ProofreadModal({ opened, onClose, pages, onShow }: Props) {
  const llm = useLlm();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [findings, setFindings] = useState<Finding[]>([]);
  const [status, setStatus] = useState<Record<string, { status: Status; error?: string }>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [finished, setFinished] = useState(false);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    if (opened) void useLlm.getState().detect();
  }, [opened]);

  useEffect(() => () => controller.current?.abort(), []);

  const start = async () => {
    const score = useProject.getState().score;
    if (!score) return;
    const caps = await llm.detect();
    if (!caps?.vision) return;
    const systems = proofreadSystems(pages, score);
    controller.current = new AbortController();
    setRunning(true);
    setFinished(false);
    setFindings([]);
    setStatus({});
    setErrors([]);
    setProgress({ done: 0, total: systems.length });
    const labels = aiBarLabels(score);
    for (const [i, system] of systems.entries()) {
      if (controller.current.signal.aborted) break;
      try {
        const found = await proofreadSystem(getSettings(), caps.model, score, pages, system, controller.current.signal);
        setFindings((list) => [...list, ...found]);
      } catch (err) {
        if (controller.current.signal.aborted) break;
        setErrors((list) => [...list, `Bars ${labels[system.measures[0]]}–${labels[system.measures[1]]}: ${(err as Error).message}`]);
      }
      setProgress({ done: i + 1, total: systems.length });
    }
    setRunning(false);
    setFinished(true);
  };

  const apply = (finding: Finding): boolean => {
    const score = useProject.getState().score;
    if (!score) return false;
    if (previewActive()) {
      setStatus((s) => ({ ...s, [finding.id]: { status: "failed", error: "Keep or discard the assistant's changes first." } }));
      return false;
    }
    try {
      const result = applyFinding(score, finding);
      useProject.getState().apply(result.score, result.label);
      setStatus((s) => ({ ...s, [finding.id]: { status: "applied" } }));
      return true;
    } catch (err) {
      setStatus((s) => ({ ...s, [finding.id]: { status: "failed", error: (err as Error).message } }));
      return false;
    }
  };

  const open = findings.filter((f) => (status[f.id]?.status ?? "open") === "open" && (f.kind !== "notes" || f.fix));
  const score: Score | null = useProject.getState().score;
  const labels = score ? aiBarLabels(score) : [];
  const vision = llm.caps?.vision;

  return (
    <Modal opened={opened} onClose={onClose} title="Proofread with AI" size="lg">
      <Stack>
        <Text size="sm" c="dimmed">
          The model compares every line of the original pages with the recognised notes and lists what differs, including
          dynamics and text the recognition missed. Nothing changes until you apply a fix, and every fix can be undone.
        </Text>
        {llm.status === "error" && <Alert color="red">{llm.error}</Alert>}
        {llm.status === "ready" && vision === false && (
          <Alert color="orange" title="This model can't see images">
            Proofreading needs a vision model (llama-server with an --mmproj file). The detected model, {llm.caps?.model}, has no image
            input. If it does, set &ldquo;Vision (images)&rdquo; to on in Settings.
          </Alert>
        )}
        {!pages.length && <Alert color="gray">This score has no scanned pages to compare with.</Alert>}
        {!running && !finished && (
          <Group>
            <Tip
              label={
                !pages.length
                  ? "This score has no scanned pages to compare with"
                  : !vision
                    ? "Needs a language model that can see images (a vision model)"
                    : "Send each line of the original pages, with the notes recognised there, to the vision model and list what differs"
              }
            >
              <Button onClick={() => pages.length && vision && void start()} data-disabled={!pages.length || !vision || undefined} loading={llm.status === "detecting"}>
                Start proofreading
              </Button>
            </Tip>
            {vision === null && llm.status === "ready" && (
              <Text size="xs" c="dimmed">
                The server didn&apos;t say whether the model accepts images; it will be tried anyway if you enable images in Settings.
              </Text>
            )}
          </Group>
        )}
        {(running || finished) && (
          <Stack gap={4}>
            <Group justify="space-between">
              <Text size="sm">
                {running ? `Checking line ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…` : `Checked ${progress.done} of ${progress.total} lines.`}
              </Text>
              {running && (
                <Tip label="Stop after the current line; the differences found so far stay">
                  <Button size="xs" variant="subtle" color="red" onClick={() => controller.current?.abort()}>
                    Stop
                  </Button>
                </Tip>
              )}
            </Group>
            <Progress value={progress.total ? (progress.done / progress.total) * 100 : 0} animated={running} />
          </Stack>
        )}
        {errors.map((e) => (
          <Alert key={e} color="orange" variant="light">
            {e}
          </Alert>
        ))}
        {finished && !findings.length && !errors.length && <Alert color="teal">No differences found.</Alert>}
        {findings.length > 0 && (
          <ScrollArea.Autosize mah="50vh" offsetScrollbars>
            <Stack gap="xs">
              {findings.map((f) => {
                const state = status[f.id]?.status ?? "open";
                // The bar may have moved since (e.g. after an expanded multi-bar rest).
                const bar = score ? findingBar(score, f) : -1;
                const partId = score?.parts[f.partIndex]?.id ?? "";
                return (
                  <Paper key={f.id} withBorder p="xs" radius="md" opacity={state === "ignored" ? 0.5 : 1} data-testid="finding">
                    <Stack gap={4}>
                      <Group gap={6}>
                        <Badge size="sm" variant="light">
                          Bar {bar >= 0 ? labels[bar] : "(deleted)"}
                        </Badge>
                        {(score?.parts.length ?? 1) > 1 && (
                          <Badge size="sm" variant="outline">
                            {partHandle(f.partIndex)}
                          </Badge>
                        )}
                        {state === "applied" && (
                          <Badge size="sm" color="teal" leftSection={<IconCheck size={10} />}>
                            Applied
                          </Badge>
                        )}
                      </Group>
                      <Text size="sm">{f.problem}</Text>
                      {f.fix && (
                        <Code block style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                          {f.fix}
                        </Code>
                      )}
                      {f.kind === "notes" && !f.fix && (
                        <Text size="xs" c="dimmed">
                          No fix suggested; correct it by hand.
                        </Text>
                      )}
                      {status[f.id]?.error && (
                        <Text size="xs" c="red">
                          {status[f.id]!.error}
                        </Text>
                      )}
                      <Group gap={4} justify="flex-end">
                        <Tip label={bar < 0 ? "This bar was deleted" : "Close this list and select the bar in the score, next to the original"}>
                          <Button size="compact-xs" variant="subtle" leftSection={<IconEye size={12} />} data-disabled={bar < 0 || undefined} onClick={() => bar >= 0 && onShow(bar, partId)}>
                            Show
                          </Button>
                        </Tip>
                        {state === "open" && (
                          <Tip label="Leave the score as it is (the model may be wrong)">
                            <Button
                              size="compact-xs"
                              variant="default"
                              leftSection={<IconX size={12} />}
                              onClick={() => setStatus((s) => ({ ...s, [f.id]: { status: "ignored" } }))}
                            >
                              Ignore
                            </Button>
                          </Tip>
                        )}
                        {state === "open" && (f.kind !== "notes" || f.fix) && (
                          <Tip label="Make this change in the score (Undo takes it back)">
                            <Button size="compact-xs" onClick={() => apply(f)}>
                              Apply
                            </Button>
                          </Tip>
                        )}
                      </Group>
                    </Stack>
                  </Paper>
                );
              })}
            </Stack>
          </ScrollArea.Autosize>
        )}
        {finished && open.length > 1 && (
          <Group justify="flex-end">
            <Tip label="Apply every open fix at once (key and time signatures first); each one can be undone">
              <Button
                variant="light"
                onClick={() => {
                  for (const f of open) apply(f);
                }}
              >
                Apply all {open.length} fixes
              </Button>
            </Tip>
          </Group>
        )}
      </Stack>
    </Modal>
  );
}
