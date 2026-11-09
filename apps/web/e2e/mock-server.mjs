// A stand-in for gateway.py + llama-server for end-to-end tests. It speaks the OpenAI chat API with
// streaming and tool calls, chosen by keywords in the request, and answers proofreading requests.
// With MOCK_OMR_URL set it forwards /omr/... to a real recognition service, like gateway.py does.
// Usage: node e2e/mock-server.mjs [port]
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { deflateSync } from "node:zlib";

const port = Number(process.argv[2] ?? process.env.MOCK_PORT ?? 8790);
const KEY = process.env.MOCK_API_KEY ?? "test-key";
const OMR_URL = process.env.MOCK_OMR_URL;
// Without a real recognition service, recognised pages come back as this MusicXML.
const OMR_RESULT = readFileSync(new URL("../../../packages/score-core/test/fixtures/trumpet-part.musicxml", import.meta.url), "utf8");

// ---------------------------------------------------------------------------
// A generated page image (white, with staff lines) for the stand-in recognition service.
// ---------------------------------------------------------------------------

const PAGE = { width: 800, height: 1000, systems: [150, 450] };

function crc32(buf) {
  let c;
  const table = (crc32.table ??= Array.from({ length: 256 }, (_, n) => {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  }));
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** A grayscale PNG of a page with two five-line staves. */
export function pagePng() {
  const { width, height } = PAGE;
  const rows = Buffer.alloc((width + 1) * height, 255);
  for (let y = 0; y < height; y++) rows[y * (width + 1)] = 0;
  for (const top of PAGE.systems) {
    for (let line = 0; line < 5; line++) {
      const y = top + line * 12;
      for (let x = 60; x < width - 60; x++) rows[y * (width + 1) + 1 + x] = 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // grayscale
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const jobs = new Map();
const OMR_KEY = process.env.MOCK_OMR_KEY ?? "internal-test-key";

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
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

/** Proofreading: the first note of the line is an octave off, a dynamic is missing, and a rest bar is a 4-bar rest. */
function proofread(messages) {
  const user = messages[messages.length - 1];
  const parts = Array.isArray(user?.content) ? user.content : [];
  const textPart = parts.find((p) => p.type === "text")?.text ?? "";
  if (!parts.some((p) => p.type === "image_url" && p.image_url.url.startsWith("data:image/"))) return text('{"findings": [], "missing": []}');
  const lines = textPart.split("\n");
  const answer = { findings: [], missing: [] };
  const line = lines.find((l) => /^bar \S+( staff 1)?: /.test(l) && /[A-G]/.test(l.split(": ")[1]));
  if (line) {
    const bar = /^bar ([^\s:]+)/.exec(line)[1];
    const fixed = line.replace(/([A-G](?:#|b|x|bb)?)(\d)/, (_m, note, octave) => `${note}${Math.min(8, Number(octave) + 1)}`);
    answer.findings.push({ part: "P1", bar, problem: "The first note is an octave higher in the original.", fix: fixed });
    answer.missing.push({ part: "P1", bar, beat: 1, kind: "dynamic", value: "mf" });
  }
  const rest = lines.find((l) => /^bar [^\s:]+( staff 1)?: R(\(|$)/.test(l));
  if (rest) answer.missing.push({ part: "P1", bar: /^bar ([^\s:]+)/.exec(rest)[1], kind: "multirest", value: 4 });
  return text(JSON.stringify(answer));
}

function respond(body) {
  const messages = body.messages ?? [];
  const system = typeof messages[0]?.content === "string" ? messages[0].content : "";
  if (system.startsWith("You check the work of an optical music recognition program")) return proofread(messages);
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
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  // A page image for tests to upload as a "photo" (no key needed).
  if (url.pathname === "/test-page.png") {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(pagePng());
    return;
  }
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    json(res, 401, { error: { message: "Invalid API key" } });
    return;
  }
  // Under /noprops/… the server behaves like a gateway that doesn't forward /props.
  const noProps = url.pathname.startsWith("/noprops/");
  const path = noProps ? url.pathname.slice("/noprops".length) : url.pathname;
  if (req.method === "GET" && path === "/v1/models") {
    json(res, 200, {
      object: "list",
      data: [{ id: "mock-vision-model.gguf", object: "model", owned_by: "llamacpp", meta: { n_ctx_train: 32768 } }],
      models: [{ name: "mock-vision-model.gguf", model: "mock-vision-model.gguf", capabilities: ["completion", "multimodal"] }],
    });
    return;
  }
  if (req.method === "GET" && path === "/props" && !noProps) {
    json(res, 200, { default_generation_settings: { n_ctx: 32768 }, modalities: { vision: true }, build_info: "mock" });
    return;
  }
  if (OMR_URL && path.startsWith("/omr/")) {
    // Forward to the recognition service with the internal key, as gateway.py does.
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      try {
        const headers = { Authorization: `Bearer ${OMR_KEY}` };
        if (req.headers["content-type"]) headers["Content-Type"] = req.headers["content-type"];
        const upstream = await fetch(OMR_URL + path.slice(4) + url.search, {
          method: req.method,
          headers,
          body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
        });
        res.writeHead(upstream.status, { "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream" });
        res.end(Buffer.from(await upstream.arrayBuffer()));
      } catch (err) {
        json(res, 502, { error: { message: `Recognition service unreachable: ${err.message}` } });
      }
    });
    return;
  }
  // Stand-in recognition service.
  if (req.method === "POST" && path === "/omr/v1/pages/detect") {
    req.resume();
    req.on("end", () => json(res, 200, { corners: null, confidence: 0 }));
    return;
  }
  if (req.method === "POST" && path === "/omr/v1/omr/jobs") {
    req.resume();
    req.on("end", () => {
      const id = `job${jobs.size + 1}`;
      jobs.set(id, { created: Date.now() });
      json(res, 202, { id, status: "queued", progress: { done: 0, total: 1, stage: "queued" }, error: null, pages: [] });
    });
    return;
  }
  const job = /^\/omr\/v1\/omr\/jobs\/([\w-]+)(\/pages\/(\d+)\/image)?$/.exec(path);
  if (job && jobs.has(job[1])) {
    if (req.method === "DELETE") {
      jobs.delete(job[1]);
      res.writeHead(204);
      res.end();
      return;
    }
    if (job[2]) {
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(pagePng());
      return;
    }
    const done = Date.now() - jobs.get(job[1]).created > 600;
    const staffs = PAGE.systems.map((top) => ({ x: 60 / PAGE.width, y: top / PAGE.height, width: (PAGE.width - 120) / PAGE.width, height: 48 / PAGE.height }));
    json(res, 200, {
      id: job[1],
      status: done ? "done" : "running",
      progress: { done: done ? 1 : 0, total: 1, stage: done ? "done" : "recognising" },
      error: null,
      pages: [{ index: 0, status: done ? "done" : "pending", width: PAGE.width, height: PAGE.height, staffs: done ? staffs : [], error: null, ...(done ? { musicxml: OMR_RESULT } : {}) }],
    });
    return;
  }
  if (req.method === "GET" && path === "/omr/health") {
    json(res, 200, { status: "ok", version: "mock", engine: { name: "mock", available: true, device: "cpu" }, limits: { maxUploadMb: 50, maxPages: 20 } });
    return;
  }
  if (req.method === "POST" && path === "/v1/chat/completions") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      if (process.env.MOCK_LOG) console.log(JSON.stringify(body.messages.map((m) => [m.role, typeof m.content === "string" ? m.content.slice(0, 80) : "[parts]"])));
      sse(res, respond(body));
    });
    return;
  }
  json(res, 404, { error: { message: `Not found: ${path}` } });
});

server.listen(port, () => console.log(`mock server on http://localhost:${port}`));
