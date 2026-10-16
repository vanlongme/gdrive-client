# Release checklist

Status: **DRAFT — not release-ready.** This checklist mirrors plan task T16
of the project plan (kept outside this public repository). Every external
gate below is `awaiting-external` until its required input/authorization
exists and the listed evidence is recorded by the maintainer. A first CLI
deployment to Cloudflare exists (2026-10-17, health/setup smoke checks only);
no gate below is passed by that alone, and nothing has been tested against
real Google — do not mark a gate passed on the strength of local or mocked
results.

## 1. Local packaging gates (runnable now)

All commands assume repo root and Node 24
(`export PATH=$HOME/.local/node24/bin:$PATH`).

| Gate | Command | Verified |
| --- | --- | --- |
| Clean install | `npm ci` (engine-strict, lockfile) | script exists in `package.json` |
| Typecheck | `npm run check` (`tsc -b`: web + worker + tests + configs) | script exists |
| Tests | `npm test` (vitest in workerd) | script exists |
| Build | `npm run build` → `dist/` | script exists |
| E2E | `npm run test:e2e` (Playwright `chromium` + `firefox` projects, isolated `.e2e-state`, serialized `workers: 1`) | script exists; wave-5 local pass 146/146 (orchestration-wave-5 (internal record)) |
| Fake-Google journey | `npm run test:e2e:journey` (build + `playwright.journey.config.ts`: browser → built worker in Miniflare → in-process fake Google on :8878) | script exists; wave-5 local pass 2/2 — **fixture, not live-Google evidence** (T15-journey (internal record)) |
| Deploy dry-run | `npm run deploy:dry-run` (build + strip-dev-vars + `wrangler deploy --dry-run --outdir .wrangler/dry-run`) | wave-6 local pass — dry-run compiled and checked the production bundle (10 modules, 786.88 KiB; 71 assets; upload 2166.36 KiB). **A dry-run is not a deployment** — G1 stays `awaiting-external` (T16-packaging (internal record)) |
| Bundle scan | `npm run check:bundle` (`scripts/release/check-bundle.ts`: secret/source-map scan of `dist/` + required-asset check) | wave-6 local pass — production `dist/` clean (83 files; `_headers`, pdf/hash/hls outputs present). In a dev checkout with `.dev.vars` the emitted `dist/drive_worker/.dev.vars` fails the scan by design — see [deployment.md](deployment.md) |
| CI workflow | `.github/workflows/ci.yml` — reproduces check/test/build/`check:bundle`/E2E + journey; `e2e-webkit` job is `continue-on-error: true` | runs on GitHub Actions: check/unit/integration/build, Chromium+Firefox E2E and the journey are green; the non-blocking WebKit job currently fails broadly (environment issue under investigation); WebKit never run locally (~91 OS packages not installed) |
| Local migrations | `npm run db:migrations:local` | script exists; wraps `wrangler d1 migrations apply DB --local` |
| Typegen | `npm run cf:typegen` | script exists; wraps `wrangler types` |
| Env sanity | `node scripts/doctor.ts` | `--help` verified; read-only |
| Ops scripts | `node scripts/{backup,restore,rotate-key,admin-recovery}.ts --help` + dry-run | all verified locally; remote mutations refused by the scripts |
| Perf budgets | `node tests/perf/bench-stream.mjs`, `node tests/perf/bench-hash.mjs` | fixture runs through Miniflare (no TCP/TLS, fake providers) — **not live numbers**; results in T15-ci-budgets (internal record), live transfer is gate G3 |
| Wrangler surface | `npx wrangler --version` → 4.147.0; `--help` for `dev`, `deploy`, `d1 create`, `d1 execute`, `d1 export`, `d1 migrations apply`, `secret put` | `--help` output verified locally |
| Secrets hygiene | `.dev.vars.example` blank by design; no real secrets in Git, evidence, `dist/` bundle, source maps or logs | `.dev.vars.example` verified empty; `npm run check:bundle` sweeps `dist/` before any release |

Manual before any release claim:

- [ ] Confirm `public/_headers` is emitted into `dist/` and the SPA CSP
      matches the checked-in file.
- [ ] Confirm no credential material appears in any API response
      (`GET /api/v1/admin/diagnostics` redaction, OAuth/SA view schemas).
- [ ] Docs commands re-checked: every command in the docs is either verified
      by local `--help`/dry-run or explicitly labelled
      "external/remote step requiring authorization".

Recorded design trade-offs (pre-release security review,
W6-R3 (internal record) — release notes must state, not hide, these):

- Share tokens and media tickets are bearer capabilities carried in
  `?share=`/`?ticket=` URL query parameters by design (external players
  cannot set headers); mitigated by `Referrer-Policy: no-referrer`, CSP,
  hash-at-rest storage, required expiry and revocation. Operators must not
  log full query strings at proxies fronting the worker.
- File shares created without a pinned `revisionId` admit current and
  *future* revisions of that file (`shareScopeCovers`,
  `src/worker/security/shares.ts`).

## 2. External gates — all `awaiting-external`

Gate table from the plan (T16). Do not run any of these without the listed
authorization; evidence requirements are per gate.

| Gate | Required input / authorization | Evidence needed to pass |
| --- | --- | --- |
| **G1 Fresh Cloudflare deploy** | Public repo URL, a clean Cloudflare test account, explicit deploy authorization | Button/CLI click-through: D1 + both SQLite DOs provisioned → remote migrations applied → `POST /api/v1/setup` completes; a second deploy onto the same `DB`/consumed state leaves the installation intact |
| **G2 Google lifecycle** | Test OAuth client + callback, a test operator account, a test Shared Drive, a test SA reader, permission to perform test operations | Consent → refresh token sealed → token refresh after access-token expiry; revoke/reconnect on the same principal; OAuth-plane and SA-plane failures shown to be independent |
| **G3 Real transfers** | Test folder, storage and bandwidth budget, permission to create/trash test files | Checksums for 0-byte / 1 GiB / 10 GiB uploads; interrupted final chunk and session expiry recovery; pinned identity checks; completed-but-reader-blocked behaviour |
| **G4 Devices** | Real Safari/iOS and Android Chrome devices | Media seek, file picker, memory/background/reselect behaviour recorded with device/browser versions |
| **G5 Upgrade/rollback** | Authorized staging account/resources and backups | Data and sealed envelopes survive redeploy + migration + rollback; staging fully isolated (separate DB/secrets/OAuth callback) |
| **G6 Publication** | Repository owner, license choice, explicit publish permission | Real repo deploy-button metadata and release notes; proof no credentials exist in history or artifacts; real security contact in `SECURITY.md` |

## 3. Release decision

Release may only be claimed after:

- [ ] Every local gate in §1 passes with recorded commands and outputs.
- [ ] Every applicable G1–G6 gate has recorded evidence.
- [ ] `SECURITY.md` contains a real `<security-contact placeholder>` replacement.
- [ ] The maintainer's implementation status ledger records the outcome
      (this document does not update it).

Until then the status is **local-pass only** — planned and live-passed are
distinct states, and a mock is never live-integration evidence.
