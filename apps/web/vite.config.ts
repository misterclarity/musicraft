import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
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
