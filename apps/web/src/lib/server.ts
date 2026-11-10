import type { Settings } from "./settings";

export type ServerErrorKind = "network" | "http" | "timeout" | "parse" | "config";

/** An error talking to your server, with a message written for the user. */
export class ServerError extends Error {
  readonly kind: ServerErrorKind;
  readonly status?: number;
  readonly url: string;

  constructor(kind: ServerErrorKind, message: string, url: string, status?: number) {
    super(message);
    this.name = "ServerError";
    this.kind = kind;
    this.url = url;
    this.status = status;
  }
}

export function joinUrl(base: string, path: string): string {
  const b = base.trim().replace(/\/+$/, "");
  const p = path.trim();
  if (!p) return b;
  return `${b}/${p.replace(/^\/+/, "")}`;
}

export function serverRoot(settings: Settings): string {
  return settings.serverUrl.trim().replace(/\/+$/, "");
}

export function llmBaseUrl(settings: Settings): string {
  return joinUrl(serverRoot(settings), settings.llmPath || "/v1");
}

export function omrBaseUrl(settings: Settings): string {
  return joinUrl(serverRoot(settings), settings.omrPath || "/omr");
}

export function authHeaders(settings: Settings): Record<string, string> {
  return settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {};
}

export interface RequestOptions {
  method?: string;
  body?: BodyInit | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** fetch() with the API key, a timeout and errors that explain what to check. */
export async function serverFetch(
  settings: Settings,
  url: string,
  options: RequestOptions = {},
): Promise<Response> {
  if (!serverRoot(settings)) {
    throw new ServerError("config", "No server URL is set. Open Settings and enter your server's address.", url);
  }
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 20_000;
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort("timeout"), timeoutMs) : null;
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", onAbort);
  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? "GET",
      body: options.body,
      headers: { ...authHeaders(settings), ...options.headers },
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted && controller.signal.reason === "timeout") {
      throw new ServerError("timeout", `The server did not answer within ${Math.round(timeoutMs / 1000)} s.`, url);
    }
    if (options.signal?.aborted) throw err;
    throw new ServerError(
      "network",
      "Couldn't reach the server. Check the URL and that the server is running. If it works with curl " +
        "but not here, the gateway is probably not allowing this app's origin (CORS) — see docs/SERVER_SETUP.md.",
      url,
    );
  } finally {
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) {
    throw new ServerError("http", await describeHttpError(response), url, response.status);
  }
  return response;
}

async function describeHttpError(response: Response): Promise<string> {
  let detail = "";
  try {
    const text = await response.text();
    try {
      const json = JSON.parse(text) as { error?: { message?: string } | string; detail?: unknown };
      if (typeof json.error === "string") detail = json.error;
      else if (json.error?.message) detail = json.error.message;
      else if (typeof json.detail === "string") detail = json.detail;
    } catch {
      detail = text.slice(0, 200);
    }
  } catch {
    // ignore body read errors
  }
  const prefix =
    response.status === 401 || response.status === 403
      ? "The server rejected the API key"
      : response.status === 404
        ? "Not found on the server (check the path in Settings)"
        : response.status === 413
          ? "The upload is too large for the server"
          : response.status === 429
            ? "The server is busy"
            : `The server answered ${response.status}`;
  return detail ? `${prefix}: ${detail}` : `${prefix}.`;
}

export async function serverJson<T>(settings: Settings, url: string, options: RequestOptions = {}): Promise<T> {
  const response = await serverFetch(settings, url, options);
  try {
    return (await response.json()) as T;
  } catch {
    throw new ServerError("parse", "The server's answer was not valid JSON.", url, response.status);
  }
}

// ---------------------------------------------------------------------------
// Language model detection
// ---------------------------------------------------------------------------

export interface ModelInfo {
  id: string;
  ownedBy?: string;
  /** Training context of the model (llama.cpp `meta.n_ctx_train`). */
  contextTrain?: number;
  capabilities: string[];
}

export interface LlmCapabilities {
  models: ModelInfo[];
  /** The model the app will use: the override if set, else the first listed model. */
  model: string | null;
  /** Context size in tokens actually configured on the server, when known. */
  contextSize: number | null;
  /** Whether the model accepts images; null when unknown. */
  vision: boolean | null;
  /** Whether `/props` (llama.cpp server properties) was reachable. */
  propsAvailable: boolean;
  buildInfo?: string;
}

interface OpenAiModelsResponse {
  data?: Array<{ id?: string; owned_by?: string; meta?: { n_ctx_train?: number } }>;
  models?: Array<{ name?: string; model?: string; capabilities?: string[] }>;
}

interface LlamaPropsResponse {
  n_ctx?: number;
  default_generation_settings?: { n_ctx?: number };
  modalities?: { vision?: boolean };
  build_info?: string;
  model_path?: string;
}

export function parseModels(json: OpenAiModelsResponse): ModelInfo[] {
  const byId = new Map<string, ModelInfo>();
  for (const entry of json.data ?? []) {
    if (!entry.id) continue;
    byId.set(entry.id, {
      id: entry.id,
      ownedBy: entry.owned_by,
      contextTrain: entry.meta?.n_ctx_train,
      capabilities: [],
    });
  }
  // llama.cpp also returns an Ollama-style "models" list with capabilities.
  for (const entry of json.models ?? []) {
    const id = entry.model ?? entry.name;
    if (!id) continue;
    const existing = byId.get(id) ?? byId.get(entry.name ?? "") ?? { id, capabilities: [] };
    existing.capabilities = Array.from(new Set([...existing.capabilities, ...(entry.capabilities ?? [])]));
    byId.set(existing.id, existing);
  }
  return Array.from(byId.values());
}

export function modelHasVision(model: ModelInfo | undefined): boolean | null {
  if (!model || model.capabilities.length === 0) return null;
  return model.capabilities.some((c) => c === "multimodal" || c === "vision");
}

export function parseProps(json: LlamaPropsResponse): { contextSize: number | null; vision: boolean | null; buildInfo?: string } {
  const contextSize = json.default_generation_settings?.n_ctx ?? json.n_ctx ?? null;
  const vision = typeof json.modalities?.vision === "boolean" ? json.modalities.vision : null;
  return { contextSize, vision, buildInfo: json.build_info };
}

/** Ask the server which model it serves, how much context it has and whether it can see images. */
export async function detectLlm(settings: Settings, signal?: AbortSignal): Promise<LlmCapabilities> {
  const modelsJson = await serverJson<OpenAiModelsResponse>(settings, joinUrl(llmBaseUrl(settings), "/models"), {
    signal,
  });
  const models = parseModels(modelsJson);
  const model = settings.modelOverride.trim() || models[0]?.id || null;
  const selected = models.find((m) => m.id === model);

  let contextSize: number | null = null;
  let vision = modelHasVision(selected);
  let propsAvailable = false;
  let buildInfo: string | undefined;
  // llama.cpp serves /props at the server root; the gateway may or may not forward it.
  for (const url of [joinUrl(serverRoot(settings), "/props"), joinUrl(llmBaseUrl(settings), "/props")]) {
    try {
      const props = parseProps(await serverJson<LlamaPropsResponse>(settings, url, { signal, timeoutMs: 8000 }));
      propsAvailable = true;
      contextSize = props.contextSize;
      vision = props.vision ?? vision;
      buildInfo = props.buildInfo;
      break;
    } catch (err) {
      if (signal?.aborted) throw err;
    }
  }
  return {
    models,
    model,
    contextSize: settings.contextOverride ?? contextSize,
    vision: settings.visionOverride === "auto" ? vision : settings.visionOverride === "on",
    propsAvailable,
    buildInfo,
  };
}

// ---------------------------------------------------------------------------
// Recognition service
// ---------------------------------------------------------------------------

export interface OmrHealth {
  status: string;
  version?: string;
  engine?: OmrEngineInfo;
  /** Another homr installation that can read every page a second time. */
  secondEngine?: OmrEngineInfo | null;
  limits?: { maxUploadMb: number; maxPages: number };
}

export interface OmrEngineInfo {
  name: string;
  version?: string | null;
  available: boolean;
  device?: string;
}

export async function detectOmr(settings: Settings, signal?: AbortSignal): Promise<OmrHealth> {
  return serverJson<OmrHealth>(settings, joinUrl(omrBaseUrl(settings), "/health"), { signal, timeoutMs: 10_000 });
}
