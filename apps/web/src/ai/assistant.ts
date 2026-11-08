/** State of the AI assistant: model detection, the chat, and the draft the user previews. */
import {
  aiBarLabels,
  eventOnsets,
  formatPitch,
  getInstrument,
  isUnison,
  locate,
  measureLengths,
  partHandle,
  timeSignatures,
  toNumber,
  toWrittenPitch,
  writtenContexts,
  type Score,
} from "@musicraft/score-core";
import { create } from "zustand";
import type { PageRecord } from "../lib/db";
import { detectLlm, type LlmCapabilities } from "../lib/server";
import { getSettings, isServerConfigured, type Settings } from "../lib/settings";
import { useProject, type Selection } from "../state/project";
import { AgentError, compactTurn, runAgent, type BrowserTool } from "./agent";
import type { ChatMessage, ToolCall } from "./llm";
import { lookAtPageTool } from "./vision";

// ---------------------------------------------------------------------------
// Model detection
// ---------------------------------------------------------------------------

type LlmStatus = "idle" | "detecting" | "ready" | "error";

interface LlmState {
  status: LlmStatus;
  caps: LlmCapabilities | null;
  error: string | null;
  key: string;
  detect(force?: boolean): Promise<LlmCapabilities | null>;
}

const settingsKey = (s: Settings) => [s.serverUrl, s.llmPath, s.apiKey, s.modelOverride, s.contextOverride, s.visionOverride].join("|");

let detecting: Promise<LlmCapabilities | null> | null = null;

export const useLlm = create<LlmState>()((set, get) => ({
  status: "idle",
  caps: null,
  error: null,
  key: "",
  async detect(force = false) {
    const settings = getSettings();
    const key = settingsKey(settings);
    const state = get();
    if (!force && state.key === key && state.status === "ready") return state.caps;
    if (!force && state.key === key && detecting) return detecting;
    if (!isServerConfigured(settings)) {
      set({ status: "error", caps: null, error: "No server is set up yet. Open Settings and enter your server's address and API key.", key });
      return null;
    }
    set({ status: "detecting", error: null, key });
    detecting = detectLlm(settings)
      .then((caps) => {
        if (!caps.model) throw new Error("The server lists no models.");
        set({ status: "ready", caps, error: null });
        return caps;
      })
      .catch((err: Error) => {
        set({ status: "error", caps: null, error: err.message });
        return null;
      })
      .finally(() => {
        detecting = null;
      });
    return detecting;
  },
}));

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export type ChatEntry =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; reasoning: string; streaming: boolean }
  | { kind: "tool"; id: string; name: string; args: string; status: "running" | "done" | "error"; result?: string; summary?: string }
  | { kind: "error"; id: string; text: string }
  | { kind: "notice"; id: string; text: string };

interface AssistantState {
  projectId: string | null;
  /** Changes on every reset, so a request that was stopped by a reset can't write into the new chat. */
  session: number;
  entries: ChatEntry[];
  history: ChatMessage[];
  running: boolean;
  controller: AbortController | null;
  /** The score before the assistant's changes, while a draft is shown. */
  base: Score | null;
  draft: Score | null;
  changes: string[];
  reset(projectId: string | null): void;
  send(text: string, options?: { selection?: Selection; pages?: PageRecord[] }): Promise<void>;
  stop(): void;
  accept(): void;
  discard(): void;
}

let entryCounter = 0;
const nextId = () => `c${++entryCounter}`;

/** What the user has selected, in the words the model knows (P1, bar numbers, beats, written/concert). */
export function selectionContext(score: Score, selection: Selection | undefined): string | undefined {
  if (!selection) return undefined;
  const labels = aiBarLabels(score);
  if (selection.eventIds.length) {
    const lines: string[] = [];
    for (const id of selection.eventIds.slice(0, 8)) {
      const loc = locate(score, id);
      if (!loc) continue;
      const part = score.parts[loc.partIndex]!;
      const voice = part.measures[loc.measureIndex]!.voices[loc.voiceIndex]!;
      const event = voice.events[loc.eventIndex]!;
      const time = timeSignatures(score)[loc.measureIndex]!;
      const onset = eventOnsets(voice, measureLengths(score)[loc.measureIndex]!)[loc.eventIndex]!;
      const beat = Math.round((1 + toNumber(onset) * time.beatType) * 100) / 100;
      const where = `${partHandle(loc.partIndex)} "${part.name}"${part.staves > 1 ? ` staff ${voice.staff}` : ""}, bar ${labels[loc.measureIndex]}, beat ${beat}`;
      if (event.kind === "rest") {
        lines.push(`${where}: a rest`);
        continue;
      }
      const concert = event.notes.map((n) => formatPitch(n.pitch)).join(" ");
      const transposing = !isUnison(getInstrument(part.instrument).transposition);
      const ctx = writtenContexts(score, part)[loc.measureIndex]!;
      const written = event.notes.map((n) => formatPitch(toWrittenPitch(n.pitch, ctx))).join(" ");
      lines.push(`${where}: ${transposing ? `written ${written} (concert ${concert})` : concert}`);
    }
    if (lines.length) return `The user has selected:\n${lines.map((l) => `- ${l}`).join("\n")}`;
  }
  if (selection.measures) {
    const { from, to } = selection.measures;
    const bars = from === to ? `bar ${labels[from]}` : `bars ${labels[from]}–${labels[to]}`;
    const parts = selection.partIds?.length
      ? selection.partIds
          .map((id) => score.parts.findIndex((p) => p.id === id))
          .filter((i) => i >= 0)
          .map((i) => `${partHandle(i)} "${score.parts[i]!.name}"`)
          .join(", ")
      : "all parts";
    return `The user has selected ${bars} of ${parts}.`;
  }
  return undefined;
}

function update(id: string, change: (entry: ChatEntry) => ChatEntry) {
  useAssistant.setState((s) => ({ entries: s.entries.map((e) => (e.id === id ? change(e) : e)) }));
}

function push(entry: ChatEntry) {
  useAssistant.setState((s) => ({ entries: [...s.entries, entry] }));
}

export const useAssistant = create<AssistantState>()((set, get) => ({
  projectId: null,
  session: 0,
  entries: [],
  history: [],
  running: false,
  controller: null,
  base: null,
  draft: null,
  changes: [],

  reset(projectId) {
    get().controller?.abort();
    set({ projectId, session: get().session + 1, entries: [], history: [], running: false, controller: null, base: null, draft: null, changes: [] });
  },

  async send(text, options = {}) {
    const request = text.trim();
    if (!request || get().running) return;
    const projectScore = useProject.getState().score;
    if (!projectScore) return;
    // Everything below writes only while the chat is still the one this request started in.
    const session = get().session;
    const live = () => get().session === session;
    const guard =
      <A extends unknown[]>(fn: (...args: A) => void) =>
      (...args: A) => {
        if (live()) fn(...args);
      };
    push({ kind: "user", id: nextId(), text: request });
    const controller = new AbortController();
    set({ running: true, controller });
    const caps = await useLlm.getState().detect();
    if (!live()) return;
    if (!caps) {
      push({ kind: "error", id: nextId(), text: useLlm.getState().error ?? "The language model is not available." });
      set({ running: false, controller: null });
      return;
    }
    const start = get().draft ?? projectScore;
    const browserTools: BrowserTool[] = [];
    if (caps.vision && options.pages?.length) browserTools.push(lookAtPageTool(options.pages));
    let current: string | null = null;
    const ensureTurn = () => {
      if (!current) {
        current = nextId();
        push({ kind: "assistant", id: current, text: "", reasoning: "", streaming: true });
      }
      return current;
    };
    try {
      const result = await runAgent(
        {
          settings: getSettings(),
          model: caps.model,
          contextSize: caps.contextSize,
          score: start,
          request,
          context: selectionContext(start, options.selection),
          history: get().history,
          browserTools,
          signal: controller.signal,
        },
        {
          onStep: () => {
            current = null;
          },
          onContent: guard((delta: string) => update(ensureTurn(), (e) => (e.kind === "assistant" ? { ...e, text: e.text + delta } : e))),
          onReasoning: guard((delta: string) => update(ensureTurn(), (e) => (e.kind === "assistant" ? { ...e, reasoning: e.reasoning + delta } : e))),
          onTurnText: guard((turnText: string) => {
            if (!current) return;
            const id = current;
            const entry = get().entries.find((e) => e.id === id);
            if (entry?.kind === "assistant" && !turnText.trim() && !entry.reasoning.trim()) {
              set({ entries: get().entries.filter((e) => e.id !== id) });
            } else update(id, (e) => (e.kind === "assistant" ? { ...e, text: turnText.trim(), streaming: false } : e));
            current = null;
          }),
          onToolStart: guard((call: ToolCall) => push({ kind: "tool", id: call.id, name: call.function.name, args: call.function.arguments, status: "running" })),
          onToolEnd: guard((call: ToolCall, outcome: { result: string; error?: boolean; summary?: string }) =>
            update(call.id, (e) => (e.kind === "tool" ? { ...e, status: outcome.error ? "error" : "done", result: outcome.result, summary: outcome.summary } : e)),
          ),
          onDraft: guard((score: Score, summary: string) => set((s) => ({ draft: score, base: s.base ?? projectScore, changes: [...s.changes, summary] }))),
        },
      );
      if (!live()) return;
      set((s) => ({ history: [...s.history, ...compactTurn(request, result.text, result.changes)].slice(-24) }));
      if (result.stoppedAt) push({ kind: "notice", id: nextId(), text: result.text });
    } catch (err) {
      if (!live()) return;
      const aborted = (err as Error).name === "AbortError" || controller.signal.aborted;
      if (aborted) push({ kind: "notice", id: nextId(), text: "Stopped." });
      else push({ kind: "error", id: nextId(), text: err instanceof AgentError ? err.message : (err as Error).message || String(err) });
      set((s) => ({ history: [...s.history, ...compactTurn(request, aborted ? "(stopped by the user)" : "(failed)", [])].slice(-24) }));
    } finally {
      if (live()) {
        set((s) => ({
          running: false,
          controller: null,
          entries: s.entries.map((e) =>
            e.kind === "assistant" && e.streaming
              ? { ...e, streaming: false }
              : e.kind === "tool" && e.status === "running"
                ? { ...e, status: "error", result: "Interrupted." }
                : e,
          ),
        }));
      }
    }
  },

  stop() {
    get().controller?.abort();
  },

  accept() {
    const { draft, changes } = get();
    if (!draft) return;
    const first = changes[0] ?? "Changes";
    const label = `AI: ${first}${changes.length > 1 ? ` (+${changes.length - 1} more)` : ""}`;
    useProject.getState().apply(draft, label.length > 90 ? `${label.slice(0, 89)}…` : label, { checkpoint: true, author: "ai" });
    set({ draft: null, base: null, changes: [] });
    push({ kind: "notice", id: nextId(), text: "Changes accepted. Undo (Ctrl+Z) or the History tab can take them back." });
  },

  discard() {
    if (!get().draft) return;
    set((s) => {
      const history = [...s.history];
      const last = history[history.length - 1];
      if (last?.role === "assistant" && typeof last.content === "string") {
        history[history.length - 1] = { ...last, content: `${last.content}\n(The user discarded these changes; the score is back to how it was.)` };
      }
      return { draft: null, base: null, changes: [], history };
    });
    // The selection may point at notes that only existed in the draft.
    useProject.getState().select({ eventIds: [] });
    push({ kind: "notice", id: nextId(), text: "Changes discarded." });
  },
}));

/** Whether manual edits must wait (the assistant's draft is on screen). */
export function previewActive(): boolean {
  return useAssistant.getState().draft !== null || useAssistant.getState().running;
}
