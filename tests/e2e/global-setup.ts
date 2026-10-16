import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { E2E_PERSIST_DIR } from "./e2e-env";

/**
 * Applies the checked-in migrations to the test-only D1 database that
 * `vite preview` serves from CF_PERSIST_DIR, so e2e coverage exercises the
 * real schema. The developer's `.wrangler/state` is never touched, and no
 * synthetic setup state is seeded — specs drive the real setup flow with
 * E2E_SETUP_TOKEN.
 *
 * The effective per-run persist dir is also written to a marker file. Spec
 * workers load e2e-env in a different process than the runner, so their own
 * E2E_PERSIST_DIR evaluation would resolve to a different timestamp — the
 * marker is the only honest way for a spec to seed rows into the same
 * database the preview is serving (wave-3 mount/grant tests).
 */
export default function globalSetup(): void {
  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "--persist-to",
      E2E_PERSIST_DIR,
    ],
    { stdio: "inherit" },
  );
  const marker = ".e2e-state/current-persist-dir";
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, E2E_PERSIST_DIR, "utf8");
}
