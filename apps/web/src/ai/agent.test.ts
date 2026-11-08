import { getEnsemble, newScore, printBars, writeBars } from "@musicraft/score-core";
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
  afterEach(() => vi.unstubAllGlobals());

  it("shortens old tool results, then drops earlier turns, and reports where the request now is", () => {
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
    expect(fitToContext(messages, [], before - 500, 3)).toEqual({ fits: true, keepFrom: 3 });
    expect((messages[5]!.content as string).length).toBeLessThan(300);
    expect(fitToContext(messages, [], 2000, 3)).toEqual({ fits: true, keepFrom: 1 });
    expect(messages[1]!.content).toBe("new request");
    // Called again with the updated index, it never touches the current request.
    expect(fitToContext(messages, [], 10, 1)).toEqual({ fits: false, keepFrom: 1 });
    expect(messages[1]!.content).toBe("new request");
    expect(messages[2]!.tool_calls?.[0]!.id).toBe("1");
  });

  it("keeps the current request across steps when earlier turns are dropped", async () => {
    const score = newScore({ title: "Test", parts: [{ instrument: "trumpet-bb" }], measures: 2 });
    const history: ChatMessage[] = [];
    for (let i = 0; i < 6; i++) {
      history.push({ role: "user", content: `old request ${i} ${"y".repeat(2500)}` });
      history.push({ role: "assistant", content: `old answer ${i}` });
    }
    const server = mockServer([
      [toolCall("a", "get_bars", { from: 1, to: 2 })],
      [toolCall("b", "get_bars", { from: 1 })],
      [delta({ content: "Done." }), delta({}, "stop")],
    ]);
    const result = await runAgent({ settings, model: null, contextSize: 8192, score, request: "Look at bar 1", history });
    expect(result.text).toBe("Done.");
    for (const request of server.requests) {
      const messages = request.messages;
      expect(messages.some((m) => typeof m.content === "string" && m.content.includes("Request: Look at bar 1"))).toBe(true);
      // Every tool result follows the assistant message that asked for it.
      messages.forEach((m, i) => {
        if (m.role !== "tool") return;
        const asked = messages.slice(0, i).some((x) => x.tool_calls?.some((c) => c.id === m.tool_call_id));
        expect(asked).toBe(true);
      });
    }
    expect(result.transcript[0]!.content).toContain("Request: Look at bar 1");
  });

  it("works with an unknown context size on a five-part score", async () => {
    let score = newScore({ title: "Quintet", parts: getEnsemble("brass-quintet")!.parts, measures: 32 });
    for (let p = 0; p < 5; p++) {
      const bars = Array.from({ length: 32 }, (_, b) => `bar ${b + 1}: C4/8 D4/8 E4/8 F4/8 G4/8 F4/8 E4/8 D4/8`).join("\n");
      score = writeBars(score, p, bars).score;
    }
    mockServer([[toolCall("a", "get_bars", { from: 1, to: 12 })], [delta({ content: "These bars are a scale." }), delta({}, "stop")]]);
    const result = await runAgent({ settings, model: null, contextSize: null, score, request: "What do bars 1-12 contain?" });
    expect(result.text).toBe("These bars are a scale.");
  });

  it("trims and retries when the server says the request exceeds its context", async () => {
    const score = newScore({ title: "Test", parts: [{ instrument: "trumpet-bb" }], measures: 2 });
    const history: ChatMessage[] = [
      { role: "user", content: `old ${"z".repeat(6000)}` },
      { role: "assistant", content: "old answer" },
    ];
    const bodies: { messages: ChatMessage[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        if (bodies.length === 1) {
          return new Response(
            JSON.stringify({ error: { code: 400, message: "the request exceeds the available context size, try increasing it", type: "exceed_context_size_error" } }),
            { status: 400, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(sseBody([delta({ content: "Fine." }), delta({}, "stop")]), { headers: { "content-type": "text/event-stream" } });
      }),
    );
    const result = await runAgent({ settings, model: null, contextSize: null, score, request: "Hello", history });
    expect(result.text).toBe("Fine.");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]!.messages.length).toBeLessThan(bodies[0]!.messages.length);
    expect(bodies[1]!.messages[1]!.content).toContain("Request: Hello");
  });
});
