import {
  ActionIcon,
  AppShell,
  Badge,
  Burger,
  Button,
  Center,
  Group,
  Loader,
  ScrollArea,
  SegmentedControl,
  Switch,
  Tabs,
  Text,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { useDisclosure, useHotkeys, useMediaQuery } from "@mantine/hooks";
import { checkScore, type Issue, type Score } from "@musicraft/score-core";
import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconChevronLeft,
  IconPhoto,
  IconSparkles,
  IconSettings,
  IconZoomIn,
  IconZoomOut,
} from "@tabler/icons-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { notifications } from "@mantine/notifications";
import { previewActive, useAssistant } from "../ai/assistant";
import { changedBars } from "../ai/diff";
import type { PageRecord } from "../lib/db";
import { describeSelection } from "../lib/describe";
import { handleEditorKey } from "../lib/editor";
import { listPages } from "../lib/projects";
import { modals } from "../lib/modals";
import { EMPTY_SELECTION, useProject } from "../state/project";
import { AssistantPanel } from "./AssistantPanel";
import { BarDialogs, type BarDialog } from "./BarDialogs";
import { EditToolbar } from "./EditToolbar";
import { ExportMenu } from "./ExportMenu";
import { HistoryPanel } from "./HistoryPanel";
import { IssuesPanel } from "./IssuesPanel";
import { OriginalPages } from "./OriginalPages";
import { PartsPanel } from "./PartsPanel";
import { PlaybackBar } from "./PlaybackBar";
import { ProofreadModal } from "./ProofreadModal";
import { ScoreView, type MeasureMark } from "./ScoreView";

export function ProjectView({ projectId, onBack, onOpenSettings }: { projectId: string; onBack: () => void; onOpenSettings: () => void }) {
  const project = useProject();
  const [navOpen, nav] = useDisclosure(false);
  const [tab, setTab] = useState<string | null>("parts");
  const [focus, setFocus] = useState<number | null>(null);
  const [missing, setMissing] = useState(false);
  const [pages, setPages] = useState<PageRecord[]>([]);
  const [showOriginal, setShowOriginal] = useState(true);
  const [mobileView, setMobileView] = useState<"score" | "original">("score");
  const [barDialog, setBarDialog] = useState<BarDialog | null>(null);
  const [proofreadOpen, setProofreadOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(() => {
    try {
      return localStorage.getItem("musicraft.assistantOpen") === "1";
    } catch {
      return false;
    }
  });
  const assistant = useAssistant();
  const narrow = useMediaQuery("(max-width: 62em)");

  useEffect(() => {
    let active = true;
    useAssistant.getState().reset(projectId);
    void useProject
      .getState()
      .open(projectId)
      .then((ok) => {
        if (active && !ok) setMissing(true);
      });
    void listPages(projectId).then((list) => {
      if (active) setPages(list);
    });
    return () => {
      active = false;
      useAssistant.getState().reset(null);
      useProject.getState().close();
    };
  }, [projectId]);

  useEffect(() => {
    try {
      localStorage.setItem("musicraft.assistantOpen", assistantOpen ? "1" : "0");
    } catch {
      // private mode: not remembered
    }
  }, [assistantOpen]);

  const score = project.id === projectId ? project.score : null;
  const issues = useMemo(() => (score ? checkScore(score) : []), [score]);
  const assistantMarks = useMemo(
    () => (assistant.draft && assistant.base ? changedBars(assistant.base, assistant.draft) : null),
    [assistant.draft, assistant.base],
  );
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
    (next: Score, label: string, checkpoint = false) => {
      if (previewActive()) {
        notifications.show({ color: "orange", message: "Keep or discard the assistant's changes first." });
        return;
      }
      project.apply(next, label, { checkpoint });
    },
    [project],
  );

  // While the assistant's draft is on screen, undo means "discard the draft".
  const undo = () => {
    const ai = useAssistant.getState();
    if (ai.running) return;
    if (ai.draft) ai.discard();
    else project.undo();
  };
  const redo = () => {
    if (!previewActive()) project.redo();
  };
  useHotkeys([
    ["mod+Z", undo],
    ["mod+shift+Z", redo],
    ["mod+Y", redo],
    ["Escape", () => project.select(EMPTY_SELECTION)],
  ]);

  // Note entry and editing keys (see the shortcut list in the edit toolbar).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.defaultPrevented && handleEditorKey(event)) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  const shown = assistant.draft ?? score;

  const jump = (issue: Issue) => {
    project.select({ eventIds: [], measures: { from: issue.measureIndex, to: issue.measureIndex }, partIds: [issue.partId] });
    setFocus(issue.measureIndex);
    nav.close();
  };
  const errorCount = issues.filter((i) => i.severity !== "info").length;
  const lastLabel = project.past[project.past.length - 1]?.label;
  const nextLabel = project.future[0]?.label;

  return (
    <AppShell
      header={{ height: 56 }}
      navbar={{ width: 320, breakpoint: "md", collapsed: { mobile: !navOpen } }}
      aside={{ width: 380, breakpoint: "md", collapsed: { desktop: !assistantOpen, mobile: !assistantOpen } }}
      padding={0}
    >
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
            <Tooltip label={assistant.draft ? "Undo: discard the assistant's changes" : lastLabel ? `Undo: ${lastLabel}` : "Nothing to undo"}>
              <ActionIcon variant="subtle" disabled={(!project.past.length && !assistant.draft) || assistant.running} onClick={undo} aria-label="Undo">
                <IconArrowBackUp size={18} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={nextLabel ? `Redo: ${nextLabel}` : "Nothing to redo"}>
              <ActionIcon variant="subtle" disabled={!project.future.length || !!assistant.draft || assistant.running} onClick={redo} aria-label="Redo">
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
            {pages.length > 0 && !narrow && (
              <Tooltip label="Show the original pages next to the score">
                <ActionIcon variant={showOriginal ? "light" : "subtle"} onClick={() => setShowOriginal((v) => !v)} aria-label="Original pages">
                  <IconPhoto size={18} />
                </ActionIcon>
              </Tooltip>
            )}
            <Tooltip label="Ask the AI assistant">
              <ActionIcon
                variant={assistantOpen ? "light" : "subtle"}
                onClick={() => setAssistantOpen((v) => !v)}
                aria-label="Assistant"
                data-testid="assistant-toggle"
              >
                <IconSparkles size={18} />
              </ActionIcon>
            </Tooltip>
            <PlaybackBar score={shown} selection={project.selection} />
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
                projectName={project.name}
                onApply={apply}
                selectedPartIds={project.selection.partIds}
                onSelectPart={(partId) => project.select({ eventIds: [], partIds: [partId], measures: project.selection.measures })}
              />
            </Tabs.Panel>
            <Tabs.Panel value="issues">
              {pages.length > 0 && (
                <Button size="xs" variant="light" fullWidth mb="sm" leftSection={<IconSparkles size={14} />} onClick={() => setProofreadOpen(true)}>
                  Proofread against the original with AI
                </Button>
              )}
              <IssuesPanel issues={issues} onJump={jump} />
            </Tabs.Panel>
            <Tabs.Panel value="history">
              <HistoryPanel
                projectId={projectId}
                tick={project.versionsTick}
                onRestore={(restored, label) => apply(restored, label, true)}
                onSave={(label) => project.saveVersion(label)}
              />
            </Tabs.Panel>
          </ScrollArea>
        </Tabs>
      </AppShell.Navbar>

      <AppShell.Main style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
        <div style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
          <EditToolbar selection={project.selection} onBarDialog={setBarDialog} />
        </div>
        {pages.length > 0 && narrow && (
          <SegmentedControl
            size="xs"
            m="xs"
            value={mobileView}
            onChange={(v) => setMobileView(v as "score" | "original")}
            data={[
              { value: "score", label: "Score" },
              { value: "original", label: "Original" },
            ]}
          />
        )}
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {pages.length > 0 && (narrow ? mobileView === "original" : showOriginal) && (
            <div style={{ flex: narrow ? 1 : "0 0 42%", minWidth: 0, borderRight: "1px solid var(--mantine-color-default-border)" }}>
              <OriginalPages
                pages={pages}
                score={score}
                selection={project.selection}
                onSelectMeasure={(m) => {
                  project.select({ eventIds: [], measures: { from: m, to: m } });
                  setFocus(m);
                  if (narrow) setMobileView("score");
                }}
              />
            </div>
          )}
          {(!narrow || mobileView === "score" || pages.length === 0) && (
            <div style={{ flex: 1, minWidth: 0 }}>
              <ScoreView
                score={shown}
                concert={project.concert}
                zoom={project.zoom}
                selection={project.selection}
                onSelect={project.select}
                marks={assistantMarks ?? marks}
                focusMeasure={focus}
              />
            </div>
          )}
        </div>
        <Group px="md" py={4} justify="space-between" style={{ borderTop: "1px solid var(--mantine-color-default-border)" }}>
          <Text size="xs" c="dimmed" data-testid="status">
            {assistant.draft
              ? "Previewing the assistant's changes (green). Keep or discard them in the Assistant panel."
              : describeSelection(score, project.selection, project.concert) || "Click a note or a bar to select it."}
          </Text>
          <Text size="xs" c="dimmed" visibleFrom="sm">
            {project.concert ? "Concert pitch" : "Transposed score"} · {score.measures.length} bars
          </Text>
        </Group>
      </AppShell.Main>
      <AppShell.Aside>
        {assistantOpen && <AssistantPanel score={shown} selection={project.selection} pages={pages} onOpenSettings={onOpenSettings} />}
      </AppShell.Aside>
      <ProofreadModal
        opened={proofreadOpen}
        onClose={() => setProofreadOpen(false)}
        pages={pages}
        onShow={(measureIndex, partId) => {
          setProofreadOpen(false);
          project.select({ eventIds: [], measures: { from: measureIndex, to: measureIndex }, partIds: partId ? [partId] : [] });
          setFocus(measureIndex);
        }}
      />
      <BarDialogs
        dialog={barDialog}
        score={score}
        selection={project.selection}
        concert={project.concert}
        onClose={() => setBarDialog(null)}
        onApply={(next, label) => apply(next, label)}
      />
    </AppShell>
  );
}
