import { defineConfig, devices } from "@playwright/test";

const CI = !!process.env.CI;
/** "/musicraft/" to test a GitHub Pages build (build it with the same BASE_PATH). */
const BASE = process.env.E2E_BASE_PATH ?? "/";
const pages = BASE !== "/";

/**
 * End-to-end tests of the built app (run `npm run build` first) against e2e/mock-server.mjs, which
 * stands in for gateway.py with llama-server and the recognition service behind it. The app is served
 * like Netlify/Vercel serve it (production headers), or like GitHub Pages (sub-path, no headers).
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: CI ? 1 : 0,
  workers: CI ? 2 : undefined,
  reporter: CI ? [["github"], ["list"]] : "list",
  use: {
    baseURL: `http://localhost:4173${BASE}`,
    trace: "on-first-retry",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        // WebGL for the 3D stage, in software where there is no GPU (CI).
        launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] },
      },
    },
  ],
  webServer: [
    {
      command: `node e2e/static-server.mjs --port 4173 --base ${BASE}${pages ? " --no-headers" : ""}`,
      url: `http://localhost:4173${BASE}`,
      reuseExistingServer: !CI,
    },
    { command: "node e2e/mock-server.mjs 8790", url: "http://localhost:8790/test-page.png", reuseExistingServer: !CI },
  ],
});
