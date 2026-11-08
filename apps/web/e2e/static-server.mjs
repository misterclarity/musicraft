// Serves the built app the way the hosts do, for end-to-end tests:
//   node e2e/static-server.mjs --port 4173                     like Netlify/Vercel: at /, with the
//                                                              headers from vercel.json
//   node e2e/static-server.mjs --port 4173 --base /musicraft/ --no-headers
//                                                              like GitHub Pages: under the repository
//                                                              name, without custom headers
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const port = Number(option("port", "4173"));
const base = `/${option("base", "/").replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");
const root = fileURLToPath(new URL("../dist/", import.meta.url));
const headers = args.includes("--no-headers")
  ? []
  : JSON.parse(readFileSync(new URL("../../../vercel.json", import.meta.url), "utf8")).headers[0].headers;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".map": "application/json",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
};

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
  for (const h of headers) res.setHeader(h.key, h.value);
  if (!path.startsWith(base)) {
    res.writeHead(path === "/" ? 302 : 404, path === "/" ? { Location: base } : {});
    res.end();
    return;
  }
  let file = normalize(join(root, path.slice(base.length)));
  if (!file.startsWith(root.replace(/[\\/]$/, "") + sep) && file !== root.replace(/[\\/]$/, "")) {
    res.writeHead(403);
    res.end();
    return;
  }
  if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
  if (!existsSync(file)) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}).listen(port, () => console.log(`serving ${root} at http://localhost:${port}${base}${headers.length ? " with production headers" : ""}`));
