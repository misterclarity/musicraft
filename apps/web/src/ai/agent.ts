/**
 * The assistant's agent loop, run in the browser: the model calls music tools, which change a draft
 * copy of the score; errors go back to the model; the user previews the draft and accepts or discards it.
 */
import {
  describeScore,
  openAiTools,
  runTool,
  SCORE_TOOLS,
  systemPrompt,
  type AiTool,
  type Score,
} from "@musicraft/score-core";
import type { Settings } from "../lib/settings";
import { parseArguments, streamChat, type ChatMessage, type CompletionResult, type ToolCall, type ToolSpec } from "./llm";

/** A tool that needs the browser (e.g. images of the original pages). */
export interface BrowserTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  run(args: unknown, score: Score): Promise<{ result: string; images?: string[]; error?: boolean }>;
}

export interface AgentEvents {
  /** A new model turn starts (step = 1, 2, …). */
  onStep?(step: number): void;
  onContent?(delta: string): void;
  onReasoning?(delta: string): void;
  /** The text of the finished model turn (tool-call markup removed). */
  onTurnText?(text: string): void;
  onToolStart?(call: ToolCall): void;
  onToolEnd?(call: ToolCall, outcome: { result: string; error?: boolean; summary?: string }): void;
  /** The draft changed. */
  onDraft?(score: Score, summary: string): void;
}

export interface AgentOptions {
  settings: Settings;
  model: string | null;
  /** Context window in tokens (null: unknown, assume a small one). */
  contextSize: number | null;
  score: Score;
  request: string;
  /** Extra context for this request, e.g. what the user selected. */
  context?: string;
  /** Earlier turns of this chat (user requests and assistant summaries). */
  history?: ChatMessage[];
  browserTools?: BrowserTool[];
  signal?: AbortSignal;
  /** Most model turns per request. */
  maxSteps?: number;
}

export interface AgentResult {
  score: Score;
  changes: string[];
  /** The model's final answer. */
  text: string;
  /** Messages of this request, for the chat history. */
  transcript: ChatMessage[];
  stoppedAt?: "steps";
}

const DEFAULT_CONTEXT = 8192;
const IMAGE_TOKENS = 1100;

export function estimateTokens(messages: ChatMessage[], tools: ToolSpec[] = []): number {
  let chars = JSON.stringify(tools).length;
  let images = 0;
  for (const m of messages) {
    if (typeof m.content === "string") chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part.type === "text") chars += part.text.length;
        else images++;
      }
    }
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    chars += 12;
  }
  // Music notation and JSON tokenize densely: about 3.2 characters per token.
  return Math.ceil(chars / 3.2) + images * IMAGE_TOKENS;
}

/**
 * Shrink the conversation to fit the context: first old tool results, then old images, then the
 * oldest earlier turns. Returns false when it still doesn't fit.
 */
export function fitToContext(messages: ChatMessage[], tools: ToolSpec[], budget: number, keepFrom: number): boolean {
  if (estimateTokens(messages, tools) <= budget) return true;
  const toolIndexes = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  for (const i of toolIndexes.slice(0, -2)) {
    const m = messages[i]!;
    if (typeof m.content === "string" && m.content.length > 200) {
      m.content = `${m.content.slice(0, 120)}… [shortened to save space; call the tool again if you need it]`;
      if (estimateTokens(messages, tools) <= budget) return true;
    }
  }
  for (let i = 0; i < messages.length - 1; i++) {
    const m = messages[i]!;
    if (Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")) {
      m.content = m.content.map((p) => (p.type === "image_url" ? { type: "text" as const, text: "[image removed to save space]" } : p));
      if (estimateTokens(messages, tools) <= budget) return true;
    }
  }
  // Drop earlier chat turns (after the system prompt, before this request), a request and its answer
  // at a time: some chat templates insist that user and assistant messages alternate.
  while (keepFrom > 1 && estimateTokens(messages, tools) > budget) {
    const count = Math.min(2, keepFrom - 1);
    messages.splice(1, count);
    keepFrom -= count;
  }
  return estimateTokens(messages, tools) <= budget;
}

export class AgentError extends Error {}

function userMessage(score: Score, request: string, context?: string): string {
  return `Score overview:\n${describeScore(score)}${context ? `\n\n${context}` : ""}\n\nRequest: ${request}`;
}

export async function runAgent(options: AgentOptions, events: AgentEvents = {}): Promise<AgentResult> {
  const tools: AiTool[] = SCORE_TOOLS;
  const browserTools = options.browserTools ?? [];
  const specs: ToolSpec[] = [
    ...openAiTools(tools),
    ...browserTools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
  ];
  const system: ChatMessage = { role: "system", content: systemPrompt({ vision: browserTools.some((t) => t.name === "look_at_page") }) };
  const history = (options.history ?? []).map((m) => ({ ...m }));
  const request: ChatMessage = { role: "user", content: userMessage(options.score, options.request, options.context) };
  const messages: ChatMessage[] = [system, ...history, request];
  const transcriptStart = 1 + history.length;
  const contextSize = options.contextSize ?? DEFAULT_CONTEXT;
  const budget = Math.floor(contextSize * 0.9) - Math.min(4096, Math.floor(contextSize * 0.2));
  const maxSteps = options.maxSteps ?? 24;

  let score = options.score;
  const changes: string[] = [];
  let text = "";

  for (let step = 1; step <= maxSteps; step++) {
    if (options.signal?.aborted) throw new DOMException("Stopped", "AbortError");
    if (!fitToContext(messages, specs, budget, transcriptStart)) {
      throw new AgentError(
        `The conversation no longer fits the model's context (${contextSize} tokens). Start a new chat, ask for fewer bars at a time, or give the server a larger context (-c).`,
      );
    }
    events.onStep?.(step);
    const result: CompletionResult = await streamChat(
      options.settings,
      { model: options.model, messages, tools: specs },
      { onContent: events.onContent, onReasoning: events.onReasoning },
      options.signal,
    );
    events.onTurnText?.(result.content);
    if (!result.toolCalls.length) {
      text = result.content.trim();
      messages.push({ role: "assistant", content: text });
      if (!text && result.finishReason === "length") text = "(The model stopped: its answer was too long for the context.)";
      return { score, changes, text, transcript: messages.slice(transcriptStart) };
    }
    messages.push({ role: "assistant", content: result.content, tool_calls: result.toolCalls });
    const images: string[] = [];
    for (const call of result.toolCalls) {
      if (options.signal?.aborted) throw new DOMException("Stopped", "AbortError");
      events.onToolStart?.(call);
      let outcome: { result: string; error?: boolean; summary?: string; images?: string[] };
      let args: unknown;
      try {
        args = parseArguments(call.function.arguments);
      } catch {
        args = undefined;
      }
      if (args === undefined) {
        outcome = { error: true, result: `Error: the arguments of ${call.function.name} are not valid JSON: ${call.function.arguments.slice(0, 200)}` };
      } else {
        const browserTool = browserTools.find((t) => t.name === call.function.name);
        if (browserTool) {
          try {
            outcome = await browserTool.run(args, score);
          } catch (err) {
            outcome = { error: true, result: `Error: ${(err as Error).message}` };
          }
        } else {
          const run = runTool(tools, call.function.name, args, score);
          outcome = run;
          if (run.score && run.score !== score) {
            score = run.score;
            if (run.summary) changes.push(run.summary);
            events.onDraft?.(score, run.summary ?? call.function.name);
          }
        }
      }
      if (outcome.images?.length) images.push(...outcome.images);
      events.onToolEnd?.(call, outcome);
      messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: outcome.result });
    }
    if (images.length) {
      messages.push({
        role: "user",
        content: [
          { type: "text", text: "Here are the page images you asked for (look_at_page)." },
          ...images.map((url) => ({ type: "image_url" as const, image_url: { url } })),
        ],
      });
    }
  }
  return {
    score,
    changes,
    text: `I stopped after ${maxSteps} steps without finishing. Review what I changed so far, or ask me to continue.`,
    transcript: messages.slice(transcriptStart),
    stoppedAt: "steps",
  };
}

/** The short form of a finished request kept for later turns: the request and the answer. */
export function compactTurn(request: string, answer: string, changes: string[]): ChatMessage[] {
  const done = changes.length ? `\n(Changes made: ${changes.join("; ")})` : "";
  return [
    { role: "user", content: request },
    { role: "assistant", content: `${answer}${done}`.trim() || "(no answer)" },
  ];
}
