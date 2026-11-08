import { afterEach, describe, expect, it, vi } from "vitest";
import { detectLlm, joinUrl, llmBaseUrl, modelHasVision, omrBaseUrl, parseModels, parseProps, ServerError, serverFetch } from "./server";
import { DEFAULT_SETTINGS, type Settings } from "./settings";

const settings: Settings = { ...DEFAULT_SETTINGS, serverUrl: "https://host.example.ts.net/", apiKey: "k" };

describe("server urls", () => {
  it("joins paths without double slashes", () => {
    expect(joinUrl("https://a/", "/v1")).toBe("https://a/v1");
    expect(llmBaseUrl(settings)).toBe("https://host.example.ts.net/v1");
    expect(omrBaseUrl(settings)).toBe("https://host.example.ts.net/omr");
  });
});

describe("model detection", () => {
  it("reads llama.cpp's /v1/models including capabilities", () => {
    const models = parseModels({
      object: "list",
      data: [{ id: "qwen3-vl-32b.gguf", owned_by: "llamacpp", meta: { n_ctx_train: 262144 } }],
      models: [{ name: "qwen3-vl-32b.gguf", model: "qwen3-vl-32b.gguf", capabilities: ["completion", "multimodal"] }],
    } as never);
    expect(models).toEqual([{ id: "qwen3-vl-32b.gguf", ownedBy: "llamacpp", contextTrain: 262144, capabilities: ["completion", "multimodal"] }]);
    expect(modelHasVision(models[0])).toBe(true);
    expect(modelHasVision({ id: "x", capabilities: [] })).toBeNull();
  });

  it("reads context size and vision from /props", () => {
    expect(parseProps({ default_generation_settings: { n_ctx: 32768 }, modalities: { vision: true }, build_info: "b7000" })).toEqual({
      contextSize: 32768,
      vision: true,
      buildInfo: "b7000",
    });
    expect(parseProps({})).toEqual({ contextSize: null, vision: null, buildInfo: undefined });
  });
});

describe("requests", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends the API key and detects the model, falling back when /props is missing", async () => {
    const calls: { url: string; auth: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, auth: new Headers(init.headers).get("Authorization") });
        if (url.endsWith("/v1/models")) return new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 });
        return new Response("not found", { status: 404 });
      }),
    );
    const caps = await detectLlm(settings);
    expect(caps.model).toBe("m1");
    expect(caps.propsAvailable).toBe(false);
    expect(caps.contextSize).toBeNull();
    expect(calls[0]).toEqual({ url: "https://host.example.ts.net/v1/models", auth: "Bearer k" });
  });

  it("explains CORS-like network failures and rejected keys", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(serverFetch(settings, "https://host/x")).rejects.toMatchObject({ kind: "network" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Invalid API Key" } }), { status: 401 })));
    const error = await serverFetch(settings, "https://host/x").catch((e: ServerError) => e);
    expect(error).toBeInstanceOf(ServerError);
    expect((error as ServerError).message).toBe("The server rejected the API key: Invalid API Key");
  });

  it("refuses to call anything without a server URL", async () => {
    await expect(serverFetch({ ...settings, serverUrl: "" }, "/x")).rejects.toMatchObject({ kind: "config" });
  });
});
