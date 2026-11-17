import { Badge, Button, Group, Paper, Stack, Text, UnstyledButton } from "@mantine/core";
import type { Score } from "@musicraft/score-core";
import { useMemo } from "react";
import type { PageRecord, ReadingDisagreement } from "../lib/db";
import { barPitches, openDisagreements, sameBar, withOtherReading } from "../lib/disagreements";
import { Tip } from "./Tip";

const MAX_ROWS = 80;

interface Props {
  score: Score;
  pages: PageRecord[];
  onApply: (next: Score, label: string) => void;
  /** Select a bar and show it (and its line on the original page). */
  onShow: (measureIndex: number) => void;
}

/**
 * Where the two recognition engines read a scanned page differently: the bars to compare with the
 * original first. Each can take the other engine's version of the bar.
 */
export function DisagreementsPanel({ score, pages, onApply, onShow }: Props) {
  const rows = useMemo(() => openDisagreements(score, pages), [score, pages]);
  if (!rows.length) return null;
  return (
    <Paper withBorder p="xs" radius="md" mb="sm" data-testid="disagreements">
      <Text size="sm" fw={600}>
        Where the two readings differ
      </Text>
      <Text size="xs" c="dimmed">
        Two engines read the pages and found other notes in these bars: compare them with the original first. Use puts in the other
        engine&apos;s version; undo takes it out again.
      </Text>
      <Stack gap={4} mt={6}>
        {rows.slice(0, MAX_ROWS).map(({ disagreement, measureIndex }) => (
          <Row key={disagreement.measureId} score={score} disagreement={disagreement} measureIndex={measureIndex} onApply={onApply} onShow={onShow} />
        ))}
        {rows.length > MAX_ROWS && (
          <Text size="xs" c="dimmed">
            … and {rows.length - MAX_ROWS} more
          </Text>
        )}
      </Stack>
    </Paper>
  );
}

function Row({ score, disagreement, measureIndex, onApply, onShow }: { score: Score; disagreement: ReadingDisagreement; measureIndex: number } & Pick<Props, "onApply" | "onShow">) {
  const number = score.measures[measureIndex]!.number;
  const other = disagreement.bar;
  const inUse = !!other && sameBar(score.parts[0]?.measures[measureIndex], other);
  const engine = disagreement.readBy ? ` (${disagreement.readBy})` : "";
  const what =
    disagreement.kind === "missing"
      ? "The other reading has no such bar"
      : disagreement.kind === "rhythm"
        ? "The same notes in another rhythm"
        : `${barPitches(score, measureIndex)}, or ${other ? barPitches(score, measureIndex, other) : "?"}`;
  return (
    <Group gap={6} wrap="nowrap" data-testid="disagreement">
      <UnstyledButton onClick={() => onShow(measureIndex)} style={{ flex: 1, minWidth: 0 }} title="Select this bar and show it on the original page">
        <Text size="sm">Bar {number}</Text>
        <Text size="xs" c="dimmed" truncate>
          {what}
        </Text>
      </UnstyledButton>
      {other &&
        (inUse ? (
          <Tip label={`Bar ${number} is the other reading's version${engine} now; undo goes back`}>
            <Badge size="sm" variant="light" color="teal">
              In use
            </Badge>
          </Tip>
        ) : (
          <Tip label={`Put in the other reading's version of bar ${number}${engine}`}>
            <Button size="compact-xs" variant="light" onClick={() => onApply(withOtherReading(score, measureIndex, other), `Bar ${number} from the other reading`)}>
              Use
            </Button>
          </Tip>
        ))}
    </Group>
  );
}
