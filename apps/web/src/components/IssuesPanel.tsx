import { Badge, Group, Stack, Switch, Text, ThemeIcon, UnstyledButton } from "@mantine/core";
import type { Issue } from "@musicraft/score-core";
import { IconAlertTriangle, IconCircleCheck, IconInfoCircle, IconX } from "@tabler/icons-react";
import { useState } from "react";
import { Tip } from "./Tip";

const ICONS = {
  error: { icon: IconX, color: "red" },
  warning: { icon: IconAlertTriangle, color: "orange" },
  info: { icon: IconInfoCircle, color: "blue" },
} as const;

export function IssuesPanel({ issues, onJump }: { issues: Issue[]; onJump: (issue: Issue) => void }) {
  const [showHints, setShowHints] = useState(false);
  const visible = issues.filter((i) => showHints || i.severity !== "info");
  const counts = { error: 0, warning: 0, info: 0 };
  for (const i of issues) counts[i.severity]++;

  return (
    <Stack gap="sm">
      <Group gap="xs">
        <Badge color="red" variant="light">
          {counts.error} errors
        </Badge>
        <Badge color="orange" variant="light">
          {counts.warning} warnings
        </Badge>
        <Tip label="Also list notes that are playable but outside the range an average player manages comfortably">
          <Switch size="xs" label={`Range hints (${counts.info})`} checked={showHints} onChange={(e) => setShowHints(e.currentTarget.checked)} />
        </Tip>
      </Group>
      {visible.length === 0 && (
        <Group gap="xs">
          <ThemeIcon color="green" variant="light" radius="xl">
            <IconCircleCheck size={16} />
          </ThemeIcon>
          <Text size="sm" c="dimmed">
            No problems found.
          </Text>
        </Group>
      )}
      {visible.slice(0, 300).map((issue) => {
        const { icon: Icon, color } = ICONS[issue.severity];
        return (
          <UnstyledButton key={issue.id} onClick={() => onJump(issue)} data-testid="issue" title="Show this bar in the score">
            <Group gap="xs" wrap="nowrap" align="flex-start">
              <ThemeIcon color={color} variant="light" size="sm" radius="xl" mt={2}>
                <Icon size={12} />
              </ThemeIcon>
              <Text size="sm">{issue.message}</Text>
            </Group>
          </UnstyledButton>
        );
      })}
      {visible.length > 300 && (
        <Text size="xs" c="dimmed">
          …and {visible.length - 300} more.
        </Text>
      )}
    </Stack>
  );
}
