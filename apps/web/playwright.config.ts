import { defineConfig, devices } from "@playwright/test";

const CI = !!process.env.CI;

/**
 * End-to-end tests of the built app (run `npm run build` first) against e2e/mock-server.mjs, which
 * stands in for gateway.py with llama-server and the recognition service behind it.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  reporter: CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: "http://localhost:4173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } }],
  webServer: [
    { command: "npx vite preview --port 4173 --strictPort", url: "http://localhost:4173", reuseExistingServer: !CI },
    { command: "node e2e/mock-server.mjs 8790", url: "http://localhost:8790/test-page.png", reuseExistingServer: !CI },
  ],
});
