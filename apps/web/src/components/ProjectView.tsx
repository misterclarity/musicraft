import {
  ActionIcon,
  AppShell,
  Badge,
  Burger,
  Center,
  Group,
  Loader,
  ScrollArea,
  Switch,
  Tabs,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure, useHotkeys } from "@mantine/hooks";
import { checkScore, type Issue, type Score } from "@musicraft/score-core";
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconChevronLeft,
  IconSettings,
  IconZoomIn,
  IconZoomOut,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { describeSelection } from "../lib/describe";
import { modals } from "../lib/modals";
import { EMPTY_SELECTION, useProject } from "../state/project";
import { ExportMenu } from "./ExportMenu";
import { HistoryPanel } from "./HistoryPanel";
import { IssuesPanel } from "./IssuesPanel";
import { PartsPanel } from "./PartsPanel";
import { PlaybackBar } from "./PlaybackBar";
import { ScoreView, type MeasureMark } from "./ScoreView";

export function ProjectView({ projectId, onBack, onOpenSettings }: { projectId: string; onBack: () => void; onOpenSettings: () => void }) {
  const project = useProject();
  const [navOpen, nav] = useDisclosure(false);
  const [tab, setTab] = useState<string | null>("parts");
  const [focus, setFocus] = useState<number | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let active = true;
    void useProject
      .getState()
      .open(projectId)
      .then((ok) => {
        if (active && !ok) setMissing(true);
      });
    return () => {
      active = false;
      useProject.getState().close();
    };
  }, [projectId]);

  const score = project.id === projectId ? project.score : null;
  const issues = useMemo(() => (score ? checkScore(score) : []), [score]);
  const marks = useMemo<MeasureMark[]>(
    () =>
      tab === "issues"
        ? issues
            .filter((i) => i.severity !== "info")
            .map((i) => ({ measureIndex: i.measureIndex, partId: i.partId, color: i.severity === "error" ? "red" : "orange", label: i.message }))
        : [],
    [issues, tab],
  );

  const apply = useCallback(
    (next: Score, label: string, checkpoint = false) => project.apply(next, label, { checkpoint }),
    [project],
  );

  useHotkeys([
    ["mod+Z", () => project.undo()],
    ["mod+shift+Z", () => project.redo()],
    ["mod+Y", () => project.redo()],
    ["Escape", () => project.select(EMPTY_SELECTION)],
  ]);

  if (missing) {
    return (
      <Center h="100vh">
        <Text>
          This project no longer exists.{" "}
          <UnstyledButton c="blue" onClick={onBack}>
            Back to your scores
          </UnstyledButton>
        </Text>
      </Center>
    );
  }
  if (!score) {
    return (
      <Center h="100vh">
        <Loader />
      </Center>
    );
  }

  const jump = (issue: Issue) => {
    project.select({ eventIds: [], measures: { from: issue.measureIndex, to: issue.measureIndex }, partIds: [issue.partId] });
    setFocus(issue.measureIndex);
    nav.close();
  };
  const errorCount = issues.filter((i) => i.severity !== "info").length;
  const lastLabel = project.past[project.past.length - 1]?.label;
  const nextLabel = project.future[0]?.label;

  return (
    <AppShell header={{ height: 56 }} navbar={{ width: 320, breakpoint: "md", collapsed: { mobile: !navOpen } }} padding={0}>
      <AppShell.Header>
        <Group h="100%" px="sm" justify="space-between" wrap="nowrap" gap="xs">
          <Group gap={4} wrap="nowrap" style={{ minWidth: 0 }}>
            <Burger opened={navOpen} onClick={nav.toggle} hiddenFrom="md" size="sm" />
            <Tooltip label="Your scores">
              <ActionIcon variant="subtle" onClick={onBack} aria-label="Back to your scores">
                <IconChevronLeft size={20} />
              </ActionIcon>
            </Tooltip>
            <UnstyledButton
              onClick={async () => {
                const name = await modals.prompt("Rename project", project.name);
                if (name) await project.rename(name);
              }}
              style={{ minWidth: 0 }}
            >
              <Text fw={650} truncate maw={260}>
                {project.name}
              </Text>
            </UnstyledButton>
          </Group>
          <Group gap={6} wrap="nowrap">
            <Tooltip label={lastLabel ? `Undo: ${lastLabel}` : "Nothing to undo"}>
              <ActionIcon variant="subtle" disabled={!project.past.length} onClick={project.undo} aria-label="Undo">
                <IconArrowBackUp size={18} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={nextLabel ? `Redo: ${nextLabel}` : "Nothing to redo"}>
              <ActionIcon variant="subtle" disabled={!project.future.length} onClick={project.redo} aria-label="Redo">
                <IconArrowForwardUp size={18} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label="Show every part at the pitch it sounds">
              <Switch
                size="xs"
                label="Concert pitch"
                checked={project.concert}
                onChange={(e) => project.setConcert(e.currentTarget.checked)}
                visibleFrom="sm"
              />
            </Tooltip>
            <Group gap={0} visibleFrom="sm">
              <ActionIcon variant="subtle" onClick={() => project.setZoom(project.zoom / 1.15)} aria-label="Zoom out">
                <IconZoomOut size={18} />
              </ActionIcon>
              <ActionIcon variant="subtle" onClick={() => project.setZoom(project.zoom * 1.15)} aria-label="Zoom in">
                <IconZoomIn size={18} />
              </ActionIcon>
            </Group>
            <PlaybackBar score={score} selection={project.selection} />
            <ExportMenu score={score} name={project.name} projectId={projectId} />
            <ActionIcon variant="subtle" onClick={onOpenSettings} aria-label="Settings">
              <IconSettings size={18} />
            </ActionIcon>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        <Tabs value={tab} onChange={setTab} style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <Tabs.List grow>
            <Tabs.Tab value="parts">Parts</Tabs.Tab>
            <Tabs.Tab
              value="issues"
              rightSection={
                errorCount > 0 ? (
                  <Badge size="xs" color="orange" variant="filled">
                    {errorCount}
                  </Badge>
                ) : undefined
              }
            >
              Checks
            </Tabs.Tab>
            <Tabs.Tab value="history">History</Tabs.Tab>
          </Tabs.List>
          <ScrollArea style={{ flex: 1 }} mt="sm" offsetScrollbars>
            <Tabs.Panel value="parts">
              <PartsPanel
                score={score}
                onApply={apply}
                selectedPartIds={project.selection.partIds}
                onSelectPart={(partId) => project.select({ eventIds: [], partIds: [partId], measures: project.selection.measures })}
              />
            </Tabs.Panel>
            <Tabs.Panel value="issues">
              <IssuesPanel issues={issues} onJump={jump} />
            </Tabs.Panel>
            <Tabs.Panel value="history">
              <HistoryPanel
                projectId={projectId}
                tick={project.versionsTick}
                onRestore={(restored, label) => project.apply(restored, label, { checkpoint: true })}
                onSave={(label) => project.saveVersion(label)}
              />
            </Tabs.Panel>
          </ScrollArea>
        </Tabs>
      </AppShell.Navbar>

      <AppShell.Main style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          <ScoreView
            score={score}
            concert={project.concert}
            zoom={project.zoom}
            selection={project.selection}
            onSelect={project.select}
            marks={marks}
            focusMeasure={focus}
          />
        </div>
        <Group px="md" py={4} justify="space-between" style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}>
          <Text size="xs" c="dimmed" data-testid="status">
            {describeSelection(score, project.selection, project.concert) || "Click a note or a bar to select it."}
          </Text>
          <Text size="xs" c="dimmed" visibleFrom="sm">
            {project.concert ? "Concert pitch" : "Transposed score"} · {score.measures.length} bars
          </Text>
        </Group>
      </AppShell.Main>
    </AppShell>
  );
}
