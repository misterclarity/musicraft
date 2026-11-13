import { Button, Group, NumberInput, Paper, Stack, Text, UnstyledButton } from "@mantine/core";
import { restRuns, setRestLength, type Score } from "@musicraft/score-core";
import { useEffect, useMemo, useState } from "react";
import { Tip } from "./Tip";
import { unavailable } from "./unavailable";

const MAX_ROWS = 60;

interface Props {
  score: Score;
  onApply: (next: Score, label: string) => void;
  /** Select a bar and show it (and its line on the original page). */
  onShow: (measureIndex: number) => void;
}

/**
 * Rests to compare with the original: recognition reads a multi-bar rest (one bar with a number
 * above it) as a single bar, so each run of rest bars gets a box for the number of bars it lasts.
 */
export function RestRunsPanel({ score, onApply, onShow }: Props) {
  const runs = useMemo(() => restRuns(score), [score]);
  if (!runs.length) return null;
  return (
    <Paper withBorder p="xs" radius="md" mb="sm" data-testid="rest-runs">
      <Text size="sm" fw={600}>
        Multi-bar rests
      </Text>
      <Text size="xs" c="dimmed">
        Recognition reads a multi-bar rest (one bar with a number above it) as a single bar. Click a rest to see it on the
        original, and enter how many bars it lasts.
      </Text>
      <Stack gap={4} mt={6}>
        {runs.slice(0, MAX_ROWS).map((run) => (
          <RestRunRow key={score.measures[run.from]!.id} score={score} from={run.from} to={run.to} onApply={onApply} onShow={onShow} />
        ))}
        {runs.length > MAX_ROWS && (
          <Text size="xs" c="dimmed">
            … and {runs.length - MAX_ROWS} more
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

function RestRunRow({ score, from, to, onApply, onShow }: { score: Score; from: number; to: number } & Pick<Props, "onApply" | "onShow">) {
  const length = to - from + 1;
  const [bars, setBars] = useState<number>(length);
  useEffect(() => setBars(length), [length]);
  const first = score.measures[from]!.number;
  const label = length === 1 ? `Bar ${first}` : `Bars ${first}–${score.measures[to]!.number}`;
  return (
    <Group gap={6} wrap="nowrap" data-testid="rest-run">
      <UnstyledButton onClick={() => onShow(from)} style={{ flex: 1, minWidth: 0 }} title="Select this rest and show it on the original page">
        <Text size="sm" truncate>
          {label}
        </Text>
      </UnstyledButton>
      <NumberInput size="xs" w={72} min={1} max={500} value={bars} onChange={(v) => setBars(Math.max(1, Math.round(Number(v) || 1)))} aria-label={`Bars of rest from bar ${first}`} />
      <Text size="xs" c="dimmed">
        bars
      </Text>
      <Tip label={bars === length ? "Type how many bars this rest lasts on the original, then Set" : `Make this rest ${bars} bar${bars > 1 ? "s" : ""} long (adds or removes empty bars)`}>
        <Button
          size="compact-xs"
          variant="light"
          {...unavailable(bars === length)}
          onClick={() => bars !== length && onApply(setRestLength(score, from, bars), `Rest from bar ${first}: ${bars} bars`)}
        >
          Set
        </Button>
      </Tip>
    </Group>
  );
}
