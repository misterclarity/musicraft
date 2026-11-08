import { describe, expect, it } from "vitest";
import { extractTextToolCalls, parseArguments, readCompletionStream, ThinkSplitter } from "./llm";
import { sseBody } from "./testing";

const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

describe("streaming", () => {
  it("collects text, reasoning and tool calls split over many chunks", async () => {
    const seen: string[] = [];
    const result = await readCompletionStream(
      sseBody([
        delta({ role: "assistant", reasoning_content: "Let me " }),
        delta({ reasoning_content: "think." }),
        delta({ content: "Moving " }),
        delta({ content: "it." }),
        delta({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "shift_octave", arguments: "" } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '{"octa' } }] }),
        delta({ tool_calls: [{ index: 0, function: { arguments: 'ves": -1}' } }] }),
        delta({ tool_calls: [{ index: 1, id: "call_2", function: { name: "get_issues", arguments: "{}" } }] }),
        delta({}, "tool_calls"),
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
      ]),
      { onToolCall: (_i, name) => seen.push(name) },
    );
    expect(result.reasoning).toBe("Let me think.");
    expect(result.content).toBe("Moving it.");
    expect(result.toolCalls).toEqual([
      { id: "call_1", type: "function", function: { name: "shift_octave", arguments: '{"octaves": -1}' } },
      { id: "call_2", type: "function", function: { name: "get_issues", arguments: "{}" } },
    ]);
    expect(seen).toEqual(["shift_octave", "get_issues"]);
    expect(result.finishReason).toBe("tool_calls");
    expect(result.usage).toEqual({ prompt_tokens: 100, completion_tokens: 20 });
  });

  it("moves <think> blocks out of the text even when tags are split", () => {
    let text = "";
    let think = "";
    const splitter = new ThinkSplitter(
      (s) => (text += s),
      (s) => (think += s),
    );
    for (const piece of ["<thi", "nk>plan", " it</th", "ink>\n\nAnswer", " <", "b>ok"]) splitter.push(piece);
    splitter.flush();
    expect(think).toBe("plan it");
    expect(text).toBe("\n\nAnswer <b>ok");
  });

  it("reports errors sent inside the stream", async () => {
    await expect(readCompletionStream(sseBody([{ error: { message: "context overflow" } }]))).rejects.toThrow(/context overflow/);
  });
});

describe("tool calls written as text", () => {
  it("reads Hermes/Qwen, Mistral, Llama and bare JSON styles", () => {
    const hermes = extractTextToolCalls('Sure.\n<tool_call>\n{"name": "transpose", "arguments": {"interval": "M2"}}\n</tool_call>');
    expect(hermes.calls.map((c) => [c.function.name, JSON.parse(c.function.arguments)])).toEqual([["transpose", { interval: "M2" }]]);
    expect(hermes.rest).toBe("Sure.");
    const mistral = extractTextToolCalls('[TOOL_CALLS][{"name": "get_bars", "arguments": {"from": 1}}]');
    expect(mistral.calls[0]!.function.name).toBe("get_bars");
    const mistralNew = extractTextToolCalls('[TOOL_CALLS]get_bars[ARGS]{"from": 3}');
    expect(JSON.parse(mistralNew.calls[0]!.function.arguments)).toEqual({ from: 3 });
    const llama = extractTextToolCalls('<|python_tag|>{"name": "get_issues", "parameters": {}}');
    expect(llama.calls[0]!.function.name).toBe("get_issues");
    const fenced = extractTextToolCalls('```json\n{"name": "shift_octave", "arguments": {"octaves": 1}}\n```');
    expect(fenced.calls[0]!.function.name).toBe("shift_octave");
    expect(extractTextToolCalls("Just an answer with {braces}.").calls).toEqual([]);
  });

  it("parses arguments leniently", () => {
    expect(parseArguments("")).toEqual({});
    expect(parseArguments('```json\n{"a": 1,}\n```')).toEqual({ a: 1 });
    expect(() => parseArguments("{oops")).toThrow();
  });
});
