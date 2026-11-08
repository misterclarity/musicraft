import { newScore, printBars } from "@musicraft/score-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, type Settings } from "../lib/settings";
import { estimateTokens, fitToContext, runAgent } from "./agent";
import type { ChatMessage } from "./llm";
import { sseBody } from "./testing";

const settings: Settings = { ...DEFAULT_SETTINGS, serverUrl: "https://llm.example.ts.net", apiKey: "outside-key" };

const delta = (d: Record<string, unknown>, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

function toolCall(id: string, name: string, args: unknown) {
  return delta({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
}

/** A fake chat server answering with the given turns in order, recording the requests. */
function mockServer(turns: unknown[][]) {
  const requests: { messages: ChatMessage[]; tools?: unknown[]; model?: string }[] = [];
  const headers: Record<string, string>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://llm.example.ts.net/v1/chat/completions");
      headers.push(init.headers as Record<string, string>);
      requests.push(JSON.parse(init.body as string));
      const turn = turns[requests.length - 1];
      if (!turn) throw new Error("unexpected request");
      return new Response(sseBody(turn), { headers: { "content-type": "text/event-stream" } });
    }),
  );
  return { requests, headers };
}

describe("agent loop", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("runs tools on a draft, feeds errors back and finishes with a summary", async () => {
    const score = newScore({ title: "Test", parts: [{ instrument: "trumpet-bb" }], measures: 2 });
    const server = mockServer([
      [
        delta({ content: "I'll write the bar." }),
        delta({
          tool_calls: [
            { index: 0, id: "a", type: "function", function: { name: "write_bars", arguments: '{"part": "P1", ' } },
          ],
        }),
        delta({ tool_calls: [{ index: 0, function: { arguments: '"music": "bar 1: D5/4 E5/4 F#5/2", "pitch": "written"}' } }] }),
        delta({ tool_calls: [{ index: 1, id: "b", type: "function", function: { name: "write_bars", arguments: '{"part": "P1", "music": "bar 2: C5/4"}' } }] }),
        delta({}, "tool_calls"),
      ],
      [toolCall("c", "write_bars", { part: "P1", music: "bar 2: C5/1" })],
      [delta({ content: "Wrote bars 1 and 2 of the trumpet part." }), delta({}, "stop")],
    ]);
    const drafts: string[] = [];
    const tools: string[] = [];
    const result = await runAgent(
      { settings, model: "test-model.gguf", contextSize: 32768, score, request: "Write a little tune" },
      {
        onDraft: (_s, summary) => drafts.push(summary),
        onToolEnd: (call, outcome) => tools.push(`${call.function.name}:${outcome.error ? "error" : "ok"}`),
      },
    );
    expect(tools).toEqual(["write_bars:ok", "write_bars:error", "write_bars:ok"]);
    expect(drafts).toEqual(["Rewrote bar 1 of P1", "Rewrote bar 2 of P1"]);
    expect(printBars(result.score, 0, 0, 1, "written")).toEqual(["bar 1: D5/4 E5/4 F#5/2", "bar 2: D5/1"]);
    expect(result.text).toBe("Wrote bars 1 and 2 of the trumpet part.");
    expect(result.changes).toHaveLength(2);
    // The original score is untouched: the agent works on a draft.
    expect(printBars(score, 0, 0, 0)).toEqual(["bar 1: R"]);

    expect(server.headers[0]!.Authorization).toBe("Bearer outside-key");
    const first = server.requests[0]!;
    expect(first.model).toBe("test-model.gguf");
    expect(first.messages[0]!.role).toBe("system");
    expect(first.messages[1]!.content).toContain("Score overview:");
    expect(first.messages[1]!.content).toContain("Request: Write a little tune");
    expect((first.tools as unknown[]).length).toBeGreaterThan(15);
    const second = server.requests[1]!.messages;
    const toolMessages = second.filter((m) => m.role === "tool");
    expect(toolMessages.map((m) => m.tool_call_id)).toEqual(["a", "b"]);
    expect(toolMessages[1]!.content).toMatch(/^Error: bar 2: the notes add up to 1 beat but 4\/4 needs 4 beats/);
  });

  it("understands tool calls written as text and stops at the step limit", async () => {
    const score = newScore({ title: "Test", parts: [{ instrument: "piano" }], measures: 1 });
    mockServer([
      [delta({ content: '<tool_call>{"name": "get_issues", "arguments": {}}</tool_call>' })],
      [delta({ content: '<tool_call>{"name": "get_issues", "arguments": {}}</tool_call>' })],
    ]);
    const turns: string[] = [];
    const result = await runAgent(
      { settings, model: null, contextSize: null, score, request: "check", maxSteps: 2 },
      { onTurnText: (t) => turns.push(t) },
    );
    expect(turns).toEqual(["", ""]);
    expect(result.stoppedAt).toBe("steps");
    expect(result.changes).toEqual([]);
  });

  it("stops when asked", async () => {
    const score = newScore({ title: "Test", parts: [{ instrument: "piano" }], measures: 1 });
    mockServer([[toolCall("x", "get_issues", {})]]);
    const controller = new AbortController();
    const run = runAgent(
      { settings, model: null, contextSize: null, score, request: "check", signal: controller.signal },
      { onToolEnd: () => controller.abort() },
    );
    await expect(run).rejects.toThrow(/Stopped/);
  });
});

describe("context budget", () => {
  it("shortens old tool results, then drops earlier turns", () => {
    const big = "x".repeat(4000);
    const messages: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "old request " + big },
      { role: "assistant", content: "old answer" },
      { role: "user", content: "new request" },
      { role: "assistant", content: "", tool_calls: [{ id: "1", type: "function", function: { name: "get_bars", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "1", content: big },
      { role: "tool", tool_call_id: "2", content: big },
      { role: "tool", tool_call_id: "3", content: "short" },
    ];
    const before = estimateTokens(messages);
    expect(fitToContext(messages, [], before - 500, 3)).toBe(true);
    expect((messages[5]!.content as string).length).toBeLessThan(300);
    expect(fitToContext(messages, [], 2000, 3)).toBe(true);
    expect(messages[1]!.content).toBe("new request");
    expect(fitToContext(messages, [], 10, 1)).toBe(false);
  });
});
