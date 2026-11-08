// A stand-in for gateway.py + llama-server (and the recognition service) for end-to-end tests.
// It speaks the OpenAI chat API with streaming and tool calls, chosen by keywords in the request.
// Usage: node e2e/mock-server.mjs [port]
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? process.env.MOCK_PORT ?? 8790);
const KEY = process.env.MOCK_API_KEY ?? "test-key";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sse(res, chunks) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  let i = 0;
  const next = () => {
    if (i < chunks.length) {
      res.write(`data: ${JSON.stringify(chunks[i++])}\n\n`);
      setTimeout(next, 15);
    } else {
      res.write("data: [DONE]\n\n");
      res.end();
    }
  };
  next();
}

const delta = (d, finish = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

function text(answer) {
  const words = answer.split(/(?<= )/);
  return [delta({ role: "assistant", reasoning_content: "Planning the change." }), ...words.map((w) => delta({ content: w })), delta({}, "stop")];
}

function call(name, args, preface = "") {
  return [
    ...(preface ? [delta({ content: preface })] : []),
    delta({ tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function", function: { name, arguments: "" } }] }),
    delta({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] }),
    delta({}, "tool_calls"),
  ];
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

function respond(body) {
  const messages = body.messages ?? [];
  const last = messages[messages.length - 1];
  const request = (/Request: ([\s\S]*)$/.exec(lastUserText(messages))?.[1] ?? "").toLowerCase();
  if (last?.role === "tool" || (last?.role === "user" && Array.isArray(last.content))) {
    const results = messages.filter((m) => m.role === "tool").map((m) => m.content);
    const failed = results.some((r) => r.startsWith("Error"));
    return text(failed ? "Something went wrong, see the tool result." : "Done. I changed the part as you asked; check the green bars.");
  }
  if (/trumpet in c|c trumpet/.test(request)) return call("change_instrument", { part: "P1", instrument: "trumpet-c" }, "Rewriting it for trumpet in C.");
  if (/octave/.test(request)) return call("shift_octave", { parts: ["P1"], from: 1, to: 2, octaves: -1 });
  if (/original|page/.test(request)) return call("look_at_page", { from: 1, to: 4 });
  if (/broken/.test(request)) return call("write_bars", { part: "P1", music: "bar 1: C5/4" });
  return text("I can transpose, rewrite parts for other instruments, and edit bars. What should I change?");
}

const server = createServer((req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    json(res, 401, { error: { message: "Invalid API key" } });
    return;
  }
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (req.method === "GET" && url.pathname === "/v1/models") {
    json(res, 200, {
      object: "list",
      data: [{ id: "mock-vision-model.gguf", object: "model", owned_by: "llamacpp", meta: { n_ctx_train: 32768 } }],
      models: [{ name: "mock-vision-model.gguf", model: "mock-vision-model.gguf", capabilities: ["completion", "multimodal"] }],
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/props") {
    json(res, 200, { default_generation_settings: { n_ctx: 32768 }, modalities: { vision: true }, build_info: "mock" });
    return;
  }
  if (req.method === "GET" && url.pathname === "/omr/health") {
    json(res, 200, { status: "ok", version: "mock", engine: { name: "mock", available: true, device: "cpu" }, limits: { maxUploadMb: 50, maxPages: 20 } });
    return;
  }
  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      if (process.env.MOCK_LOG) console.log(JSON.stringify(body.messages.map((m) => [m.role, typeof m.content === "string" ? m.content.slice(0, 80) : "[parts]"])));
      sse(res, respond(body));
    });
    return;
  }
  json(res, 404, { error: { message: `Not found: ${url.pathname}` } });
});

server.listen(port, () => console.log(`mock server on http://localhost:${port}`));
