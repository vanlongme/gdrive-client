# Troubleshooting

Maps the app's **actual** API error codes and admin-visible states to causes
and next actions. All codes below are the `error.code` values defined in
`src/shared/contracts/common.ts` (`API_ERROR_CODES`) — the response shape is
`{"error":{"code","message","requestId","retryAfterSeconds?"}}`. Quote the
`requestId` when reporting; it is set on every `/api/*` response.

First ports of call:

- `GET /api/v1/health` → `{status:"ok"}` — liveness only, by contract no detail.
- `GET /api/v1/setup/status` → `{setupState, canonicalOrigin}` — setup
  lifecycle (`uninitialized` | `in_progress` | `complete` | `unavailable`).
- `GET /api/v1/admin/provider-health` (admin) — OAuth connection states vs SA
  read-pool health, kept strictly separate.
- `GET /api/v1/admin/diagnostics` (admin) — redacted counters: per-connection
  state/cooldowns, SA health, upload state counts, `file_readiness` counts,
  audit errors (24 h), `maintenance` snapshot, and `metrics` — **in-isolate**
  counters/histograms since this worker started (`scope:"isolate"`,
  `since`); they reset on isolate restart and are never fleet-wide
  (`src/worker/admin/metrics.ts`).
- `GET /api/v1/admin/maintenance/status` (admin) — maintenance mode +
  rotation progress.

In the SPA, every API failure is rendered as a localized next-action
message rather than a bare error: `messageKeyForError`
(`src/web/lib/error-message.ts`) maps each `error.code` below to a
specific string (spec §11.3), carries `requestId`/`retryAfterSeconds`
through to the UI, and falls back to a generic retry message for codes
with no dedicated text.

## Error codes → cause → action

### Bootstrap, setup and request envelope

| Code | Status | Cause | Next action |
| --- | --- | --- | --- |
| `BOOTSTRAP_SECRETS_INVALID` | 503 | `APP_MASTER_KEY`/`SETUP_TOKEN` missing or not canonical base64 of exactly 32 bytes | Regenerate with `openssl rand -base64 32`; fix `.dev.vars` / worker secrets. Fail-closed by design — every protected route 503s |
| `SETUP_REQUIRED` | 503 | `app_settings.setup_state` is not `complete` (never ran setup, or in progress) | Finish `POST /api/v1/setup`; check `GET /api/v1/setup/status` |
| `SETUP_STATUS_UNAVAILABLE` | 503 | `app_settings` row unreadable/malformed — treated as closed, never as uninitialized | Check D1 health; run `node scripts/doctor.ts --execute` locally |
| `SETUP_TOKEN_INVALID` | 4xx | Wrong `token` in the setup claim | Use the exact `SETUP_TOKEN` value; guessing is throttled linearly — 5 s × failed attempts, 300 s cap (`src/worker/auth/setup.ts`) |
| `SETUP_ALREADY_COMPLETED` | 409 | Re-claiming a completed installation | Sign in instead; setup cannot be reopened |
| `SETUP_IN_PROGRESS` | 409 | A concurrent setup claim holds the slot | Wait and retry, or resume the interrupted claim |
| `SETUP_NOT_IMPLEMENTED` / `AUTH_NOT_IMPLEMENTED` | 5xx | A stub surface was reached (should not occur in normal use) | Report a bug with the `requestId` |
| `VALIDATION_FAILED` | 400 | Body/params failed the zod contract (bad JSON, wrong shape, oversized field) | Fix the request; compare with the schema in `src/shared/contracts/` |
| `NOT_FOUND` | 404 | Unknown id, or unknown `/api` path (never rewritten to the SPA) | Check the id/path |
| `ORIGIN_REJECTED` | 403 | Mutation arrived cross-site, or `Origin`/`Referer` ≠ pinned `canonicalOrigin` | Call the API from the app's own origin; verify `canonicalOrigin` |
| `IDEMPOTENCY_CONFLICT` | 409 | An idempotency key was replayed with a *different* payload | Retry with the identical payload, or use a new key |
| `INTERNAL_ERROR` | 500 | Unhandled failure | Retry once; report with `requestId` |

### Authentication and authorization

| Code | Status | Cause | Next action |
| --- | --- | --- | --- |
| `AUTH_REQUIRED` | 401 | No/expired Better Auth session | `POST /api/auth/sign-in/email` |
| `AUTH_UNAVAILABLE` | 503 | Auth subsystem/DB unavailable during session resolution | Retry; check D1/diagnostics |
| `FORBIDDEN` | 403 | Authenticated but lacks the role, mount grant, or OAuth-plane permission for the resource | Check user role/mount grants; for Drive-side denials check the operator's Shared Drive role |

### Google provider plane (OAuth = catalog/write; SA = content read)

| Code | Status | Cause | Next action |
| --- | --- | --- | --- |
| `GOOGLE_REAUTH_REQUIRED` | 4xx/502 | Refresh token rejected (`invalid_grant`), revoked grant, missing `drive` scope, or Google `error` on callback | Reconnect: `POST /api/v1/admin/google/oauth/start {purpose:"reconnect",connectionId}`. Testing-mode OAuth apps have expiring refresh tokens — see [google-setup.md](google-setup.md) §2 |
| `GOOGLE_CONNECTION_DISABLED` | 409 | Connection or OAuth client disabled, or its row version changed mid-flow | List `GET .../google/connections`; reconnect or connect a new client |
| `DRIVE_UNAVAILABLE` | 5xx | OAuth-plane upstream failure: transport error, Google 5xx, timeout — also returned `503` for **new** uploads/folders/batches while maintenance mode is draining | Retry with backoff; check diagnostics `oauth.connections` and `maintenance` |
| `READ_PROVIDER_UNAVAILABLE` | 5xx | SA read pool failing or fully cooling down | `GET /api/v1/admin/provider-health`; re-import a valid SA key; check Shared Drive membership |
| `FILE_NOT_ACCESSIBLE` | 4xx | OAuth identity got 403/404 on the file — no Shared Drive role, file gone, or file-level restriction | Verify operator membership/role; confirm the file exists for that identity |
| `FILE_NOT_READABLE_BY_POOL` | 4xx | No SA in the read pool can read the file (membership, download restriction, or not-found for every SA) | Add the SA as Viewer on the Shared Drive; check `file_readiness` reason |
| `RATE_LIMITED` | 4xx | Drive 429/403 rate class | Honor `retryAfterSeconds`; reduce concurrency; coordinator cooldowns back off automatically |
| `PROJECT_LIMITED` | 4xx | Google Cloud project quota exhausted (`quotaExceeded` class) — whole-project cooldown | Check project quota in Google Cloud console (no quota numbers are hard-coded here — see the official Drive limits doc) |
| `STORAGE_FULL` | 4xx | Drive storage quota exhausted | Free space / raise storage; uploads cannot complete |
| `SNAPSHOT_UNAVAILABLE` | 4xx | Catalog snapshot/signed pagination cursor no longer valid (policy version moved) | Re-list from the root |
| `CONTENT_CHANGED` | 409 | File revision changed between metadata and body fetch | Re-fetch metadata, then retry the content request |
| `MEDIA_PACKAGE_NOT_READY` | 4xx/503 | Media package still being assembled | Poll `GET /api/v1/media-packages/:packageId` |
| `PREVIEW_UNSUPPORTED` | 4xx | No viewer registered for that MIME type | Download the file instead |

### Upload lifecycle

| Code | Status | Cause | Next action |
| --- | --- | --- | --- |
| `UPLOAD_EXPIRED` | 4xx | Resumable session URI 404/410 upstream — the session is gone | Let the client renew (lookup→renew chain); an unopenable sealed session is treated the same way |
| `UPLOAD_NEEDS_RECONCILIATION` | 4xx | Final response lost/aborted — remote outcome uncertain | Reconcile the operation (`POST /api/v1/uploads/:u/reconcile`); do not blindly restart — the idempotent tombstone resolves replays |
| `FILE_CONFLICT` | 409 | Upstream conflict/precondition (e.g. etag/generation race) | Reload state and re-decide; conflicted operations are terminal |

During key rotation these maintenance-only results appear inside
`/admin/maintenance/rotation/*` responses (not the shared `error.code`
enum). Since wave 5, starting a rotation is **not** blocked by active
uploads: `step` drives a checkpointed `upload_sessions` pseudo-source that
re-keys each live UploadSession DO envelope in place (CAS-guarded
`/rekey`), recording any it cannot re-key in `blockedUploads`.
`verify` and `complete` re-prove every live session and return
`ROTATION_BLOCKED_BY_ACTIVE_UPLOADS` — HTTP 409 with a count only, never
operation ids — while any session still reports unavailable/unrekeyable.
Remediation: finish/cancel the operation or let its session renew (a dead
envelope self-heals via the session-expired → renew path), then retry.

## Admin-visible states

### `google_connections.state` (OAuth / catalog-write plane)

`connected` → `degraded` → `needs_reauth` → `disabled`.

| State | Meaning | Action |
| --- | --- | --- |
| `connected` | Healthy | — |
| `degraded` | Recent upstream failures; coordinator cooldowns active | Watch diagnostics; usually self-heals |
| `needs_reauth` | Stored refresh grant no longer works | `POST .../oauth/start {purpose:"reconnect"}` |
| `disabled` | Locally disabled (disconnect/revoke) | Connect anew; reconnect is refused on disabled rows |

### `maintenance_state` (`GET /api/v1/admin/maintenance/status`)

Modes (`src/worker/security/rotation.ts` `MAINTENANCE_MODES`):

| Mode | Effect |
| --- | --- |
| `off` | Normal admission |
| `drain` | No new token issuance and no new upload/folder/batch creation (`503 DRIVE_UNAVAILABLE`, retryable); in-flight work drains normally |
| `key-rotation` | `drain` plus the envelope re-encryption engine running |

Phases (`ROTATION_PHASES`): `idle` → `reencrypting` → `verifying` →
`verified` → `done`; `failed` = a corrupt envelope halted the run —
`last_error` names the source/row (never plaintext); fix the row and re-step.

| Phase | Action |
| --- | --- |
| `reencrypting` | Keep calling `POST .../rotation/step` until `remaining:false` |
| `verifying` | `POST .../rotation/verify`; on failure the run returns to `reencrypting` with the failed cursor reset |
| `verified` | `POST .../rotation/complete` (revokes all sessions), then promote `APP_MASTER_KEY_NEXT` → `APP_MASTER_KEY` |
| `failed` | Read `last_error`, repair, re-run `step` |
| `done` | Promote the key and redeploy if not yet done |

`POST .../rotation/abort` is accepted only before any envelope was
rewritten. Lifting `mode` is refused while a rotation is in flight.

### `upload_operations.state`

`created` → `preparing` → `uploading` → `verifying` → `completed`, with
`paused`, `reconciling`, `cancel_requested` branches and terminals
`cancelled`, `expired`, `blocked`, `conflict`, `cleanup_pending`.
Non-terminal rows no longer block starting a rotation, but a session that
stays unrekeyable keeps `verify`/`complete` returning
`ROTATION_BLOCKED_BY_ACTIVE_UPLOADS` (see above). `cleanup_pending` rows
are retained through retention cleanup because they hold unresolved remote
writes.

### `file_readiness.reader_access_state` (SA read plane)

`unchecked` → `pending` → `readable` | `blocked`. `blocked` = the pool
verified it cannot read the file (membership or restriction) — see
`FILE_NOT_READABLE_BY_POOL` above. `POST
/api/v1/mounts/:mountId/files/:fileId/readiness` forces a re-check.

### Upload batch states

Batch: `draft` → `sealed` → `executing` → `completed` | `failed` |
`cancelled`. Nodes: `pending` → `in_progress` → `completed` | `failed` |
`cancelled`.

## Common operational fixes

| Symptom | Fix |
| --- | --- |
| Everything 503s after deploy | `BOOTSTRAP_SECRETS_INVALID` or `SETUP_REQUIRED` — check secrets format and `GET /api/v1/setup/status` |
| Browser mutations fail `ORIGIN_REJECTED` | `canonicalOrigin` pinned at setup ≠ serving origin; redo the canonical origin or serve on the pinned one |
| All uploads 503 but reads fine | Maintenance `mode` is `drain`/`key-rotation` — see `/maintenance/status` |
| Downloads fail but catalog works | SA plane broken — `READ_PROVIDER_UNAVAILABLE`/`FILE_NOT_READABLE_BY_POOL`; the two planes fail independently by design |
| Locked out of the only admin | Owner recovery: `node scripts/admin-recovery.ts`, then `POST /api/v1/admin/maintenance/recovery/claim` — see [operations.md](operations.md) |

Full runbooks: [operations.md](operations.md). Provider/permission detail:
[google-setup.md](google-setup.md) §8.
