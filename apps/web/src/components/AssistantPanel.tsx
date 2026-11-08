import {
  ActionIcon,
  Alert,
  Badge,
  Button,
  Collapse,
  Group,
  Loader,
  Menu,
  Paper,
  ScrollArea,
  Stack,
  Text,
  Textarea,
  Tooltip,
  UnstyledButton,
} from "@mantine/core";
import { getInstrument, isUnison, type Score } from "@musicraft/score-core";
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconDots,
  IconPlayerStopFilled,
  IconRefresh,
  IconSend2,
  IconSettings,
  IconSparkles,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useAssistant, useLlm, type ChatEntry } from "../ai/assistant";
import type { PageRecord } from "../lib/db";
import { useSettings } from "../lib/settings";
import type { Selection } from "../state/project";

const TOOL_LABELS: Record<string, [running: string, done: string]> = {
  get_overview: ["Looking at the score", "Looked at the score"],
  get_bars: ["Reading bars", "Read bars"],
  get_issues: ["Checking for problems", "Checked for problems"],
  analyze_harmony: ["Analysing the harmony", "Analysed the harmony"],
  list_instruments: ["Looking up instruments", "Looked up instruments"],
  transpose: ["Transposing", "Transposed"],
  change_instrument: ["Changing the instrument", "Changed the instrument"],
  shift_octave: ["Moving by octaves", "Moved by octaves"],
  copy_bars: ["Copying bars", "Copied bars"],
  write_bars: ["Writing bars", "Wrote bars"],
  set_bar_properties: ["Changing bar settings", "Changed bar settings"],
  add_dynamics: ["Adding dynamics", "Added dynamics"],
  add_hairpin: ["Adding a hairpin", "Added a hairpin"],
  add_text: ["Adding text", "Added text"],
  set_articulation: ["Setting articulations", "Set articulations"],
  insert_bars: ["Inserting bars", "Inserted bars"],
  delete_bars: ["Deleting bars", "Deleted bars"],
  add_part: ["Adding a part", "Added a part"],
  remove_part: ["Removing a part", "Removed a part"],
  rename_part: ["Renaming a part", "Renamed a part"],
  set_info: ["Setting the title", "Set the title"],
  look_at_page: ["Looking at the original page", "Looked at the original page"],
};

function barsOf(args: string): string {
  try {
    const a = JSON.parse(args) as { from?: unknown; to?: unknown };
    if (a.from === undefined) return "";
    return a.to !== undefined && a.to !== a.from ? ` ${a.from}–${a.to}` : ` ${a.from}`;
  } catch {
    return "";
  }
}

function ToolRow({ entry }: { entry: Extract<ChatEntry, { kind: "tool" }> }) {
  const [open, setOpen] = useState(false);
  const labels = TOOL_LABELS[entry.name] ?? [entry.name, entry.name];
  const reads = entry.name === "get_bars" || entry.name === "look_at_page";
  const title = `${entry.status === "running" ? labels[0] : labels[1]}${reads ? barsOf(entry.args) : ""}`;
  const icon =
    entry.status === "running" ? <Loader size={12} /> : entry.status === "error" ? <IconAlertTriangle size={14} color="var(--mantine-color-orange-6)" /> : <IconCheck size={14} color="var(--mantine-color-teal-6)" />;
  return (
    <div className="chat-tool" data-testid="chat-tool">
      <UnstyledButton onClick={() => setOpen((o) => !o)} style={{ width: "100%" }}>
        <Group gap={6} wrap="nowrap" align="flex-start">
          <div style={{ paddingTop: 2 }}>{icon}</div>
          <Text size="xs" c="dimmed" style={{ flex: 1 }}>
            {entry.summary ?? title}
            {entry.status === "error" && " — the assistant got an error and may retry"}
          </Text>
          {open ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
        </Group>
      </UnstyledButton>
      <Collapse expanded={open}>
        <Text size="xs" ff="monospace" className="chat-pre" mt={4}>
          {entry.name}({entry.args || "{}"})
          {entry.result ? `\n→ ${entry.result.length > 1500 ? `${entry.result.slice(0, 1500)}…` : entry.result}` : ""}
        </Text>
      </Collapse>
    </div>
  );
}

function AssistantText({ entry }: { entry: Extract<ChatEntry, { kind: "assistant" }> }) {
  const [showThinking, setShowThinking] = useState(false);
  return (
    <div data-testid="chat-assistant">
      {entry.reasoning && (
        <UnstyledButton onClick={() => setShowThinking((v) => !v)}>
          <Group gap={4}>
            {showThinking ? <IconChevronDown size={12} /> : <IconChevronRight size={12} />}
            <Text size="xs" c="dimmed">
              {entry.streaming && !entry.text ? "Thinking…" : "Thoughts"}
            </Text>
          </Group>
        </UnstyledButton>
      )}
      <Collapse expanded={showThinking}>
        <Text size="xs" c="dimmed" className="chat-pre" mb={4}>
          {entry.reasoning}
        </Text>
      </Collapse>
      {entry.text && (
        <Text size="sm" className="chat-pre">
          {entry.text}
        </Text>
      )}
      {entry.streaming && !entry.text && !entry.reasoning && <Loader type="dots" size="sm" />}
    </div>
  );
}

function suggestions(score: Score, hasPages: boolean, vision: boolean): string[] {
  const list: string[] = [];
  const transposing = score.parts.find((p) => !isUnison(getInstrument(p.instrument).transposition));
  if (transposing) list.push(`Rewrite P${score.parts.indexOf(transposing) + 1} for a C instrument, same sound`);
  if (score.parts.length === 1 && getInstrument(score.parts[0]!.instrument).group === "trumpet") list.push("Make this a clarinet part");
  list.push("Transpose the whole piece up a whole step");
  if (hasPages && vision) list.push("Compare bars 1–8 with the original page and fix mistakes");
  list.push("Add dynamics and articulations to the melody");
  list.push("What key is this in, and what are the chords in bars 1–4?");
  return list.slice(0, 5);
}

interface Props {
  score: Score;
  selection: Selection;
  pages: PageRecord[];
  onOpenSettings: () => void;
}

/** Chat with the language model, which edits a draft of the score through music tools. */
export function AssistantPanel({ score, selection, pages, onOpenSettings }: Props) {
  const assistant = useAssistant();
  const llm = useLlm();
  const serverUrl = useSettings((s) => s.serverUrl);
  const [text, setText] = useState("");
  const viewport = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void useLlm.getState().detect();
  }, [serverUrl]);

  // Follow the conversation as it streams.
  const lastEntry = assistant.entries[assistant.entries.length - 1];
  const lastLength = lastEntry ? (lastEntry.kind === "assistant" ? lastEntry.text.length + lastEntry.reasoning.length : 0) : 0;
  useEffect(() => {
    const el = viewport.current;
    if (el) el.scrollTo({ top: el.scrollHeight });
  }, [assistant.entries.length, lastLength, assistant.draft]);

  const tips = useMemo(() => suggestions(score, pages.length > 0, !!llm.caps?.vision), [score, pages.length, llm.caps?.vision]);

  const send = (value = text) => {
    if (!value.trim() || assistant.running) return;
    setText("");
    void assistant.send(value, { selection, pages });
  };

  const status =
    llm.status === "detecting" ? (
      <Badge variant="light" color="gray" leftSection={<Loader size={8} />}>
        Connecting
      </Badge>
    ) : llm.status === "ready" && llm.caps ? (
      <Tooltip
        multiline
        w={260}
        label={`Model: ${llm.caps.model}\nContext: ${llm.caps.contextSize ? `${llm.caps.contextSize} tokens` : "unknown (8192 assumed)"}\nImages: ${llm.caps.vision === null ? "unknown" : llm.caps.vision ? "yes" : "no"}`}
        style={{ whiteSpace: "pre-line" }}
      >
        <Badge variant="light" color="teal" maw={170} style={{ textTransform: "none" }}>
          {llm.caps.model?.replace(/\.gguf$/i, "")}
        </Badge>
      </Tooltip>
    ) : llm.status === "error" ? (
      <Badge variant="light" color="red">
        Not connected
      </Badge>
    ) : null;

  return (
    <Stack h="100%" gap={0} data-testid="assistant-panel">
      <Group justify="space-between" px="sm" py={8} wrap="nowrap" style={{ borderBottom: "1px solid var(--mantine-color-default-border)" }}>
        <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
          <IconSparkles size={18} />
          <Text fw={650}>Assistant</Text>
          {status}
        </Group>
        <Menu position="bottom-end" withinPortal>
          <Menu.Target>
            <ActionIcon variant="subtle" aria-label="Assistant menu">
              <IconDots size={16} />
            </ActionIcon>
          </Menu.Target>
          <Menu.Dropdown>
            <Menu.Item leftSection={<IconTrash size={14} />} disabled={assistant.running} onClick={() => assistant.reset(assistant.projectId)}>
              New chat
            </Menu.Item>
            <Menu.Item leftSection={<IconRefresh size={14} />} onClick={() => void llm.detect(true)}>
              Reconnect to the model
            </Menu.Item>
            <Menu.Item leftSection={<IconSettings size={14} />} onClick={onOpenSettings}>
              Server settings
            </Menu.Item>
          </Menu.Dropdown>
        </Menu>
      </Group>

      <ScrollArea style={{ flex: 1 }} viewportRef={viewport} px="sm" type="auto">
        <Stack gap="sm" py="sm">
          {llm.status === "error" && (
            <Alert color="red" variant="light" title="The language model isn't reachable">
              <Text size="sm">{llm.error}</Text>
              <Group gap="xs" mt="xs">
                <Button size="xs" variant="light" onClick={onOpenSettings}>
                  Settings
                </Button>
                <Button size="xs" variant="subtle" onClick={() => void llm.detect(true)}>
                  Try again
                </Button>
              </Group>
            </Alert>
          )}
          {assistant.entries.length === 0 && (
            <Stack gap={6}>
              <Text size="sm" c="dimmed">
                Describe a change and the assistant makes it with Musicraft&apos;s music tools. You see a preview before
                anything is kept. Select bars or notes first to talk about &ldquo;this&rdquo;.
              </Text>
              {tips.map((tip) => (
                <UnstyledButton key={tip} className="chat-suggestion" onClick={() => send(tip)} disabled={assistant.running}>
                  <Text size="sm">{tip}</Text>
                </UnstyledButton>
              ))}
            </Stack>
          )}
          {assistant.entries.map((entry) => {
            switch (entry.kind) {
              case "user":
                return (
                  <Paper key={entry.id} className="chat-user" p="xs" radius="md" data-testid="chat-user">
                    <Text size="sm" className="chat-pre">
                      {entry.text}
                    </Text>
                  </Paper>
                );
              case "assistant":
                return <AssistantText key={entry.id} entry={entry} />;
              case "tool":
                return <ToolRow key={entry.id} entry={entry} />;
              case "error":
                return (
                  <Alert key={entry.id} color="red" variant="light" icon={<IconAlertTriangle size={16} />} data-testid="chat-error">
                    <Text size="sm" className="chat-pre">
                      {entry.text}
                    </Text>
                  </Alert>
                );
              case "notice":
                return (
                  <Text key={entry.id} size="xs" c="dimmed" ta="center">
                    {entry.text}
                  </Text>
                );
            }
          })}
          {assistant.running && assistant.entries[assistant.entries.length - 1]?.kind !== "assistant" && <Loader type="dots" size="sm" />}
        </Stack>
      </ScrollArea>

      {assistant.draft && !assistant.running && (
        <Paper m="sm" p="sm" radius="md" withBorder className="chat-preview" data-testid="assistant-preview">
          <Text size="sm" fw={600}>
            Preview: {assistant.changes.length} change{assistant.changes.length === 1 ? "" : "s"} (green bars)
          </Text>
          <Stack gap={2} my={6}>
            {assistant.changes.slice(0, 6).map((c, i) => (
              <Text key={i} size="xs" c="dimmed">
                • {c}
              </Text>
            ))}
            {assistant.changes.length > 6 && (
              <Text size="xs" c="dimmed">
                … and {assistant.changes.length - 6} more
              </Text>
            )}
          </Stack>
          <Group gap="xs">
            <Button size="xs" color="teal" leftSection={<IconCheck size={14} />} onClick={assistant.accept}>
              Keep changes
            </Button>
            <Button size="xs" variant="default" leftSection={<IconX size={14} />} onClick={assistant.discard}>
              Discard
            </Button>
          </Group>
        </Paper>
      )}

      <div style={{ padding: "8px 12px 12px", borderTop: "1px solid var(--mantine-color-default-border)" }}>
        <Group align="flex-end" gap="xs" wrap="nowrap">
          <Textarea
            style={{ flex: 1 }}
            autosize
            minRows={1}
            maxRows={6}
            placeholder={assistant.draft ? "Ask for more changes, or keep/discard the preview" : "e.g. “Make bars 17–24 an octave lower”"}
            value={text}
            onChange={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
            aria-label="Message to the assistant"
            data-testid="assistant-input"
          />
          {assistant.running ? (
            <Tooltip label="Stop">
              <ActionIcon size="lg" color="red" variant="light" onClick={assistant.stop} aria-label="Stop">
                <IconPlayerStopFilled size={16} />
              </ActionIcon>
            </Tooltip>
          ) : (
            <Tooltip label="Send (Enter)">
              <ActionIcon size="lg" onClick={() => send()} disabled={!text.trim()} aria-label="Send">
                <IconSend2 size={16} />
              </ActionIcon>
            </Tooltip>
          )}
        </Group>
      </div>
    </Stack>
  );
}
