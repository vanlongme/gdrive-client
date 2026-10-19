# Security

This document describes the security model of the Drive Worker application as
implemented in the current code. It is a summary for operators and reviewers;
the authoritative behaviour lives in the referenced source files.

## Reporting a vulnerability

<security-contact placeholder>

> **Placeholder.** A security contact has not been designated yet — do not
> report vulnerabilities until this section names a real channel. The contact
> will be published here (and linked from the repository) before any public
> release; see gate **G6** in
> [docs/release-checklist.md](docs/release-checklist.md).

Until a contact exists, do not file public issues describing exploitable
behaviour.

## Threat model (summary)

Drive Worker is a single-user-workspace Google Drive front end: a React SPA
served from Cloudflare static assets, a Hono Worker API under `/api`, a D1
database (`DB`) and two SQLite Durable Objects (`ProjectCoordinator`,
`UploadSession`). The principal risks the code is built against:

- **Credential theft.** OAuth refresh tokens, OAuth client secrets, service
  account private keys and resumable-upload session URIs are never stored in
  plaintext. They are sealed into envelopes under `APP_MASTER_KEY`
  (`src/worker/security/vault.ts`) and are never returned by any API — view
  schemas carry ids, enums, counts and timestamps only.
- **CSRF / cross-site abuse.** Mutations under `/api/v1/*` pass an origin
  check (`isMutationOriginAllowed`, `src/worker/security/headers.ts`):
  `Sec-Fetch-Site: cross-site` is always rejected, and a presented
  `Origin`/`Referer` must equal the canonical origin pinned at setup. Better
  Auth enforces its own origin/fetch-metadata policy under `/api/auth/*`.
- **Session/account takeover.** Email/password auth is Better Auth with
  public sign-up disabled; the only admin is created through the one-time
  `POST /api/v1/setup` flow guarded by `SETUP_TOKEN`. Owner-level recovery
  uses a one-use, short-lived, hash-stored token
  (`POST /api/v1/admin/maintenance/recovery/claim`) — never the setup flow.
- **Confused-deputy / identity substitution.** Uploads pin the OAuth
  connection, principal, client, project and generated file ID
  (`upload_operations` columns `pinned_*`). The OAuth state is one-use,
  TTL-bound (10 minutes) and bound to the admin session, installation, client
  row version and purpose; the callback verifies the request landed on the
  byte-exact redirect URI recorded at start.
- **Provider-plane confusion.** The two Google credential planes are
  separated by construction, not by policy alone (see below).
- **Abuse of upstream quota / token leaks off-host.** All Google traffic
  exits through `createDriveTransport` (`src/worker/drive/transport.ts`):
  a closed per-provider operation allowlist, URLs pinned to
  `www.googleapis.com` under `/drive/v3/` or `/upload/drive/v3/` plus
  re-validated `*.googleusercontent.com` thumbnails, no automatic redirect
  following (every credential-bearing fetch runs with
  `redirect: 'manual'` and any 3xx is rejected before the body is read —
  `redirect: 'error'` is not a real fetch mode and throws in workerd), so
  bearer tokens cannot leak off-host, bounded retries, and no retry of
  streaming bodies.

## Provider separation (hard boundary)

- **Operator OAuth** (`GoogleOAuthProvider`,
  `src/worker/drive/providers/google-oauth.ts`) handles the entire catalog
  and **all** Drive writes. It requests only
  `https://www.googleapis.com/auth/drive` (`GOOGLE_DRIVE_SCOPE`,
  `src/worker/drive/oauth/google.ts`). It has **no content methods** — it
  cannot serve file bytes.
  It also issues the My Drive pool-grant calls (`oauth.permissions.list`,
  `.create`, `.delete`). The create body is pinned to exactly
  `{type:'user', role:'reader', emailAddress}` with
  `sendNotificationEmail=false` and `supportsAllDrives=true`; `emailAddress`
  comes only from the stored service-account row, never from a request body;
  delete only targets a permission id the app recorded when it created it.
  Service accounts have no `permissions.*` operation.
- **Service accounts** (`ServiceAccountReadProvider`,
  `src/worker/drive/providers/service-account-read.ts`) handle allowlisted
  content/metadata reads only. The SA transport cannot express a Drive
  mutation, and the token layer rejects any SA JWT request whose scope set is
  not exactly `drive.readonly` (`SA_READ_SCOPE`). The SA never impersonates a
  user.
- **No cross-provider fallback.** An OAuth-plane failure is never retried on
  the SA plane and vice versa; API error codes are derived per provider
  (`driveErrorToApiCode`, `src/worker/drive/errors.ts`), so a broken OAuth
  connection surfaces as `GOOGLE_REAUTH_REQUIRED` /
  `GOOGLE_CONNECTION_DISABLED` / `DRIVE_UNAVAILABLE` while a broken SA pool
  surfaces as `READ_PROVIDER_UNAVAILABLE` /
  `FILE_NOT_READABLE_BY_POOL` — never conflated.

## My Drive folder mounts

Anyone can share an unrelated file with a service account's address, so "the
service account can read it" is never treated as proof that a file belongs to a
mount. For My Drive folder mounts the Worker proves containment itself
(`src/worker/drive/containment.ts`): it walks the file's `parents` up to the
mounted folder through the mount's OAuth catalog connection (at most 32 hops;
a trashed or out-of-tree ancestor, a Shared Drive ancestor, an upstream error
or a depth overrun all deny) and caches verdicts per isolate for 60 seconds,
keyed by mount. Denial is the same not-accessible answer as for a missing file,
and there is no retry through the other provider. Folders moved in the Drive
web UI become visible after the cache window; app-initiated folder creates and
trashes drop the changed folder's cached verdict at once (other folders,
including descendants, keep theirs until expiry). Pool grants are created and
revoked only for service accounts in the stored pool, the sync endpoint is
admin-only and origin-checked, and permissions the app did not create are
never deleted. Responses carry stable codes only (`MOUNT_ROOT_*`, `grant:*`,
`upload:quota_exceeded`), never Google error text, tokens or permission bodies.

## Secret handling

- Required Worker secrets: `APP_MASTER_KEY` and `SETUP_TOKEN`
  (`wrangler.jsonc` `secrets.required`). Both must be **canonical base64 of
  exactly 32 bytes**; malformed or missing values close the entire protected
  API with `503 BOOTSTRAP_SECRETS_INVALID`
  (`src/worker/security/bootstrap-config.ts`, `src/worker/app.ts`).
- `APP_MASTER_KEY_NEXT` is optional and must be staged **only** during a
  master-key rotation; while set, all new seals land on it
  (`src/worker/security/rotation.ts`, `docs/operations.md`).
- Envelopes carry a keyId (`v1` or `k_<fingerprint(NEXT)>`); opens select the
  key by the envelope's own label, so reads work before, during and after a
  rotation. Media tickets ride the same keyring
  (`createSecretKeyring(env, 'media-ticket')`, `src/worker/security/tickets.ts`):
  minted under `APP_MASTER_KEY_NEXT` while it is staged, verified by envelope
  keyId, and tickets sealed under a promoted-away key fail closed and are
  re-minted on demand (TTL bounded — 24 h absolute, 60 min for non-admin
  callers; `src/shared/contracts/media.ts`).
- Secrets never appear in API DTOs, diagnostics (`GET
  /api/v1/admin/diagnostics` is contractually redacted — its `metrics`
  section emits only in-isolate counters, durations and enum labels since
  the isolate started; `src/worker/admin/metrics.ts`), logs or
  `package.json`/`.dev.vars.example`. Keep real values out of Git, issues,
  evidence docs and screenshots. `.dev.vars` is gitignored.

## HTTP surface hardening

- Static SPA headers (`public/_headers`): `Content-Security-Policy:
  default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'
  'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:;
  connect-src 'self'; media-src 'self' blob:; worker-src 'self' blob:;
  manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors
  'none'; form-action 'self'`, plus `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`,
  `Cross-Origin-Resource-Policy: same-origin`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=()`.
- Every `/api/*` response (including errors) carries
  `Content-Security-Policy: default-src 'none'; base-uri 'none';
  frame-ancestors 'none'`, `nosniff`, `no-referrer`, `same-origin` CORP and
  `Cache-Control: no-store` (`applyApiSecurityHeaders`).
- Before setup completes, only `GET /api/v1/health`,
  `GET /api/v1/setup/status`, `POST /api/v1/setup` and the static shell are
  reachable; all protected prefixes fail closed (`503 SETUP_REQUIRED`), and
  unknown `/api` paths return a JSON `404` — they are never rewritten to the
  SPA.
- File bodies stream through the ordinary Worker only — never buffered whole
  and never routed through Durable Objects. Both Durable Objects assert their
  pinned internal origin (`https://project-coordinator.internal` /
  `https://upload-session.internal`) before running any command.

## Recorded design trade-offs (pre-release review, W6-R3)

These are deliberate, documented behaviours — not open bugs — recorded so
operators and release notes do not overclaim:

- **Bearer capabilities in URL query strings.** Share tokens and media
  tickets travel as `?share=` / `?ticket=` query parameters
  (`src/worker/transfers/content-access.ts:241`) — a deliberate choice
  because external players (e.g. HLS clients) cannot set headers. A URL
  left in a proxy log grants mount-scoped read until expiry. Mitigations
  in place: `Referrer-Policy: no-referrer` on every `/api` response and
  emitted content, CSP `connect-src 'self'`/`img-src` restrictions, tokens
  stored only as SHA-256 domain-separated hashes, a required `expiresAt`,
  and revocation effective on the next request. **Operator duty:** do not
  log full query strings in proxies or access logs fronting the worker.
- **Unpinned file shares cover future revisions.** A file-scope share
  created without `revisionId` admits current content and *any* revision
  of that file, including ones uploaded after the share was created
  (`shareScopeCovers`, `src/worker/security/shares.ts:286`). Pin
  `revisionId` in the share scope when the share must name a fixed
  snapshot.
- **Setup-token throttling is linear, not exponential.** Failed
  `POST /api/v1/setup` claims lock for `5 s × failed attempts`, capped at
  300 s (`SETUP_LOCK_BASE_MS`/`SETUP_LOCK_MAX_MS`,
  `src/worker/auth/setup.ts:33`). The bound is real but grows linearly.

## Operational security

- Master-key rotation, maintenance mode, retention cleanup and admin
  recovery are documented in [docs/operations.md](docs/operations.md).
  Rotation no longer refuses to start while uploads are in flight: `step`
  re-keys each live UploadSession DO envelope in place through the `/rekey`
  command (CAS-guarded), and `verify`/`complete` re-prove every live session —
  they answer `ROTATION_BLOCKED_BY_ACTIVE_UPLOADS` (409, a count only, never
  operation ids) while any session reports unavailable/unrekeyable.
- All ops scripts in `scripts/` default to dry-run and refuse remote
  mutations; `--execute` against a non-loopback URL requires `--yes`.
- Error responses are bounded (`{error:{code,message,requestId}}`); internal
  detail, envelopes, keys, tokens and upstream URIs are never included.
  Media-package `failure_reason` persists only stable codes
  (`hls:<reason>` / `hls-index:<code>`, `src/worker/media/package-index.ts`)
  — upstream Google text never reaches the DTO.

## Related documents

- [docs/operations.md](docs/operations.md) — rotation, recovery, retention,
  diagnostics.
- [docs/google-setup.md](docs/google-setup.md) — OAuth client, scopes and
  Shared Drive / My Drive folder permissions.
- [docs/deployment.md](docs/deployment.md) — provisioning and update rules.
- [docs/troubleshooting.md](docs/troubleshooting.md) — error-code and
  health-state reference.
