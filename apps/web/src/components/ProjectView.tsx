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
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { notifications } from "@mantine/notifications";
import { previewActive, useAssistant } from "../ai/assistant";
import { changedBars } from "../ai/diff";
import type { PageRecord } from "../lib/db";
import { describeSelection } from "../lib/describe";
import { handleEditorKey } from "../lib/editor";
import { listPages } from "../lib/projects";
import { modals } from "../lib/modals";
import { EMPTY_SELECTION, useProject } from "../state/project";
import { usePlayback } from "../state/playback";
import { useStage, type MainView } from "../state/stage";
import { arrangeSeats, soundPositions } from "../stage/layout";
import { ErrorBoundary } from "./ErrorBoundary";
import { Tip } from "./Tip";
import { unavailable } from "./unavailable";
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
import { RestRunsPanel } from "./RestRunsPanel";
import { ScoreView, type MeasureMark } from "./ScoreView";

// The 3D stage (A-Frame and three.js) loads only when it is first opened.
const StageView = lazy(() => import("../stage/StageView"));

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
  const stage = useStage();
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
    void useStage.getState().load(projectId);
    return () => {
      active = false;
      useAssistant.getState().reset(null);
      useProject.getState().close();
      useStage.getState().close();
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

  // Where each part's sound comes from: the players' seats on the stage (a stereo spread in the score view).
  const playedScore = assistant.draft ?? score;
  useEffect(() => {
    if (playedScore) usePlayback.getState().setSeats(soundPositions(arrangeSeats(playedScore, stage.venue, stage.seats)));
  }, [playedScore, stage.venue, stage.seats]);
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

  // Note entry and editing keys (see the shortcut list in the edit toolbar). On the stage, the
  // letters and arrows walk the camera instead.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (useStage.getState().view === "stage") return;
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
          <UnstyledButton c="blue" onClick={onBack} title="Back to the list of your scores">
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
            <Tip label={navOpen ? "Hide the side panel" : "Show the parts, checks and history"}>
              <Burger opened={navOpen} onClick={nav.toggle} hiddenFrom="md" size="sm" aria-label="Side panel" />
            </Tip>
            <Tip label="Back to your scores (everything is saved as you go)">
              <ActionIcon variant="subtle" onClick={onBack} aria-label="Back to your scores">
                <IconChevronLeft size={20} />
              </ActionIcon>
            </Tip>
            <Tip label="Rename this project">
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
            </Tip>
          </Group>
          <Group gap={6} wrap="nowrap">
            <Tip label={assistant.draft ? "Undo: discard the assistant's changes (Ctrl+Z)" : lastLabel ? `Undo (Ctrl+Z): ${lastLabel}` : "Undo (Ctrl+Z): nothing to undo yet"}>
              <ActionIcon
                variant="subtle"
                {...unavailable((!project.past.length && !assistant.draft) || assistant.running)}
                onClick={() => (project.past.length || assistant.draft) && !assistant.running && undo()}
                aria-label="Undo"
              >
                <IconArrowBackUp size={18} />
              </ActionIcon>
            </Tip>
            <Tip label={nextLabel ? `Redo (Ctrl+Y): ${nextLabel}` : "Redo (Ctrl+Y): nothing to redo"}>
              <ActionIcon
                variant="subtle"
                {...unavailable(!project.future.length || !!assistant.draft || assistant.running)}
                onClick={() => project.future.length && !assistant.draft && !assistant.running && redo()}
                aria-label="Redo"
              >
                <IconArrowForwardUp size={18} />
              </ActionIcon>
            </Tip>
            <Tip label="Concert pitch: show every part at the pitch it sounds, instead of as written for transposing instruments (a B♭ trumpet's written D shows as C)">
              <Switch
                size="xs"
                label="Concert pitch"
                checked={project.concert}
                onChange={(e) => project.setConcert(e.currentTarget.checked)}
                visibleFrom="sm"
              />
            </Tip>
            <Group gap={0} visibleFrom="sm">
              <Tip label="Zoom out: smaller notation, more bars on screen">
                <ActionIcon variant="subtle" onClick={() => project.setZoom(project.zoom / 1.15)} aria-label="Zoom out">
                  <IconZoomOut size={18} />
                </ActionIcon>
              </Tip>
              <Tip label="Zoom in: larger notation">
                <ActionIcon variant="subtle" onClick={() => project.setZoom(project.zoom * 1.15)} aria-label="Zoom in">
                  <IconZoomIn size={18} />
                </ActionIcon>
              </Tip>
            </Group>
            {pages.length > 0 && !narrow && (
              <Tip label={showOriginal ? "Hide the original pages" : "Show the original pages next to the score, to compare bar by bar"}>
                <ActionIcon variant={showOriginal ? "light" : "subtle"} onClick={() => setShowOriginal((v) => !v)} aria-label="Original pages">
                  <IconPhoto size={18} />
                </ActionIcon>
              </Tip>
            )}
            <Tip label={assistantOpen ? "Close the AI assistant" : "Ask the AI assistant to change the music in your words, e.g. \"make this a trumpet in C part\""}>
              <ActionIcon
                variant={assistantOpen ? "light" : "subtle"}
                onClick={() => setAssistantOpen((v) => !v)}
                aria-label="Assistant"
                data-testid="assistant-toggle"
              >
                <IconSparkles size={18} />
              </ActionIcon>
            </Tip>
            <PlaybackBar score={shown} selection={project.selection} />
            <ExportMenu score={score} name={project.name} projectId={projectId} />
            <Tip label="Settings: your server, API key, language model and recognition service">
              <ActionIcon variant="subtle" onClick={onOpenSettings} aria-label="Settings">
                <IconSettings size={18} />
              </ActionIcon>
            </Tip>
          </Group>
        </Group>
      </AppShell.Header>

      <AppShell.Navbar p="sm">
        <Tabs value={tab} onChange={setTab} style={{ display: "flex", flexDirection: "column", height: "100%" }}>
          <Tabs.List grow>
            <Tip label="Parts: instruments, transposing, adding parts and arranging for another ensemble">
              <Tabs.Tab value="parts">Parts</Tabs.Tab>
            </Tip>
            <Tip label="Checks: bars that don't add up, notes out of range, rests to compare with the original, and AI proofreading">
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
            </Tip>
            <Tip label="History: saved versions of this score, to compare with or go back to">
              <Tabs.Tab value="history">History</Tabs.Tab>
            </Tip>
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
                <Tip label="A vision model compares each line of the original pages with the recognised notes and lists the differences to fix, one by one">
                  <Button size="xs" variant="light" fullWidth mb="sm" leftSection={<IconSparkles size={14} />} onClick={() => setProofreadOpen(true)}>
                    Proofread against the original with AI
                  </Button>
                </Tip>
              )}
              {pages.length > 0 && (
                <RestRunsPanel
                  score={score}
                  onApply={(next, label) => apply(next, label)}
                  onShow={(m) => {
                    project.select({ eventIds: [], measures: { from: m, to: m } });
                    setFocus(m);
                  }}
                />
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
        <Group gap={0} wrap="nowrap" align="center" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
          <Tip label="Score: read and edit the notes. Stage: the parts as players in 3D, to hear and see who plays what, where.">
            <SegmentedControl
              size="xs"
              ml="sm"
              value={stage.view}
              onChange={(v) => stage.setView(v as MainView)}
              data={[
                { value: "score", label: "Score" },
                { value: "stage", label: "Stage" },
              ]}
              aria-label="Main view"
              data-testid="main-view"
            />
          </Tip>
          {stage.view === "score" && (
            <div style={{ flex: 1, minWidth: 0 }}>
              <EditToolbar selection={project.selection} onBarDialog={setBarDialog} />
            </div>
          )}
          {stage.view === "stage" && (
            <Text size="xs" c="dimmed" px="sm" py={10}>
              Click a player to select their part · drag to look around · W A S D to walk
            </Text>
          )}
        </Group>
        {stage.view === "stage" ? (
          <div style={{ flex: 1, minHeight: 0 }}>
            <ErrorBoundary
              fallback={(error) => (
                <Center h="100%" p="xl">
                  <Text size="sm" c="dimmed" ta="center" maw={420}>
                    The 3D stage couldn&apos;t start: {error.message}. It needs WebGL, which this browser or device may have turned off.{" "}
                    <UnstyledButton c="blue" onClick={() => stage.setView("score")} title="Show the score instead of the stage">
                      Back to the score
                    </UnstyledButton>
                  </Text>
                </Center>
              )}
            >
              <Suspense
                fallback={
                  <Center h="100%">
                    <Loader />
                  </Center>
                }
              >
                <StageView
                  score={shown}
                  selectedPartId={project.selection.partIds?.[0] ?? null}
                  onSelectPart={(partId) => project.select({ eventIds: [], partIds: partId ? [partId] : [], measures: project.selection.measures })}
                  onShowInScore={(partId) => {
                    project.select({ eventIds: [], partIds: [partId], measures: project.selection.measures });
                    stage.setView("score");
                  }}
                  onApply={(next, label) => apply(next, label, true)}
                />
              </Suspense>
            </ErrorBoundary>
          </div>
        ) : (
          <>
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
          </>
        )}
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
