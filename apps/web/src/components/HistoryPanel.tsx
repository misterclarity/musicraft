import { Badge, Button, Group, Stack, Text } from "@mantine/core";
import type { Score } from "@musicraft/score-core";
import { IconDeviceFloppy, IconRestore } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import type { VersionAuthor } from "../lib/db";
import { modals } from "../lib/modals";
import { listVersions, loadVersion, type VersionSummary } from "../lib/projects";
import { Tip } from "./Tip";

const AUTHOR_COLORS: Record<VersionAuthor, string> = { you: "blue", ai: "grape", import: "gray", recognition: "teal" };
const AUTHOR_LABELS: Record<VersionAuthor, string> = { you: "you", ai: "AI", import: "import", recognition: "scan" };

export function HistoryPanel({
  projectId,
  tick,
  onRestore,
  onSave,
}: {
  projectId: string;
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
