-- 0007 My Drive folder mounts (spec 2026-10-18 §2).
--
-- SQLite cannot drop NOT NULL, so `mounts` is rebuilt: drive_id becomes
-- nullable (NULL = My Drive folder mount) and root_folder_id is added
-- (Shared Drive mounts: root_folder_id = drive_id, enforced by CHECK).
-- Seven child tables reference mounts(id); defer_foreign_keys keeps the
-- DROP/RENAME from tripping immediate FK checks, and the final `off`
-- clears the deferred counter. tests/integration/migration-0007.test.ts
-- proves every child row still resolves (PRAGMA foreign_key_check).
PRAGMA defer_foreign_keys = on;

CREATE TABLE mounts_new (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  drive_id TEXT,
  root_folder_id TEXT NOT NULL,
  catalog_connection_id TEXT NOT NULL REFERENCES google_connections (id),
  write_connection_id TEXT NOT NULL REFERENCES google_connections (id),
  read_pool_version INTEGER NOT NULL DEFAULT 1,
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'public_read')),
  policy_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (drive_id IS NULL OR drive_id = root_folder_id)
);

INSERT INTO mounts_new (
  id, label, drive_id, root_folder_id, catalog_connection_id,
  write_connection_id, read_pool_version, visibility, policy_version,
  created_at, updated_at
)
SELECT
  id, label, drive_id, drive_id, catalog_connection_id,
  write_connection_id, read_pool_version, visibility, policy_version,
  created_at, updated_at
FROM mounts;

DROP TABLE mounts;
ALTER TABLE mounts_new RENAME TO mounts;

CREATE INDEX IF NOT EXISTS mounts_drive_id_idx ON mounts (drive_id);
CREATE INDEX IF NOT EXISTS mounts_root_folder_id_idx ON mounts (root_folder_id);

-- App-managed SA reader permissions on a My Drive mount root (spec §2.2,
-- §5). permission_id is the Drive permission the app created or adopted;
-- last_error_code holds a stable code only (e.g. grant:rate_limited).
CREATE TABLE IF NOT EXISTS mount_drive_permissions (
  mount_id TEXT NOT NULL REFERENCES mounts (id),
  service_account_id TEXT NOT NULL REFERENCES service_accounts (id),
  permission_id TEXT,
  state TEXT NOT NULL
    CHECK (state IN ('pending', 'granted', 'revoking', 'failed')),
  last_error_code TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (mount_id, service_account_id)
);
CREATE INDEX IF NOT EXISTS mount_drive_permissions_sa_idx
  ON mount_drive_permissions (service_account_id);

PRAGMA defer_foreign_keys = off;
