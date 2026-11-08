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
import { ServerError } from "../lib/server";
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
  /** Context window in tokens (null: unknown; DEFAULT_CONTEXT is assumed). */
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

/**
 * Context assumed when the server doesn't report it (gateway.py doesn't forward /props and nothing is
 * set in Settings). The tool definitions alone take about 3–4k tokens, so 8k would be too tight; if
 * the server's context is smaller, its "exceeds the context" error makes the agent trim and retry.
 */
export const DEFAULT_CONTEXT = 16384;
const IMAGE_TOKENS = 1100;

export function estimateTokens(messages: ChatMessage[], tools: ToolSpec[] = []): number {
  const toolChars = JSON.stringify(tools).length;
  let chars = 0;
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
  // English and JSON (the tool definitions) average about 4 characters per token; music notation and
  // short tool results are denser, so messages count about 3.5.
  return Math.ceil(toolChars / 4 + chars / 3.5) + images * IMAGE_TOKENS;
}

export interface FitResult {
  fits: boolean;
  /** Where the current request starts now (earlier turns may have been dropped). */
  keepFrom: number;
}

/**
 * Shrink the conversation to fit the context: first old tool results, then old images, then the
 * oldest earlier turns. `keepFrom` is the index of the current request; everything from there on is
 * kept. Returns whether it fits, and the request's index afterwards.
 */
export function fitToContext(messages: ChatMessage[], tools: ToolSpec[], budget: number, keepFrom: number): FitResult {
  if (estimateTokens(messages, tools) <= budget) return { fits: true, keepFrom };
  const toolIndexes = messages.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  for (const i of toolIndexes.slice(0, -2)) {
    const m = messages[i]!;
    if (typeof m.content === "string" && m.content.length > 200) {
      m.content = `${m.content.slice(0, 120)}… [shortened to save space; call the tool again if you need it]`;
      if (estimateTokens(messages, tools) <= budget) return { fits: true, keepFrom };
    }
  }
  for (let i = 0; i < messages.length - 1; i++) {
    const m = messages[i]!;
    if (Array.isArray(m.content) && m.content.some((p) => p.type === "image_url")) {
      m.content = m.content.map((p) => (p.type === "image_url" ? { type: "text" as const, text: "[image removed to save space]" } : p));
      if (estimateTokens(messages, tools) <= budget) return { fits: true, keepFrom };
    }
  }
  // Drop earlier chat turns (after the system prompt, before this request), a request and its answer
  // at a time: some chat templates insist that user and assistant messages alternate.
  while (keepFrom > 1 && estimateTokens(messages, tools) > budget) {
    const count = Math.min(2, keepFrom - 1);
    messages.splice(1, count);
    keepFrom -= count;
  }
  return { fits: estimateTokens(messages, tools) <= budget, keepFrom };
}

export class AgentError extends Error {}

/** llama-server's (and other servers') answer when a request is longer than the context. */
export function isContextOverflow(error: unknown): boolean {
  return (
    error instanceof ServerError &&
    error.kind === "http" &&
    /context|too (long|large)|exceed|n_ctx|prompt is too/i.test(error.message)
  );
}

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
  // Index of the current request; it moves down when earlier turns are dropped to save space.
  let requestIndex = 1 + history.length;
  const contextSize = options.contextSize ?? DEFAULT_CONTEXT;
  let budget = Math.floor(contextSize * 0.9) - Math.min(4096, Math.floor(contextSize * 0.2));
  const maxSteps = options.maxSteps ?? 24;
  const tooLong = () =>
    new AgentError(
      `The conversation no longer fits the model's context (${options.contextSize ? `${contextSize} tokens` : "the server didn't report its size"}). ` +
        "Start a new chat, ask about fewer bars at a time, or set the context size in Settings.",
    );
  const fit = () => {
    const result = fitToContext(messages, specs, budget, requestIndex);
    requestIndex = result.keepFrom;
    if (!result.fits) throw tooLong();
  };

  let score = options.score;
  const changes: string[] = [];
  let text = "";

  for (let step = 1; step <= maxSteps; step++) {
    if (options.signal?.aborted) throw new DOMException("Stopped", "AbortError");
    fit();
    events.onStep?.(step);
    let result: CompletionResult | undefined;
    for (let attempt = 0; !result; attempt++) {
      try {
        result = await streamChat(
          options.settings,
          { model: options.model, messages, tools: specs },
          { onContent: events.onContent, onReasoning: events.onReasoning },
          options.signal,
        );
      } catch (error) {
        // The server's context is smaller than assumed: trim harder and try again.
        if (attempt >= 2 || !isContextOverflow(error)) throw error;
        budget = Math.floor(Math.min(budget, estimateTokens(messages, specs)) * 0.75);
        fit();
      }
    }
    events.onTurnText?.(result.content);
    if (!result.toolCalls.length) {
      text = result.content.trim();
      messages.push({ role: "assistant", content: text });
      if (!text && result.finishReason === "length") text = "(The model stopped: its answer was too long for the context.)";
      return { score, changes, text, transcript: messages.slice(requestIndex) };
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
    transcript: messages.slice(requestIndex),
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
