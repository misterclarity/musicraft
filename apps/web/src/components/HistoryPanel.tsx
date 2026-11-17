import { Badge, Button, Group, Paper, Stack, Text } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { Score } from "@musicraft/score-core";
import { IconCopy, IconDeviceFloppy, IconRestore, IconTargetArrow } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { describeAccuracy, measureScan } from "../lib/accuracy";
import type { PageRecord, VersionAuthor } from "../lib/db";
import { modals } from "../lib/modals";
import { listVersions, loadVersion, type VersionSummary } from "../lib/projects";
import { Tip } from "./Tip";

const AUTHOR_COLORS: Record<VersionAuthor, string> = { you: "blue", ai: "grape", import: "gray", recognition: "teal" };
const AUTHOR_LABELS: Record<VersionAuthor, string> = { you: "you", ai: "AI", import: "import", recognition: "scan" };

export function HistoryPanel({
  projectId,
  score,
  pages,
  tick,
  onRestore,
  onSave,
}: {
  projectId: string;
  /** The score as it is now. */
  score: Score;
  /** The original pages of a scanned score. */
  pages: PageRecord[];
  tick: number;
  onRestore: (score: Score, label: string) => void;
  onSave: (label: string) => Promise<void>;
}) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    void listVersions(projectId).then((v) => {
      if (!cancelled) setVersions(v);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, tick]);

  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Text size="sm" c="dimmed">
          Saved versions of this score. Every change can also be undone with Ctrl+Z.
        </Text>
      </Group>
      <Tip label="Keep a named copy of the score as it is now, to go back to later">
        <Button
          size="xs"
          variant="default"
          leftSection={<IconDeviceFloppy size={14} />}
          onClick={async () => {
            const label = await modals.prompt("Save a version", "", "Name");
            if (label) await onSave(label);
          }}
        >
          Save version…
        </Button>
      </Tip>
      {versions.some((v) => v.author === "recognition") && <ScanAccuracy versions={versions} score={score} pages={pages} />}
      {versions.map((v) => (
        <Group key={v.id} justify="space-between" wrap="nowrap" align="flex-start">
          <Stack gap={0} style={{ minWidth: 0 }}>
            <Text size="sm" lineClamp={2}>
              {v.label}
            </Text>
            <Group gap={6}>
              <Badge size="xs" variant="light" color={AUTHOR_COLORS[v.author]}>
                {AUTHOR_LABELS[v.author]}
              </Badge>
              <Text size="xs" c="dimmed">
                {new Date(v.createdAt).toLocaleString()}
              </Text>
            </Group>
          </Stack>
          <Tip label="Go back to this version (the current score stays in the history, and Undo brings it back)">
            <Button
              size="compact-xs"
              variant="subtle"
              style={{ flexShrink: 0 }}
              leftSection={<IconRestore size={12} />}
              onClick={async () => {
                const score = await loadVersion(v.id);
                if (score) onRestore(score, `Restore "${v.label}"`);
              }}
            >
              Restore
            </Button>
          </Tip>
        </Group>
      ))}
    </Stack>
  );
}

/** How well the scan was read: its notes compared with the score as corrected since. */
function ScanAccuracy({ versions, score, pages }: { versions: VersionSummary[]; score: Score; pages: PageRecord[] }) {
  const [report, setReport] = useState<string[] | null>(null);
  // Newest first: the scan is the oldest version from recognition, the next one its automatic corrections.
  const scans = versions.filter((v) => v.author === "recognition").reverse();

  async function measure() {
    const scan = await loadVersion(scans[0]!.id);
    if (!scan) return;
    const repaired = scans[1] ? await loadVersion(scans[1].id) : undefined;
    setReport(describeAccuracy(measureScan(scan, score, pages, repaired)));
  }

  return (
    <Paper withBorder p="xs" radius="md" data-testid="scan-accuracy">
      <Text size="sm" fw={600}>
        How well was the scan read?
      </Text>
      <Text size="xs" c="dimmed">
        Compares the scan with the score as it is now. A note counts as read right if it is in the same bar and place, with the same pitch and
        length, so the result means most once the whole score has been corrected.
      </Text>
      {report ? (
        <Stack gap={2} mt={6} data-testid="scan-accuracy-report">
          {report.map((line) => (
            <Text key={line} size="sm">
              {line}
            </Text>
          ))}
          <Group gap="xs" mt={4}>
            <Tip label="Measure again, with the corrections made since">
              <Button size="compact-xs" variant="subtle" leftSection={<IconTargetArrow size={12} />} onClick={() => void measure()}>
                Again
              </Button>
            </Tip>
            <Tip label="Copy these figures, for example into a bug report about recognition">
              <Button
                size="compact-xs"
                variant="subtle"
                leftSection={<IconCopy size={12} />}
                onClick={() =>
                  void navigator.clipboard
                    .writeText(report.join("\n"))
                    .then(() => notifications.show({ message: "Copied.", autoClose: 1500 }))
                    .catch(() => notifications.show({ color: "orange", message: "The browser didn't allow copying." }))
                }
              >
                Copy
              </Button>
            </Tip>
          </Group>
        </Stack>
      ) : (
        <Tip label="Count how many of the scan's notes were right, overall and for each recognition engine">
          <Button size="xs" variant="light" mt={6} leftSection={<IconTargetArrow size={14} />} onClick={() => void measure()}>
            Compare with the scan
          </Button>
        </Tip>
      )}
    </Paper>
  );
}
