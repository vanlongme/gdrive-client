import { defineConfig } from "@playwright/test";

/**
 * T15 journey surface: the real browser -> built-worker -> fake-Google
 * journey. webServer is tests/e2e/journey-server.ts — Miniflare 5 hosting
 * the BUILT bundle from dist/ on port 8878 (never 8877) with its own
 * persist dir and outboundService routing Google hosts to the in-process
 * fake on control port 8898.
 *
 * Run inside a coordinator-granted E2E/build window: the server requires a
 * fresh `npm run build` beforehand (dist/ is shared). Durable-object and D1
 * state live under .e2e-state/journey/ — never .wrangler/state.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 120_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: { baseURL: "http://localhost:8878" },
  projects: [
    {
      name: "chromium",
      use: { channel: "chrome" },
      testMatch: /(journey|my-drive)\.spec\.ts$/,
    },
    // journey.spec.ts uses fixed names and cannot run twice on one server;
    // my-drive.spec.ts namespaces everything by project name.
    {
      name: "firefox",
      use: { browserName: "firefox" },
      testMatch: /my-drive\.spec\.ts$/,
    },
  ],
  webServer: {
    command: "npx tsx tests/e2e/journey-server.ts",
    url: "http://localhost:8878/api/v1/health",
    timeout: 120_000,
    reuseExistingServer: false,
  },
});
