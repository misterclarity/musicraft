/**
 * Streaming client for an OpenAI-compatible chat API (llama.cpp's llama-server behind gateway.py).
 * Handles tool-call deltas, reasoning (`reasoning_content` or <think> tags) and models that write
 * tool calls into the text instead of the tool_calls field.
 */
import { joinUrl, llmBaseUrl, ServerError, serverFetch } from "../lib/server";
import type { Settings } from "../lib/settings";

export type ContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string | null;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** Extra body fields (temperature, response_format …). */
  extra?: Record<string, unknown>;
}

export interface StreamHandlers {
  onContent?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  /** A tool call started arriving (name known). */
  onToolCall?: (index: number, name: string) => void;
}

export interface CompletionResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface Delta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: Array<{ index?: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
}

interface Chunk {
  choices?: Array<{ delta?: Delta; message?: Delta; finish_reason?: string | null }>;
  usage?: CompletionResult["usage"];
  error?: { message?: string } | string;
}

let callCounter = 0;
export const newCallId = () => `call_${Date.now().toString(36)}_${(callCounter++).toString(36)}`;

/** Splits <think>…</think> out of streamed text, even when the tags arrive in pieces. */
export class ThinkSplitter {
  private inThink = false;
  private pending = "";

  constructor(
    private readonly onText: (s: string) => void,
    private readonly onThink: (s: string) => void,
  ) {}

  push(text: string) {
    let s = this.pending + text;
    this.pending = "";
    while (s.length) {
      const tag = this.inThink ? "</think>" : "<think>";
      const at = s.indexOf(tag);
      if (at >= 0) {
        this.emit(s.slice(0, at));
        this.inThink = !this.inThink;
        s = s.slice(at + tag.length);
        continue;
      }
      // Keep a possible partial tag at the end for the next chunk.
      let keep = 0;
      for (let k = Math.min(tag.length - 1, s.length); k > 0; k--) {
        if (tag.startsWith(s.slice(s.length - k))) {
          keep = k;
          break;
        }
      }
      this.emit(s.slice(0, s.length - keep));
      this.pending = s.slice(s.length - keep);
      break;
    }
  }

  flush() {
    if (this.pending) this.emit(this.pending);
    this.pending = "";
  }

  private emit(s: string) {
    if (!s) return;
    if (this.inThink) this.onThink(s);
    else this.onText(s);
  }
}

function errorText(error: Chunk["error"]): string {
  return typeof error === "string" ? error : (error?.message ?? "unknown error");
}

/** Read an SSE stream of chat-completion chunks. */
export async function readCompletionStream(body: ReadableStream<Uint8Array>, handlers: StreamHandlers = {}): Promise<CompletionResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let usage: CompletionResult["usage"];
  const calls: { id?: string; name: string; args: string }[] = [];
  const splitter = new ThinkSplitter(
    (s) => {
      content += s;
      handlers.onContent?.(s);
    },
    (s) => {
      reasoning += s;
      handlers.onReasoning?.(s);
    },
  );

  const handle = (data: string) => {
    if (data === "[DONE]") return true;
    let chunk: Chunk;
    try {
      chunk = JSON.parse(data) as Chunk;
    } catch {
      return false;
    }
    if (chunk.error) throw new ServerError("http", `The model server reported an error: ${errorText(chunk.error)}`, "");
    if (chunk.usage) usage = chunk.usage;
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta ?? choice.message ?? {};
      const think = delta.reasoning_content ?? delta.reasoning;
      if (think) {
        reasoning += think;
        handlers.onReasoning?.(think);
      }
      if (delta.content) splitter.push(delta.content);
      for (const tc of delta.tool_calls ?? []) {
        const index = tc.index ?? calls.length;
        let call = calls[index];
        if (!call) {
          call = calls[index] = { name: "", args: "" };
        }
        if (tc.id) call.id = tc.id;
        if (tc.function?.name) {
          const first = !call.name;
          call.name += tc.function.name;
          if (first) handlers.onToolCall?.(index, call.name);
        }
        if (tc.function?.arguments) call.args += tc.function.arguments;
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    return false;
  };

  let done = false;
  while (!done) {
    const { value, done: end } = await reader.read();
    if (end) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (!line.startsWith("data:")) continue;
      if (handle(line.slice(5).trim())) {
        done = true;
        break;
      }
    }
  }
  if (!done && buffer.startsWith("data:")) handle(buffer.slice(5).trim());
  reader.cancel().catch(() => {});
  splitter.flush();
  const toolCalls = calls.filter(Boolean).map((c) => ({ id: c.id || newCallId(), type: "function" as const, function: { name: c.name, arguments: c.args } }));
  return { content, reasoning, toolCalls, finishReason, usage };
}

/** Tool calls that a model wrote as text (when the server's chat template didn't parse them). */
export function extractTextToolCalls(content: string): { calls: ToolCall[]; rest: string } {
  const calls: ToolCall[] = [];
  let rest = content;
  const push = (name: unknown, args: unknown) => {
    if (typeof name !== "string" || !name) return;
    calls.push({ id: newCallId(), type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}) } });
  };
  const fromObject = (obj: unknown) => {
    if (Array.isArray(obj)) return obj.forEach(fromObject);
    if (obj && typeof obj === "object") {
      const o = obj as Record<string, unknown>;
      const fn = (o.function ?? o) as Record<string, unknown>;
      push(fn.name, fn.arguments ?? fn.parameters ?? o.arguments ?? o.parameters);
    }
  };
  const tryJson = (text: string): unknown => {
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  // Hermes / Qwen: <tool_call>{"name": …, "arguments": …}</tool_call>
  rest = rest.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (whole, json: string) => {
    const obj = tryJson(json.replace(/^```(?:json)?|```$/g, "").trim());
    if (obj === undefined) return whole;
    fromObject(obj);
    return "";
  });
  // <function=name>{…}</function>
  rest = rest.replace(/<function=([\w.-]+)>\s*([\s\S]*?)\s*<\/function>/g, (whole, name: string, json: string) => {
    const obj = tryJson(json);
    if (obj === undefined) return whole;
    push(name, obj);
    return "";
  });
  // Mistral: [TOOL_CALLS][{…}] or [TOOL_CALLS]name[ARGS]{…}
  const mistral = /\[TOOL_CALLS\]\s*(\[[\s\S]*\])\s*$/.exec(rest);
  if (mistral) {
    const obj = tryJson(mistral[1]!);
    if (obj !== undefined) {
      fromObject(obj);
      rest = rest.slice(0, mistral.index);
    }
  }
  rest = rest.replace(/\[TOOL_CALLS\]\s*([\w.-]+)\s*\[ARGS\]\s*(\{[\s\S]*?\})(?=\s*(?:\[TOOL_CALLS\]|$))/g, (whole, name: string, json: string) => {
    const obj = tryJson(json);
    if (obj === undefined) return whole;
    push(name, obj);
    return "";
  });
  // Llama 3.1: <|python_tag|>{…}
  rest = rest.replace(/<\|python_tag\|>\s*(\{[\s\S]*\})\s*$/, (whole, json: string) => {
    const obj = tryJson(json);
    if (obj === undefined) return whole;
    fromObject(obj);
    return "";
  });
  // The whole reply is a JSON object (optionally fenced) with a name and arguments.
  if (!calls.length) {
    const fenced = /^\s*(?:```(?:json)?\s*)?(\{[\s\S]*\}|\[[\s\S]*\])\s*(?:```)?\s*$/.exec(rest);
    if (fenced) {
      const obj = tryJson(fenced[1]!);
      const looksLikeCall = (o: unknown) => !!o && typeof o === "object" && "name" in (o as object) && ("arguments" in (o as object) || "parameters" in (o as object));
      if (Array.isArray(obj) ? obj.every(looksLikeCall) : looksLikeCall(obj)) {
        fromObject(obj);
        rest = "";
      }
    }
  }
  return { calls, rest: rest.trim() };
}

/** Parse tool-call arguments leniently (code fences, trailing commas, empty string). */
export function parseArguments(text: string): unknown {
  const t = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  if (!t) return {};
  try {
    return JSON.parse(t);
  } catch {
    const repaired = t.replace(/,\s*([}\]])/g, "$1");
    return JSON.parse(repaired);
  }
}

/** Send a chat request and stream the answer. */
export async function streamChat(settings: Settings, request: ChatRequest, handlers: StreamHandlers = {}, signal?: AbortSignal): Promise<CompletionResult> {
  const url = joinUrl(llmBaseUrl(settings), "/chat/completions");
  const body: Record<string, unknown> = {
    messages: request.messages,
    stream: true,
    stream_options: { include_usage: true },
    ...request.extra,
  };
  if (request.model) body.model = request.model;
  if (request.tools?.length) {
    body.tools = request.tools;
    body.tool_choice = "auto";
  }
  let response: Response;
  try {
    response = await serverFetch(settings, url, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      signal,
      timeoutMs: 0,
    });
  } catch (err) {
    if (err instanceof ServerError && err.kind === "http" && /tool|jinja|template/i.test(err.message)) {
      throw new ServerError(
        "http",
        `${err.message} — the server could not use tools with this model. Start llama-server with --jinja and a chat template that supports tool calling.`,
        url,
        err.status,
      );
    }
    throw err;
  }
  const type = response.headers.get("content-type") ?? "";
  let result: CompletionResult;
  if (type.includes("application/json") || !response.body) {
    // A server that ignored stream: true.
    const json = (await response.json()) as Chunk;
    if (json.error) throw new ServerError("http", `The model server reported an error: ${errorText(json.error)}`, url);
    const message = json.choices?.[0]?.message ?? {};
    let content = "";
    let reasoning = message.reasoning_content ?? "";
    new ThinkSplitter(
      (s) => (content += s),
      (s) => (reasoning += s),
    ).push(message.content ?? "");
    if (content) handlers.onContent?.(content);
    result = {
      content,
      reasoning,
      toolCalls: (message.tool_calls ?? []).map((tc) => ({ id: tc.id || newCallId(), type: "function", function: { name: tc.function?.name ?? "", arguments: tc.function?.arguments ?? "" } })),
      finishReason: json.choices?.[0]?.finish_reason ?? null,
      usage: json.usage,
    };
  } else {
    result = await readCompletionStream(response.body, handlers);
  }
  if (!result.toolCalls.length && request.tools?.length) {
    const { calls, rest } = extractTextToolCalls(result.content);
    if (calls.length) result = { ...result, toolCalls: calls, content: rest };
  }
  return result;
}
