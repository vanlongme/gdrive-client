/**
 * Deterministic local-only bindings for the wave-2 E2E workerd preview
 * (owned by track A — the isolated runner/setup surface).
 *
 * The committed defaults are public test fixtures: 32 bytes of ascending /
 * descending values, chosen so every developer and CI run shares identical
 * credentials. They are not secrets, must never protect real data, and the
 * developer's .dev.vars is never read to compute them. Operators may still
 * override via the environment:
 *
 *   E2E_SETUP_TOKEN    -> Worker secret SETUP_TOKEN (what specs submit to
 *                         POST /api/v1/setup)
 *   E2E_APP_MASTER_KEY -> Worker secret APP_MASTER_KEY
 *   CF_PERSIST_DIR     -> binding state ROOT; a unique per-run directory is
 *                         created beneath it so every suite run starts from
 *                         fresh state (setup is a one-way singleton — reusing
 *                         a directory would leave setup permanently
 *                         completed). An override root is never deleted or
 *                         reused; the default root is .e2e-state/w2, disjoint
 *                         from the wave-1 .e2e-state preview at
 *                         localhost:8879 and the developer's .wrangler/state.
 */
export const E2E_SETUP_TOKEN =
  process.env.E2E_SETUP_TOKEN ?? "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

export const E2E_APP_MASTER_KEY =
  process.env.E2E_APP_MASTER_KEY ?? "//79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA=";

/**
 * Disposable per-run binding state directory. Playwright evaluates this
 * module once per run in the runner process, so the value is shared between
 * global-setup (migrations) and the webServer env (preview state) for that
 * run and unique across runs — `npx playwright test` can be re-run freely.
 */
export const E2E_PERSIST_DIR = `${process.env.CF_PERSIST_DIR ?? ".e2e-state/w2"}/run-${Date.now()}`;

/** Canonical origin the setup spec submits and pins for the E2E instance. */
export const E2E_ORIGIN = "http://localhost:8877";
