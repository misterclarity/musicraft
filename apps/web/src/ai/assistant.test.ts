import { newScore } from "@musicraft/score-core";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/projects", () => ({
  saveScore: vi.fn(async () => {}),
  addVersion: vi.fn(async () => {}),
  getProject: vi.fn(async () => undefined),
  renameProject: vi.fn(async () => {}),
}));

const { useSettings } = await import("../lib/settings");
const { useProject } = await import("../state/project");
const { useAssistant, useLlm } = await import("./assistant");

describe("assistant chat", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("doesn't write into the next project's chat when switching projects stops a request", async () => {
    useSettings.setState({ serverUrl: "https://llm.example.ts.net", apiKey: "key" });
    useProject.setState({ id: "A", score: newScore({ title: "A", parts: [{ instrument: "trumpet-bb" }], measures: 2 }), selection: { eventIds: [] } });
    useLlm.setState({ detect: async () => ({ models: [], model: "m", contextSize: 32768, vision: false, propsAvailable: true }) });
    // The model never answers; the request ends only when it is aborted.
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")))),
    );
    vi.stubGlobal("fetch", fetchMock);

    useAssistant.getState().reset("A");
    const sending = useAssistant.getState().send("Make it louder");
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    useAssistant.getState().reset("B");
    await sending;

    const state = useAssistant.getState();
    expect(state.projectId).toBe("B");
    expect(state.entries).toEqual([]);
    expect(state.history).toEqual([]);
    expect(state.running).toBe(false);
  });
});
