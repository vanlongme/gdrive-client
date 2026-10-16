# Google setup

How to prepare the Google-side resources Drive Worker needs: one OAuth Web
client for the operator account, one or more service accounts for the
content-read pool, and a Shared Drive both can reach.

> All Google Cloud console and `gcloud` steps below are **external steps
> requiring authorization** on your own Google account/organization. Only the
> Worker-side API calls run against this app. Commands that were verified
> locally are marked; everything else is a reference shape, not evidence of a
> run. Costs and quotas are not stated here — see the official pages:
> - <https://developers.google.com/drive/api/guides/about-auth>
> - <https://support.google.com/cloud/answer/6158849> (OAuth consent screen)
> - <https://developers.google.com/drive/api/guides/limits> (Drive quotas)
> - <https://cloud.google.com/iam/docs/service-accounts> and
>   <https://cloud.google.com/resource-manager/docs/organization-policy/restricting-service-accounts>

## 1. What the app actually asks for

Verified against the code:

- **Operator OAuth scope:** `https://www.googleapis.com/auth/drive`
  (`GOOGLE_DRIVE_SCOPE`, `src/worker/drive/oauth/google.ts`; the only scope
  in `REQUIRED_SCOPES`, `src/worker/drive/oauth/routes.ts`). This is a
  *restricted* Google scope — production use requires OAuth app verification.
- **Service-account scope:** `https://www.googleapis.com/auth/drive.readonly`
  (`SA_READ_SCOPE`). The worker rejects any SA token request whose scope set
  is not exactly this value.
- **OAuth callback path (fixed):**
  `OAUTH_CALLBACK_PATH = '/api/v1/admin/google/oauth/callback'`
  (`src/worker/drive/oauth/routes.ts`). The full redirect URI is
  `<canonicalOrigin>` + that path, where `<canonicalOrigin>` is the origin
  pinned during `POST /api/v1/setup`. Shape:

  ```
  https://<your-worker-host>/api/v1/admin/google/oauth/callback
  ```

  The callback handler compares the incoming `origin + pathname` to the
  recorded redirect URI **byte-exact** — scheme, host, port and path must all
  match what was registered, with no extra path segments or trailing slash.

## 2. OAuth consent screen *(external step requiring authorization)*

1. In Google Cloud console, pick or create a project.
2. Configure the OAuth consent screen (External unless the workspace
   restricts to Internal). Add the scope
   `https://www.googleapis.com/auth/drive` — it is restricted, so the app
   must be verified for production use.
3. **Testing-mode caveat:** while the app stays in *Testing* publishing
   status, Google issues refresh tokens that **expire** (Google documents a
   7-day expiry for unverified testing apps; see the consent-screen docs
   linked above). When the refresh token dies, the connection enters
   `needs_reauth` and every catalog/write call fails with
   `GOOGLE_REAUTH_REQUIRED` until an admin reconnects. Publishing the app
   (and passing verification) removes this expiry.

## 3. OAuth Web client *(external step requiring authorization)*

1. Create credentials → **OAuth client ID → Web application**.
2. Authorized redirect URI: exactly
   `https://<your-worker-host>/api/v1/admin/google/oauth/callback`
   (substitute your real worker host; for staging use the staging origin —
   a different canonical origin means a different redirect URI).
3. Register the client in the app (admin session, local example against
   `npm run dev`):

   ```sh
   curl -X POST http://localhost:8787/api/v1/admin/google/clients \
     -H 'content-type: application/json' -H "cookie: $COOKIE" \
     -d '{"clientId":"<id>.apps.googleusercontent.com","clientSecret":"<secret>"}'
   ```

   Request schema `ImportOAuthClientRequestSchema`
   (`src/shared/contracts/admin.ts`): `clientId`, `clientSecret`, optional
   `projectId` (derived from the client-ID prefix when omitted), optional
   `redirectUri` which — if supplied — must equal the canonical callback or
   the request is rejected `400 VALIDATION_FAILED`. The secret is sealed
   under `APP_MASTER_KEY`; list views never return it.

## 4. Connect the operator account (OAuth flow)

Admin endpoints under `/api/v1/admin/google`
(`src/worker/drive/oauth/routes.ts`):

| Call | Purpose |
| --- | --- |
| `GET /clients` | list registered OAuth clients |
| `POST /oauth/start` `{purpose:"connect",oauthClientId}` | returns `{authorizationUrl}` |
| `GET /oauth/callback` | Google redirect target (handled by the worker) |
| `GET /connections` | list connections (no token material) |
| `POST /oauth/start` `{purpose:"reconnect",connectionId}` | re-auth an existing connection |
| `POST /connections/:id/disconnect` | local disable + drop stored token (no Google call) |
| `POST /connections/:id/revoke` | revoke the grant at Google, then local disable |

Flow notes enforced by the code: state is random, one-use, 10-minute TTL and
bound to the admin session + installation + client row version + purpose;
PKCE S256 is used and the verifier stays sealed until exchange; the exchange
must return the `drive` scope or the connection is flagged; reconnect CASes
the connection row version and never overwrites the stored refresh token
with an empty response.

## 5. Shared Drive membership *(external step requiring authorization)*

v1 mounts are whole Shared Drives (`driveId` in
`CreateMountRequestSchema`).

- **Operator account (OAuth):** must be a member of the Shared Drive with a
  role that can create, upload and trash files — **Content manager** is the
  recommended role (Contributor can create files but has restricted
  trash/delete rights; see the Shared Drive roles doc at
  <https://support.google.com/a/answer/7337554>). Catalog reads work for any
  member; writes fail `FORBIDDEN`/`FILE_NOT_ACCESSIBLE` otherwise.
- **Service account(s):** add each SA's `client_email` as a member with the
  **Viewer** role — the pool only ever requests `drive.readonly`. Files the
  SA cannot see report `FILE_NOT_READABLE_BY_POOL`; `blocked` rows in
  `file_readiness` usually mean membership is missing (or a download
  restriction applies to that file).

## 6. Service accounts *(external step requiring authorization)*

1. In the same or a separate GCP project, create a service account. It does
   not need any project-level IAM role for Drive reads — Shared Drive
   membership is what grants access.
2. Create a JSON key for it. **Org-policy caveat:** many organizations deny
   key creation via the `iam.disableServiceAccountKeyCreation` /
   `iam.disableServiceAccountKeyUpload` organization policies; if the console
   refuses, an org admin must exempt the SA/project (see the org-policy doc
   linked above). The app does not support Workload Identity Federation or
   domain-wide delegation — only a downloaded key JSON imported server-side.
3. Import the key (admin session):

   ```sh
   curl -X POST http://localhost:8787/api/v1/admin/service-accounts \
     -H 'content-type: application/json' -H "cookie: $COOKIE" \
     -d '{"keyJson":"<full contents of the key JSON file>"}'
   ```

   `ImportServiceAccountRequestSchema` accepts `{keyJson}` (≤64 KiB). The
   private key must be a valid PKCS8 RSA key — the import validates it and
   rejects malformed material with `400 VALIDATION_FAILED`. Re-importing the
   same `(project_id, client_email)` rotates the key in place; a different SA
   creates a new credential. The response carries only public metadata.

## 7. Create the mount

The easiest path is the admin UI: the **Onboarding** tab is the default
landing at `/admin` (`src/web/features/admin/admin-page.tsx` —
`useState<SectionKey>("onboarding")`). It shows each setup step's real
state read from the admin APIs — the exact OAuth callback URL to register
in Google Cloud (with a copy button), the imported clients, the operator
connection and its state, the SA import plus Viewer membership reminder —
and ends in the **Shared Drive chooser**
(`src/web/features/admin/onboarding-section.tsx`,
`shared-drive-chooser.tsx`).

The chooser calls `GET /api/v1/admin/shared-drives?connectionId=<conn>`
(`src/worker/admin/routes.ts`), a paged listing (`pageSize` 1–100, opaque
`pageToken`) of the Shared Drives visible to **one** OAuth catalog
connection. The Drive `drives.list` call runs under that operator identity
with `useDomainAdminAccess=false` pinned by the transport
(`src/worker/drive/transport.ts`), so only drives the operator account can
actually see are returned — there is no SA path and no fallback. Picking a
drive only prefills the mount form; the backend still validates `driveId`
on submit.

Equivalent API call (admin session, local example):

```sh
curl -X POST http://localhost:8787/api/v1/admin/mounts \
  -H 'content-type: application/json' -H "cookie: $COOKIE" \
  -d '{"label":"<label>","driveId":"<shared-drive-id>",
       "catalogConnectionId":"<conn>","writeConnectionId":"<conn>",
       "serviceAccountIds":["<sa-id>"],"visibility":"private"}'
```

`CreateMountRequestSchema` requires separate `catalogConnectionId` and
`writeConnectionId` (they may be the same connection row) and validates the
drive/connection targets and SA ids. Grant access per user via
`POST /api/v1/admin/mounts/:id/grants`.

## 8. Permission troubleshooting

| Symptom | Likely cause | Next action |
| --- | --- | --- |
| Google consent shows "unverified app" | App still in Testing | Expected in testing; publish + verify for production |
| `redirect_uri_mismatch` at Google | Registered URI ≠ canonical callback | Must equal `https://<your-worker-host>/api/v1/admin/google/oauth/callback` byte-exact; check the canonical origin from setup |
| Callback `400 VALIDATION_FAILED` "state unknown/expired/used" | State older than 10 min or replayed | Start `/oauth/start` again |
| Callback `403 FORBIDDEN` | Different admin session than the one that started | Finish the flow in the same browser session |
| Connection `needs_reauth`, calls return `GOOGLE_REAUTH_REQUIRED` | Testing-mode refresh token expired, grant revoked upstream, or required scope missing | Reconnect via `POST /oauth/start {purpose:"reconnect"}` |
| `FILE_NOT_ACCESSIBLE` on catalog/write | Operator lacks the Shared Drive role or file-level permission | Raise the operator's Shared Drive role |
| `FILE_NOT_READABLE_BY_POOL`, readiness `blocked` | SA not a member of the Shared Drive, or file download-restricted | Add the SA as Viewer; check `GET /api/v1/admin/diagnostics` SA cooldowns |
| `READ_PROVIDER_UNAVAILABLE` | Whole SA pool failing/cooling down | `GET /api/v1/admin/provider-health`; re-import a valid key, verify membership |
| `PROJECT_LIMITED` | GCP project quota exhausted | Check the project's Drive API quota (official docs linked above); the coordinator backs off automatically |
| `RATE_LIMITED` | Drive 403/429 rate limit | Honor `retryAfterSeconds`; reduce concurrency |
| Import SA → `400 VALIDATION_FAILED` | Wrong file or key not PKCS8 RSA | Re-download a JSON key from Google Cloud console |
| Key creation denied in console | Org policy blocks SA keys | Ask the org admin for an exemption (see §6) |

See [troubleshooting.md](troubleshooting.md) for the full error-code table
and [operations.md](operations.md) for diagnostics and maintenance tooling.
