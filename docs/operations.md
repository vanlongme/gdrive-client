# Operations runbook (T14)

Local-only procedures. Every script defaults to dry-run against local
resources and never mutates remote state. All commands assume repo root and
`PATH` with Node 24 (`export PATH=$HOME/.local/node24/bin:$PATH`).

## Health and diagnostics

- `GET /api/v1/health` → `{ "status": "ok" }`. Minimal by contract: no
  mount, credential or pool detail, and it never refreshes the token pool.
- `GET /api/v1/admin/diagnostics` (admin session) — redacted operational
  view with the two provider planes strictly separated:
  - `oauth.connections`: catalog/write health per connection (state,
    enabled, coordinator cooldown/failure counters). A `needs_reauth`
    connection affects catalog/uploads only.
  - `serviceAccounts.accounts`: content-read health per SA (enabled,
    coolingDown, recentFailures). SA health never implies write health.
  - `uploads`: per-state counts, confirmed bytes, completed-but
    reader-blocked count. `readers`: file_readiness state counts.
  - `auditErrors24h`: error events per operation in the last 24 h.
  - `cooldowns`: decoded coordinator cooldowns per credential/file.
  - `maintenance`: current mode/phase plus `uploadSessions` rekey progress
    (processed/blocked/done) once a rotation has scanned upload ops.
  - `metrics`: **in-isolate** counters since this worker started
    (`scope: 'isolate'`, `since`): content request count, streamed bytes
    and request→first-byte duration buckets, blocked-reader verdicts;
    catalog list/search provider-call durations; upload chunk count,
    chunk-PUT durations, confirmed bytes, retry outcomes, blocked and
    re-auth-blocked counts. Aggregation is in-memory only — no per-request
    D1 writes — so values reset on isolate restart and are never
    fleet-wide.
  No field carries envelopes, tokens, keys or upstream URIs — every
  metrics value is an enum label, count or duration.

## Retention cleanup

Defaults (spec §13): audit events are deleted after 30 days; completed
upload detail (the transient `summary` progress blob) is purged after 7
days **only** when the operation is terminal and its durable result
tombstone exists. `cleanup_pending` and non-terminal rows are kept;
tombstone rows, pinned identity and the idempotency index are never
deleted — a replayed key still resolves the original outcome.

Run a bounded pass (admin session):

```sh
curl -X POST $ORIGIN/api/v1/admin/maintenance/cleanup \
  -H 'content-type: application/json' -H "cookie: $COOKIE" \
  -d '{"dryRun":true}'           # count only, no writes
curl ... -d '{"batchSize":500}'  # real pass; repeat while truncated=true
```

Each pass is bounded (`batchSize` ≤ 1000) and idempotent: a crash mid-run
is resumed by simply re-running the command.

## Maintenance mode

`POST /api/v1/admin/maintenance/mode {"enabled":true}` sets `mode='drain'`:
every ProjectCoordinator `/admit` refuses new token issuance
(`UPSTREAM_UNAVAILABLE` + `detail: maintenance_mode`, retryable), and
CREATING a new upload/folder/upload-batch operation is refused with a
retryable `503 DRIVE_UNAVAILABLE` envelope (idempotent replays of existing
operations, chunks, reconcile/pause/resume/cancel and expiry are never
gated — in-flight work drains normally). In-flight requests holding
tokens are not interrupted. `{"enabled":false}` lifts the gate — refused
while a key rotation is in flight. Both gates fail closed on D1 read
errors.

## Master-key rotation

APP_MASTER_KEY rotation re-seals every D1 credential envelope. The old key
is retained until every envelope is verified under the new key.

**Active-upload rekey (wave 5).** Rotation no longer refuses to start
while uploads are in flight. `step` drives a checkpointed
`upload_sessions` pseudo-source after the D1 envelope tables: each
non-terminal `upload_operations` row's UploadSession DO gets a `/rekey`
command that opens its `session_uri_envelope` and re-seals it under NEXT
(the write is CAS-guarded on the value it opened, so a racing session
write is never clobbered). Sessions that cannot be re-keyed are recorded
as `blockedUploads` in the step result and in
`GET /status` (`uploadSessions`), and `verify`/`complete` re-prove every
live session: they return `ROTATION_BLOCKED_BY_ACTIVE_UPLOADS` (409,
count only — never op ids) while any session still reports
unavailable/unrekeyable. Remediation is unchanged: finish/cancel the
operation or let its session renew (a dead envelope self-heals through
the normal session-expired → renew path), then retry. Because maintenance
mode blocks new operation creation, the non-terminal set only shrinks
during a run, and every envelope minted inside the window already lands
on NEXT.

1. Generate and stage the next key (do not replace APP_MASTER_KEY yet):

   ```sh
   node scripts/rotate-key.ts --generate   # prints APP_MASTER_KEY_NEXT=...
   # add it to .dev.vars (local) or `wrangler secret put` (remote), restart
   ```

   Envelope keyIds: legacy envelopes carry `v1`; envelopes written during
   the rotation window carry `k_<fingerprint(NEXT)>`. The keyring opens by
   the envelope's own keyId, so reads work before, during and after
   promotion. While `APP_MASTER_KEY_NEXT` is set, all *new* seals land on
   the next key — do not stage it outside a rotation, and never remove it
   before completing step 5.

2. Start the rotation (blocks new token admissions immediately):

   ```sh
   node scripts/rotate-key.ts --execute --url http://localhost:8787 \
     --email admin@… --password …
   # or drive the endpoints directly:
   POST /api/v1/admin/maintenance/rotation/start
   POST /api/v1/admin/maintenance/rotation/step   {"batchSize":200}  # repeat
   POST /api/v1/admin/maintenance/rotation/verify # must return ok:true
   POST /api/v1/admin/maintenance/rotation/complete
   ```

   Steps are checkpointed per table (`maintenance_state.checkpoint`); a
   crash resumes with another `step` call. Verify failing rolls the run
   back to `reencrypting` with the failed table's cursor reset — run `step`
   again, then re-verify. `abort` is accepted only before any envelope was
   rewritten; afterwards the only exits are completing the rotation or
   restoring a backup.

3. `complete` deletes all app sessions; media tickets die with the old key.
   Users sign in again; uploads resume after login — pinned OAuth writers
   and file IDs are unchanged.

4. Promote: only after `/rotation/complete` returns success, set
   `APP_MASTER_KEY` to the NEXT value, remove `APP_MASTER_KEY_NEXT`,
   redeploy. `APP_MASTER_KEY_NEXT` must stay set for the entire run —
   removing it early orphans envelopes sealed during the window. Old-key
   material can then be discarded.

   UploadSession DO envelopes (`session_uri_envelope`) are re-keyed
   on demand via the `UploadSessionRekeyPort` contract in
   `src/worker/security/rotation.ts`: the DO `/rekey` command opens the
   stored envelope by its own keyId and re-seals it under the current
   write key (NEXT when staged). It is admitted only while a maintenance
   mode is active, is idempotent, and opens before reporting `resealed`
   — a corrupt envelope carrying the new label is still caught. The
   rotation engine drives it inside `step` (checkpointed, bounded batches)
   and re-proves all sessions at `verify`/`complete`. Session-URI seals in
   general follow the keyring — envelopes minted inside the rotation
   window already carry the `k_<fingerprint(NEXT)>` label, and a session
   envelope that opens under no configured key is treated as an expired
   session so the upload renews instead of stalling.

## Admin recovery (locked out of the only admin)

Owner-only flow — requires D1 write access (local wrangler or the
Cloudflare dashboard), never the public setup flow.

```sh
node scripts/admin-recovery.ts                  # prints token + SQL (dry-run)
node scripts/admin-recovery.ts --execute        # inserts the hash into local D1
curl -X POST $ORIGIN/api/v1/admin/maintenance/recovery/claim \
  -H 'content-type: application/json' \
  -d '{"token":"grt_…","email":"admin@…","newPassword":"…"}'
```

The token is 32 random bytes, stored only as a SHA-256 hash, valid ≤ 2 h,
consumed atomically (one use) AFTER the email/role checks pass — a wrong
email returns 404 (audited) without burning the token, so the owner may
retry with the right address. Failed claims are rate-limited to 10 per
hour per token-hash bucket plus a higher global cap (100/hour), so wild
guesses cannot lock out the legitimate owner, and a throttle
bookkeeping write failure denies the claim (5xx) rather than allowing
unbounded guessing. The claim resets the
admin's password through Better Auth's own hashing, deletes that user's
sessions, and never touches `app_settings` — setup cannot be reopened.

## Backup and restore

```sh
node scripts/doctor.ts [--execute]              # local env sanity
node scripts/backup.ts [--out FILE] [--execute] # dry-run by default; --execute exports local D1
node scripts/restore.ts --in FILE [--execute]   # validates the dump, local only this wave
```

Keep the DB dump and the master key in separate backups: the dump alone
cannot decrypt stored credentials. Remote restore and remote writes from
scripts are refused in this wave.
