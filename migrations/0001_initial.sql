-- Drive Worker v1 - initial D1 schema (spec section 10.1, plan T02).
-- Forward-only migration; applied by `wrangler d1 migrations apply` (local
-- via `npm run db:migrations:local`), which records progress in the
-- d1_migrations table. The same files are applied inside Workers tests via
-- the official applyD1Migrations() helper.
--
-- Auth tables below are byte-for-byte the DDL emitted by the pinned
-- better-auth@1.7.7 migration tooling (getMigrations + runMigrations on a
-- real sqlite database, core models + admin plugin), with IF NOT EXISTS
-- added so a migration can be re-checked on an already-migrated database
-- without failing. Column types, names and indexes are unchanged. Dates are
-- stored by Better Auth as ISO text in `date`-typed columns; do not change
-- to INTEGER.

CREATE TABLE IF NOT EXISTS "user" (
  "id" text not null primary key,
  "name" text not null,
  "email" text not null unique,
  "emailVerified" integer not null,
  "image" text,
  "createdAt" date not null,
  "updatedAt" date not null,
  "role" text,
  "banned" integer,
  "banReason" text,
  "banExpires" date
);

CREATE TABLE IF NOT EXISTS "session" (
  "id" text not null primary key,
  "expiresAt" date not null,
  "token" text not null unique,
  "createdAt" date not null,
  "updatedAt" date not null,
  "ipAddress" text,
  "userAgent" text,
  "userId" text not null references "user" ("id") on delete cascade,
  "impersonatedBy" text
);

CREATE TABLE IF NOT EXISTS "account" (
  "id" text not null primary key,
  "accountId" text not null,
  "providerId" text not null,
  "userId" text not null references "user" ("id") on delete cascade,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" date,
  "refreshTokenExpiresAt" date,
  "scope" text,
  "password" text,
  "createdAt" date not null,
  "updatedAt" date not null
);

CREATE TABLE IF NOT EXISTS "verification" (
  "id" text not null primary key,
  "identifier" text not null,
  "value" text not null,
  "expiresAt" date not null,
  "createdAt" date not null,
  "updatedAt" date not null
);

CREATE INDEX IF NOT EXISTS "account_userId_idx" on "account" ("userId");
CREATE INDEX IF NOT EXISTS "session_userId_idx" on "session" ("userId");
CREATE INDEX IF NOT EXISTS "verification_identifier_idx" on "verification" ("identifier");

-- ---------------------------------------------------------------------------
-- Application tables (snake_case). Timestamps are INTEGER unix milliseconds.
-- Sizes/offsets that cross the API are decimal strings and are stored as TEXT
-- so values above Number.MAX_SAFE_INTEGER keep full precision.
-- ---------------------------------------------------------------------------

-- Singleton settings row; id is locked to 1.
CREATE TABLE IF NOT EXISTS app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  installation_id TEXT,
  setup_state TEXT NOT NULL DEFAULT 'uninitialized'
    CHECK (setup_state IN ('uninitialized', 'in_progress', 'complete')),
  setup_owner TEXT,
  canonical_origin TEXT,
  theme TEXT NOT NULL DEFAULT 'system'
    CHECK (theme IN ('system', 'light', 'dark')),
  default_locale TEXT NOT NULL DEFAULT 'vi',
  policies TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS service_accounts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  email TEXT NOT NULL,
  key_id TEXT NOT NULL,
  envelope TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, email)
);

CREATE TABLE IF NOT EXISTS google_oauth_clients (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  secret_envelope TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS google_connections (
  id TEXT PRIMARY KEY,
  oauth_client_id TEXT NOT NULL REFERENCES google_oauth_clients (id),
  principal_id TEXT NOT NULL,
  display_email TEXT,
  refresh_envelope TEXT,
  granted_scopes TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'connected'
    CHECK (state IN ('connected', 'degraded', 'needs_reauth', 'disabled')),
  enabled INTEGER NOT NULL DEFAULT 1,
  version INTEGER NOT NULL DEFAULT 1,
  connected_by TEXT REFERENCES "user" (id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (oauth_client_id, principal_id)
);

CREATE TABLE IF NOT EXISTS oauth_transactions (
  id TEXT PRIMARY KEY,
  state_hash TEXT NOT NULL UNIQUE,
  admin_session_id TEXT NOT NULL,
  installation_id TEXT NOT NULL,
  oauth_client_id TEXT NOT NULL REFERENCES google_oauth_clients (id),
  client_version INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('connect', 'reconnect')),
  target_connection_id TEXT REFERENCES google_connections (id),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_transactions_expires_at_idx
  ON oauth_transactions (expires_at);

CREATE TABLE IF NOT EXISTS mounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  drive_id TEXT NOT NULL,
  catalog_connection_id TEXT NOT NULL REFERENCES google_connections (id),
  write_connection_id TEXT NOT NULL REFERENCES google_connections (id),
  read_pool_version INTEGER NOT NULL DEFAULT 1,
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'public_read')),
  policy_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS mounts_drive_id_idx ON mounts (drive_id);

CREATE TABLE IF NOT EXISTS mount_read_credentials (
  mount_id TEXT NOT NULL REFERENCES mounts (id),
  service_account_id TEXT NOT NULL REFERENCES service_accounts (id),
  priority INTEGER NOT NULL DEFAULT 0,
  weight INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (mount_id, service_account_id)
);
CREATE INDEX IF NOT EXISTS mount_read_credentials_sa_idx
  ON mount_read_credentials (service_account_id);

CREATE TABLE IF NOT EXISTS mount_grants (
  user_id TEXT NOT NULL REFERENCES "user" (id),
  mount_id TEXT NOT NULL REFERENCES mounts (id),
  role TEXT NOT NULL CHECK (role IN ('viewer', 'uploader')),
  operations TEXT NOT NULL DEFAULT '[]',
  granted_by TEXT REFERENCES "user" (id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, mount_id)
);
CREATE INDEX IF NOT EXISTS mount_grants_mount_idx ON mount_grants (mount_id);

-- Folder-upload batches. The sealed plan hash/version makes retry keep the
-- same parent-child relations; sealing is required before execution.
CREATE TABLE IF NOT EXISTS upload_batches (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES "user" (id),
  mount_id TEXT NOT NULL REFERENCES mounts (id),
  root_parent_id TEXT NOT NULL,
  idempotency_hash TEXT,
  input_hash TEXT,
  plan_hash TEXT,
  plan_version INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'draft'
    CHECK (state IN ('draft', 'sealed', 'executing', 'completed', 'failed', 'cancelled')),
  sealed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS upload_batches_owner_idempotency_idx
  ON upload_batches (owner_id, idempotency_hash)
  WHERE idempotency_hash IS NOT NULL;

-- Operation index + permanent idempotency tombstone. Rows are never deleted;
-- detail cleanup clears only transient progress fields (summary) and stamps
-- detail_purged_at. The final state, result, generated_file_id and pinned
-- identity are preserved for the installation lifetime so a replayed
-- (owner_id, idempotency_hash) still answers the original operation outcome
-- even after the Drive file is gone (spec 6.2/13).
-- Pinned writer columns are immutable identity snapshots, not FKs: they must
-- survive connection disable/recreate cycles and keep identifying the writer
-- chosen at init.
CREATE TABLE IF NOT EXISTS upload_operations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES "user" (id),
  mount_id TEXT NOT NULL REFERENCES mounts (id),
  batch_id TEXT REFERENCES upload_batches (id),
  node_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
  idempotency_hash TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  generated_file_id TEXT,
  pinned_oauth_connection_id TEXT NOT NULL,
  pinned_principal_id TEXT NOT NULL,
  pinned_oauth_client_id TEXT NOT NULL,
  pinned_project_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'created' CHECK (state IN (
    'created', 'preparing', 'uploading', 'paused', 'reconciling', 'verifying',
    'completed', 'cancel_requested', 'cancelled', 'expired', 'blocked',
    'conflict', 'cleanup_pending'
  )),
  result TEXT,
  summary TEXT,
  detail_purged_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  UNIQUE (owner_id, idempotency_hash)
);
CREATE INDEX IF NOT EXISTS upload_operations_mount_idx
  ON upload_operations (mount_id);
CREATE INDEX IF NOT EXISTS upload_operations_owner_created_idx
  ON upload_operations (owner_id, created_at);
CREATE INDEX IF NOT EXISTS upload_operations_generated_file_idx
  ON upload_operations (generated_file_id);

-- Batch nodes: stable opaque node_id keys, never display names. parent_node_id
-- references another node in the same batch (NULL = plan root).
CREATE TABLE IF NOT EXISTS upload_batch_nodes (
  batch_id TEXT NOT NULL REFERENCES upload_batches (id),
  node_id TEXT NOT NULL,
  parent_node_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('folder', 'file')),
  display_name TEXT NOT NULL,
  mime_type TEXT,
  total_bytes TEXT,
  operation_id TEXT REFERENCES upload_operations (id),
  drive_file_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (batch_id, node_id),
  FOREIGN KEY (batch_id, parent_node_id)
    REFERENCES upload_batch_nodes (batch_id, node_id)
);
CREATE INDEX IF NOT EXISTS upload_batch_nodes_parent_idx
  ON upload_batch_nodes (batch_id, parent_node_id);

-- SA readability projection; independent of upload state and re-verified per
-- content request.
CREATE TABLE IF NOT EXISTS file_readiness (
  mount_id TEXT NOT NULL REFERENCES mounts (id),
  file_id TEXT NOT NULL,
  reader_access_state TEXT NOT NULL DEFAULT 'unchecked'
    CHECK (reader_access_state IN ('unchecked', 'pending', 'readable', 'blocked')),
  read_pool_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  checked_at INTEGER,
  reason TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (mount_id, file_id)
);

CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES "user" (id),
  scope_kind TEXT NOT NULL CHECK (scope_kind IN ('mount', 'file', 'package')),
  mount_id TEXT REFERENCES mounts (id),
  file_id TEXT,
  package_id TEXT,
  revision_id TEXT,
  index_generation INTEGER,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  policy_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS share_links_expires_at_idx
  ON share_links (expires_at);
CREATE INDEX IF NOT EXISTS share_links_scope_idx
  ON share_links (scope_kind, mount_id, file_id);

CREATE TABLE IF NOT EXISTS media_packages (
  id TEXT PRIMARY KEY,
  mount_id TEXT NOT NULL REFERENCES mounts (id),
  entry_file_id TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES "user" (id),
  state TEXT NOT NULL DEFAULT 'preparing'
    CHECK (state IN ('preparing', 'ready', 'failed')),
  index_generation INTEGER NOT NULL DEFAULT 0,
  ready_generation INTEGER,
  scan_cursor TEXT,
  scan_cursor_version INTEGER NOT NULL DEFAULT 1,
  dependency_versions TEXT NOT NULL DEFAULT '{}',
  strict_snapshot INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (mount_id, entry_file_id)
);

-- Resources are pinned to a fully prepared generation; a new generation writes
-- new rows and publication flips ready_generation, so readers never mix
-- generations.
CREATE TABLE IF NOT EXISTS media_package_resources (
  package_id TEXT NOT NULL REFERENCES media_packages (id),
  index_generation INTEGER NOT NULL,
  resource_id TEXT NOT NULL,
  path TEXT NOT NULL,
  file_id TEXT NOT NULL,
  revision_id TEXT,
  kind TEXT NOT NULL DEFAULT 'resource'
    CHECK (kind IN ('playlist', 'segment', 'init', 'audio', 'subtitle', 'resource')),
  byte_length TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (package_id, index_generation, resource_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS media_package_resources_path_idx
  ON media_package_resources (package_id, index_generation, path);

-- Retention target: 30 days, pruned in batches (spec section 13).
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor_kind TEXT NOT NULL CHECK (actor_kind IN ('user', 'share', 'public', 'system')),
  actor_user_id TEXT REFERENCES "user" (id),
  actor_share_id TEXT REFERENCES share_links (id),
  google_principal_id TEXT,
  provider TEXT CHECK (provider IN ('oauth', 'service_account')),
  operation TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  result TEXT NOT NULL,
  request_id TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_events_created_at_idx
  ON audit_events (created_at);
CREATE INDEX IF NOT EXISTS audit_events_request_id_idx
  ON audit_events (request_id);
CREATE INDEX IF NOT EXISTS audit_events_actor_idx
  ON audit_events (actor_user_id, created_at);
