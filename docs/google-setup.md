# Google setup

How to prepare the Google-side resources Drive Worker needs: one OAuth Web
client for the operator account, one or more service accounts for the
content-read pool, and a place both can reach: a Shared Drive, or (personal
Gmail accounts with no Shared Drive) a folder the operator owns in My Drive
(section 5a).

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

A mount is either a whole Shared Drive or one folder in the operator's My
Drive (section 5a). This section covers Shared Drive mounts. The mount's
root is `rootFolderId`; for a Shared Drive it equals the drive id, and the
older `driveId` request field is still accepted as an alias.

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

## 5a. My Drive folder mounts *(external step requiring authorization)*

Use this when the operator account is a personal Gmail account (no Workspace,
no Shared Drives). The mount covers one folder you own and everything inside
it. Shared Drive mounts are unaffected.

**Requirements (checked at creation):**

- The folder is owned by the Google account behind **both** the catalog and the
  write connection, so both connections must belong to the same account
  (`MOUNT_ROOT_NOT_OWNED` / `MOUNT_WRITER_MISMATCH` otherwise).
- It is a real, untrashed folder the account can add files to
  (`MOUNT_ROOT_NOT_FOLDER`, `MOUNT_ROOT_TRASHED`, `MOUNT_ROOT_NOT_WRITABLE`).
- It is not the My Drive root (`MOUNT_ROOT_IS_MY_DRIVE`). Folders only *shared
  with* the operator cannot be mounted.

**Steps:**

1. In Google Drive, create the folder. The app cannot create folders; create it
   in Drive, then press **Refresh** in the app's folder browser.
2. **Admin > Mounts**: pick the catalog and write connections. If the catalog
   connection lists zero Shared Drives the **My Drive folder** tab is
   preselected; otherwise click it. Browse to the folder (only folders the
   account owns are listed) or paste a link: `drive.google.com/drive/folders/<id>`,
   `.../drive/u/<n>/folders/<id>?usp=sharing`, `.../open?id=<id>` or the bare
   id. A Google Docs or file link is refused in the form; a file id typed as a
   bare id is refused by the server with `MOUNT_ROOT_NOT_FOLDER`.
3. Select the read-pool service accounts and create the mount. The app grants
   each of them **Viewer** on the folder (below) without any notification
   e-mail (`sendNotificationEmail=false`).
4. Watch **Pool read access N/M** (`M` = pool size, `N` = accounts whose
   grant is confirmed). Press **Sync access** after changing the pool; **Check**
   asks Drive, as that service account, whether it can see the folder.

**How the pool access works.** For a Shared Drive an administrator adds each
service account as a member. For a My Drive folder the app does it with the
operator's OAuth token (the already requested `https://www.googleapis.com/auth/drive`
scope covers `permissions.*`; service accounts still use `drive.readonly` only):

- `POST /api/v1/admin/mounts/:id/read-grants/sync` makes at most 20 permission
  changes per call and answers `{remaining, ready, total, grants,
  retryAfterSeconds?}`; the UI repeats it until `remaining` is 0. Re-running is
  safe: an account that already has access is adopted, never granted twice.
  `POST .../read-grants/:serviceAccountId/probe` answers `ok` or
  `grant:not_visible`. On a Shared Drive mount both answer
  `409 MOUNT_KIND_UNSUPPORTED`.
- Google may rate-limit sharing on consumer accounts (see
  <https://developers.google.com/drive/api/guides/limits>). The call then stops,
  the account stays pending with `grant:rate_limited`, and `retryAfterSeconds`
  tells the UI how long to wait, so a first sync of a large pool (for example
  90 accounts) can take several rounds.
- Removing an account from the pool revokes only a permission this app created;
  permissions you added by hand in the Drive sharing dialog are never deleted.
- Mount creation by API (admin session, local example; an external/remote step
  against a real deployment):

  ```sh
  curl -X POST http://localhost:8787/api/v1/admin/mounts \
    -H 'content-type: application/json' -H "cookie: $COOKIE" \
    -d '{"label":"<label>","rootFolderId":"<folder-id>",
         "catalogConnectionId":"<conn>","writeConnectionId":"<conn>",
         "serviceAccountIds":["<sa-id>"],"visibility":"private"}'
  ```

**Limits you should know about:**

- **Containment.** Membership of a file is decided by walking its parent chain
  up to the mounted folder through the operator's OAuth connection (at most 32
  levels). A service account being able to read a file proves nothing, because
  anyone can share an unrelated file with its address; such a file is still
  refused as not accessible. If the chain cannot be proven the request is
  denied; there is no fallback to the other provider.
- **60-second window.** Parent lookups are cached per Worker isolate for 60
  seconds. A folder moved into or out of the mounted folder in the Drive web UI
  is noticed after at most that long. Folder creates and trashing done through
  the app drop the affected folder's cached verdict immediately, but every
  other cached verdict — including descendants of a changed folder — lives out
  its TTL, so any change can take up to 60 seconds to be fully reflected.
- **Ownership dependency.** If the owning account is disconnected, loses the
  folder or needs re-authentication, the mount stops working (fails closed).
- **Storage quota.** Uploaded files are owned by the operator, so they count
  against that account's personal Google storage. A quota failure during an
  upload marks it blocked with `upload:quota_exceeded`; a synchronous quota
  failure answers `507 STORAGE_FULL`.
- **Not supported:** mounting the My Drive root, folders owned by someone else,
  sub-folder mounts inside a Shared Drive, and changing a mount's root or kind
  after creation (create a new mount).

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

For My Drive folders the mount form has a second source tab. Its browser calls
`GET /api/v1/admin/drive-folders?connectionId=<conn>&parentId=root|<folder-id>&pageToken=<token>`
(`src/worker/admin/drive-folders-routes.ts`), which lists one level of
non-trashed folders **owned by the connection's account** through the same
OAuth catalog identity, returning only `{id, name}` and an opaque
`nextPageToken`. A pasted link is parsed in the browser into a folder id
(`src/web/lib/drive-link.ts`) and is never fetched; the server revalidates the
id on submit.

Equivalent API call (admin session, local example):

```sh
curl -X POST http://localhost:8787/api/v1/admin/mounts \
  -H 'content-type: application/json' -H "cookie: $COOKIE" \
  -d '{"label":"<label>","rootFolderId":"<shared-drive-id>",
       "catalogConnectionId":"<conn>","writeConnectionId":"<conn>",
       "serviceAccountIds":["<sa-id>"],"visibility":"private"}'
```

(use `"driveId"` for the legacy form)

`CreateMountRequestSchema` takes `rootFolderId` (or the legacy `driveId`
alias; sending both with different values is a 400), requires separate
`catalogConnectionId` and `writeConnectionId` (they may be the same
connection row) and validates the drive/connection targets and SA ids.
Grant access per user via `POST /api/v1/admin/mounts/:id/grants`.

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
| `MOUNT_ROOT_NOT_FOLDER` on create | The id or link is a file, a Docs document, or does not exist for this connection | Pick a folder in the browser, or paste a folder link |
| `MOUNT_ROOT_NOT_OWNED` / `MOUNT_WRITER_MISMATCH` on create | The folder is not owned by the connection's account, or the catalog and write connections are different accounts | Use one connection (or two for the same account) and a folder that account owns |
| `MOUNT_ROOT_IS_MY_DRIVE` / `MOUNT_ROOT_TRASHED` / `MOUNT_ROOT_NOT_WRITABLE` | Whole My Drive chosen, folder in the trash, or the write account cannot add files | Choose a normal folder; restore it; check the account's edit access |
| Pool read access stays below N/M | Sync not run since the pool changed, `grant:rate_limited`, or `grant:forbidden` | Press **Sync access**; wait out `retryAfterSeconds`; for `grant:forbidden` confirm the operator owns the folder |
| **Check** reports `grant:not_visible` | The permission is not on the folder yet, or was removed in the Drive sharing dialog | Press **Sync access**, then **Check** again |
| File opens for one service account in Drive but the app says not accessible | The file is outside the mounted folder (containment), or the folder was moved less than 60 s ago | Move it inside the mounted folder; wait up to 60 s after an external move |
| `upload:quota_exceeded` | The folder owner's personal Google storage is full | Free space or raise storage on that account; retry the upload |

See [troubleshooting.md](troubleshooting.md) for the full error-code table
and [operations.md](operations.md) for diagnostics and maintenance tooling.
