# Deployment

How to run Drive Worker locally and how to prepare a Cloudflare deployment.
The project has **no confirmed live deployment** — every `wrangler` command
that touches a real Cloudflare account is marked **external/remote step
requiring authorization** and was verified here only via `--help`. Local
commands were verified against the checked-in code (`wrangler.jsonc`,
`package.json`, `scripts/`).

Prerequisites: Node 24 (`export PATH=$HOME/.local/node24/bin:$PATH`), npm,
deps installed with `npm ci` (engine-strict). Wrangler is a pinned dev
dependency (`wrangler 4.147.0`); invoke it as `npx wrangler`.

## Resources declared by `wrangler.jsonc`

| Resource | Binding | Class / name |
| --- | --- | --- |
| D1 database | `DB` | `drive-worker-db`, `migrations_dir: migrations` |
| Durable Object (SQLite) | `PROJECT_COORDINATOR` | `ProjectCoordinator` |
| Durable Object (SQLite) | `UPLOAD_SESSION` | `UploadSession` |
| Static assets | `ASSETS` | SPA, `run_worker_first` scoped to `/api`, `/api/*` |
| Secrets (required) | — | `APP_MASTER_KEY`, `SETUP_TOKEN` |
| Secret (optional) | — | `APP_MASTER_KEY_NEXT` (rotation window only) |

Migrations (apply in order): `0001_initial.sql`, `0002_auth_setup.sql`,
`0003_oauth_transactions.sql`, `0004_account_credential_uniq.sql`,
`0005_upload_projection_version.sql`, `0006_maintenance.sql`.

## Local development

```sh
cp .dev.vars.example .dev.vars
# Fill BOTH values; each must be canonical base64 of exactly 32 bytes:
openssl rand -base64 32   # run twice — APP_MASTER_KEY and SETUP_TOKEN

npm ci
npm run db:migrations:local   # wrangler d1 migrations apply DB --local
npm run dev                   # Vite + Worker dev server
```

Verified: `openssl rand -base64 32`, `node scripts/doctor.ts` (prints
`ok`/`FAIL` checks), all `npm run` names exist in `package.json`. Run
`node scripts/doctor.ts` after setup — it validates Node ≥24, wrangler
presence, `wrangler.jsonc` parsing, the `DB` binding, sequential migration
names and well-formed secrets.

Initial setup (once, against the running dev server):

```sh
curl -X POST http://localhost:8787/api/v1/setup \
  -H 'content-type: application/json' \
  -d '{"token":"<SETUP_TOKEN base64>","name":"<name>","email":"<admin email>",
       "password":"<password>","canonicalOrigin":"http://localhost:8787"}'
```

`canonicalOrigin` becomes the only trusted mutation origin and the base of
the OAuth redirect URI; in production it must be an `https://` non-loopback
origin. Then sign in via `POST /api/auth/sign-in/email`.

## Provision before deploy *(all external/remote steps requiring authorization)*

The remote D1 database must exist before migrations run; deploying the
Worker provisions the two SQLite Durable Object classes (no separate DO
provisioning command exists). Order matters — create, then secrets, then
migrate, then deploy:

1. Create the database — `npx wrangler d1 create drive-worker-db`
   (verified via `--help`). It prints a `database_id`; add it to the
   `d1_databases` entry in `wrangler.jsonc` (the checked-in file intentionally
   has no `database_id` yet — there is no remote DB).
2. Set secrets — `npx wrangler secret put APP_MASTER_KEY` and
   `npx wrangler secret put SETUP_TOKEN` (verified via `--help`). Do **not**
   set `APP_MASTER_KEY_NEXT` — it exists only inside a rotation window.
3. Apply remote migrations — `npm run db:migrations:remote`
   (`wrangler d1 migrations apply DB --remote`; subcommand verified via
   `--help`, the `--remote` run itself is external).
4. Deploy — `npm run deploy` (`npm run build` + `wrangler deploy`;
   external step). Deploy never runs migrations and never rotates secrets.
5. Complete `POST /api/v1/setup` on the real origin, then do
   [google-setup.md](google-setup.md).

### CLI setup vs Deploy button

- **CLI** is the only supported path today.
- **Deploy button: explicitly NOT enabled.** There is no public repository
  URL; no button with a real `OWNER`/`REPOSITORY` may be published until one
  is provided (gate G6, [release-checklist.md](release-checklist.md)). The
  `cloudflare.bindings` metadata in `package.json` already describes
  `APP_MASTER_KEY` and `SETUP_TOKEN` so a button can be configured later —
  that is preparation, not an enabled button.

## Deploy / update rules

- **Never rotate `APP_MASTER_KEY` as part of a deploy or update.** Rotation
  is its own gated procedure ([operations.md](operations.md) §Master-key
  rotation). A routine redeploy keeps the same secrets.
- **Never recreate the `DB` database on update.** All state — including
  sealed credential envelopes and upload tombstones — lives in it; a new
  database id orphans the installation. Point updates at the same
  `database_id`.
- **Never set or remove `APP_MASTER_KEY_NEXT` outside a rotation.**
- Migrations are forward-only/additive (see the comment in
  `0004_account_credential_uniq.sql`): apply pending files with
  `wrangler d1 migrations apply`; do not hand-edit applied files.

### npm deploy surface (plan T16, wave 6)

`package.json` carries a fixed set of deploy-family scripts. Only the dry
run is safe to execute without Cloudflare authorization:

| Script | What it runs | Class |
| --- | --- | --- |
| `npm run deploy:dry-run` | `npm run build` + `node scripts/release/strip-dev-vars.ts` + `wrangler deploy --dry-run --outdir .wrangler/dry-run` — validates the bundle and config without touching the account (`.wrangler/` is gitignored) | **local-safe** — the only deploy-family script that may be run without authorization |
| `npm run deploy` | `npm run build` + `node scripts/release/strip-dev-vars.ts` + `wrangler deploy` to production | external/remote step requiring authorization |
| `npm run deploy:staging` | `CLOUDFLARE_ENV=staging npm run build` + `node scripts/release/strip-dev-vars.ts` + `CLOUDFLARE_ENV=staging wrangler deploy`. `CLOUDFLARE_ENV` selects `env.staging` at **build** time via the Cloudflare Vite plugin — the emitted `dist/drive_worker/wrangler.json` carries `name: drive-worker-staging`, and `wrangler deploy` follows `.wrangler/deploy/config.json` to it (a `--env`/`CLOUDFLARE_ENV` mismatch throws) | external/remote step requiring authorization |
| `npm run db:migrations:remote` | `wrangler d1 migrations apply DB --remote` (production) | external/remote step requiring authorization |
| `npm run db:migrations:remote:staging` | `wrangler d1 migrations apply DB --remote --env staging` | external/remote step requiring authorization |
| `npm run check:bundle` | `node scripts/release/check-bundle.ts` — secret/source-map scan of `dist/` (`--dir`, `--allow-source-maps` options): fails on the E2E fixture secrets (`tests/e2e/e2e-env.ts` defaults plus env overrides), any `.dev.vars` value (read in-process, never printed), PEM private keys, `ya29.` access-token shapes, an emitted `dist/**/.dev.vars`, or source maps unless explicitly allowed; also verifies `client/_headers`, the pdf.js worker (`pdf.worker.min-*.mjs`), the hash worker (`hash.worker-*.js`) and the hls.js chunk (`hls-*.js`) are present | local-safe |

Deploy and update scripts never rotate `APP_MASTER_KEY`, never recreate the
DB and never run migrations implicitly — provisioning (`d1 create`,
`secret put`) stays a separate operator step before the remote migration.

**`.dev.vars` hygiene:** `vite build` copies the developer's `.dev.vars`
into `dist/drive_worker/` so `wrangler dev`/preview can read secrets. The
deploy-family scripts run `scripts/release/strip-dev-vars.ts` between
build and wrangler to delete it (idempotent; `wrangler deploy` does not
read or upload `.dev.vars` anyway — the strip is dist-tree hygiene, and
the plain `npm run build` is left unchanged for local preview). A
standalone `npm run build && npm run check:bundle` in a checkout that has
`.dev.vars` still fails on the emitted file — the strip runs only inside
the deploy scripts, so run the scan in a clean checkout / CI for a
release verdict (the scanner prints an operator hint when it finds one).

## Staging

Use full isolation — nothing is shared with production. `wrangler.jsonc`
carries an `env.staging` block with a separate worker name
(`drive-worker-staging`) and its own D1 database `drive-worker-db-staging`
(bound as `DB`, with its own migration state — no `database_id` is checked
in; create it like the production one). `durable_objects` and `secrets`
are redeclared inside `env.staging` because Wrangler env blocks do not
inherit them; `exports`, `migrations_dir`, `assets` and `main` are
inherited from the top level. `wrangler d1 …` commands read
`wrangler.jsonc` directly, so `--env staging` selects the staging
database — but `deploy` gets its target from the build, not a flag.

Staging also needs:

- freshly generated `APP_MASTER_KEY`/`SETUP_TOKEN` under `--env staging`
  (never reuse production secrets; a staging dump encrypted under a
  different key cannot decrypt production envelopes anyway),
- a separate OAuth Web client whose redirect URI is the **staging**
  `canonicalOrigin` + `/api/v1/admin/google/oauth/callback`,
- its own Shared Drive test fixture and service accounts.
- Forks/CI must never receive production secrets (plan G5).

Operator flow (all external/remote steps requiring authorization), same
create → secrets → migrate → deploy order as production:

```sh
npx wrangler d1 create drive-worker-db-staging   # add printed id to env.staging
npx wrangler secret put APP_MASTER_KEY --env staging
npx wrangler secret put SETUP_TOKEN --env staging
npm run db:migrations:remote:staging  # wrangler d1 migrations apply DB --remote --env staging
npm run deploy:staging             # CLOUDFLARE_ENV=staging build + deploy
```

The `CLOUDFLARE_ENV=staging` inline syntax is POSIX-shell only — on
Windows, set the variable first (or use WSL) for both commands inside
`deploy:staging`. Then run `POST /api/v1/setup` on the staging origin and
follow [google-setup.md](google-setup.md) with the staging OAuth client.

## Expand → migrate → contract

Schema changes follow the forward-only migration sequence:

1. **Expand** — add a new `NNNN_*.sql` migration that only adds
   tables/columns/indexes (e.g. `0005_upload_projection_version.sql` added a
   column with a default). Deploy code that tolerates both shapes.
2. **Migrate** — apply `wrangler d1 migrations apply`; backfill inside new
   migrations or bounded runtime paths (the maintenance engine in
   `src/worker/security/rotation.ts` is the model for checkpointed,
   resumable backfills).
3. **Contract** — only after every environment runs the new code, a later
   migration may tighten constraints or drop obsolete columns. Do not
   contract and expand in one release: rollback must keep working.

## Backup / restore / rollback

Local tooling (all verified via `--help`/dry-run):

```sh
node scripts/backup.ts                      # dry-run: shows the export plan
node scripts/backup.ts --execute            # exports LOCAL D1 -> backups/*.sql
node scripts/backup.ts --remote --yes       # remote READ-ONLY export (external step)
node scripts/restore.ts --in backups/<file>.sql            # dry-run
node scripts/restore.ts --in backups/<file>.sql --execute  # restores LOCAL D1
```

Rules (enforced by the scripts themselves):

- Remote restore is refused; remote writes from these scripts are refused
  except the explicit read-only `backup --remote --yes` export.
- Keep the DB dump and `APP_MASTER_KEY` in **separate** backups: the dump
  alone cannot decrypt credential envelopes, and envelopes sealed under a
  lost key are unrecoverable.
- **Rollback** = redeploy the previous build at the same `database_id` and
  secrets, and if schema changed destructively restore the pre-upgrade dump
  first. Prefer non-destructive (expand-only) migrations precisely so a code
  rollback never needs a DB restore.
- Durable Object SQLite state is co-located with the DOs and is not covered
  by the D1 export; uploads in flight are also fenced by the
  `ROTATION_BLOCKED_BY_ACTIVE_UPLOADS`-style guards — drain or reconcile
  before major operations (see `GET /api/v1/admin/maintenance/status`).

## Local verification commands

```sh
node scripts/doctor.ts            # env sanity (read-only; --execute probes local D1)
npm run check                     # tsc -b across web + worker + tests
npm test                          # vitest in workerd
npm run build                     # tsc -b && vite build -> dist/
npm run test:e2e                  # Playwright (isolated .e2e-state; chromium + firefox)
npm run test:e2e:journey          # build + fake-Google journey on :8878
npm run deploy:dry-run            # build + wrangler deploy --dry-run (local-safe)
npm run check:bundle              # secret/source-map scan of dist/
```

See also: [operations.md](operations.md) (rotation/recovery/retention),
[google-setup.md](google-setup.md), [troubleshooting.md](troubleshooting.md),
[release-checklist.md](release-checklist.md).
