import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { META_CSP } from "./security";

/**
 * Where the app is served from: "/" on Netlify, Vercel or a custom domain, "/<repository>/" on GitHub
 * Pages (the Pages workflow sets BASE_PATH).
 */
function basePath(): string {
  const raw = process.env.BASE_PATH?.trim() || "/";
  return `/${raw.replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");
}

/** Production builds carry the Content-Security-Policy in a <meta> tag, for hosts that can't send headers. */
function contentSecurityPolicy(): Plugin {
  return {
    name: "musicraft-csp",
    apply: "build",
    transformIndexHtml: () => [{ tag: "meta", attrs: { "http-equiv": "Content-Security-Policy", content: META_CSP }, injectTo: "head-prepend" }],
  };
}

export default defineConfig({
  base: basePath(),
  plugins: [react(), contentSecurityPolicy()],
  worker: {
    format: "es",
  },
  optimizeDeps: {
    // Verovio ships a large WebAssembly module that must not be pre-bundled.
    exclude: ["verovio"],
  },
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 12000,
  },
  server: {
    port: 5173,
  },
});
