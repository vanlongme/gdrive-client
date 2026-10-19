import { defineConfig } from "@playwright/test";
import {
  E2E_APP_MASTER_KEY,
  E2E_PERSIST_DIR,
  E2E_SETUP_TOKEN,
} from "./tests/e2e/e2e-env";

/**
 * Wave-2 E2E surface: an isolated workerd preview backed by deterministic
 * local-only secrets from tests/e2e/e2e-env.ts (E2E_SETUP_TOKEN /
 * E2E_APP_MASTER_KEY env overrides allowed; the committed defaults are public
 * test fixtures, never developer or production secrets). Secret provenance
 * note: `vite build` itself reads the developer's .dev.vars and emits it as
 * dist/drive_worker/.dev.vars for preview — the e2e command deletes that
 * emitted copy before preview starts, so the served secrets come only from
 * the webServer env below (wrangler falls back to process env for declared
 * secrets once .dev.vars is absent). The source .dev.vars file is never
 * opened by the suite nor modified.
 *
 * CF_PERSIST_DIR redirects all binding state into a fresh per-run directory
 * under .e2e-state/w2 — disjoint from the wave-1 .e2e-state preview at
 * localhost:8879, the developer's .wrangler/state, and prior suite runs, so
 * the suite is repeatable (setup is a one-way singleton).
 *
 * workers: 1 serializes the suite: setup claims a singleton and
 * setup-dependent specs must not race each other.
 *
 * Browser matrix (T15, wave-5 decision 5): the default projects are
 * Chromium (the branded `chrome` channel, as before) and Firefox — both
 * installed locally under ~/.cache/ms-playwright. A WebKit project exists
 * for the mandatory browser matrix but is gated behind E2E_WEBKIT=1 because
 * the local machine lacks WebKit's OS packages; CI enables it explicitly.
 * Run a single browser with `--project=<name>`; run WebKit locally (after
 * installing its deps) with `E2E_WEBKIT=1 npx playwright test`.
 */
export default defineConfig({
  testDir: "./tests/e2e",
  // The fake-Google journey and My Drive specs run against their own
  // Miniflare server on :8878 through playwright.journey.config.ts, never
  // against this :8877 preview.
  testIgnore: /(journey|my-drive|public-link)\.spec\.ts$/,
  timeout: 30_000,
  fullyParallel: true,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:8877",
  },
  projects: [
    {
      name: "chromium",
      use: { channel: "chrome" },
    },
    {
      name: "firefox",
      use: { browserName: "firefox" },
    },
    ...(process.env.E2E_WEBKIT === "1"
      ? [{ name: "webkit", use: { browserName: "webkit" as const } }]
      : []),
  ],
  globalSetup: "./tests/e2e/global-setup.ts",
  webServer: {
    command:
      "npm run build && node -e \"fs.rmSync('dist/drive_worker/.dev.vars', { force: true })\" && npm run preview -- --port 8877 --strictPort",
    url: "http://localhost:8877/api/v1/health",
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      CF_PERSIST_DIR: E2E_PERSIST_DIR,
      SETUP_TOKEN: E2E_SETUP_TOKEN,
      APP_MASTER_KEY: E2E_APP_MASTER_KEY,
    },
  },
});
