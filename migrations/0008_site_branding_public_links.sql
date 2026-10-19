-- 0008 site branding + public folder links (TinyOrbit redesign, plan
-- 2026-10-19 Phase B).
--
-- site_branding is a singleton (id = 1, same pattern as app_settings):
-- operator-supplied site title/tagline/welcome/support email plus an
-- optional logo blob served at /api/v1/site/logo. The row is created lazily
-- by PUT /api/v1/admin/site; reads before that serve the schema defaults.
CREATE TABLE site_branding (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  title TEXT NOT NULL DEFAULT 'Drive Worker',
  tagline TEXT NOT NULL DEFAULT '',
  welcome TEXT NOT NULL DEFAULT '',
  support_email TEXT,
  logo_mime TEXT,
  logo_data BLOB,
  logo_version INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES "user" (id)
);

-- public_folder_links: anonymous, revocable folder shares mounted under
-- /api/v1/p/<slug>. password_hash holds a PHC-style pbkdf2-sha256 record or
-- NULL for open links; credential_version invalidates issued unlock cookies
-- on password change. policy_version pins the mount policy observed at
-- creation (a bump invalidates the link, same rule as share_links).
CREATE TABLE public_folder_links (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  mount_id TEXT NOT NULL REFERENCES mounts (id),
  folder_id TEXT NOT NULL,
  folder_name TEXT NOT NULL,
  password_hash TEXT,
  credential_version INTEGER NOT NULL DEFAULT 1,
  allow_zip INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  policy_version INTEGER NOT NULL,
  created_by TEXT NOT NULL REFERENCES "user" (id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  view_count INTEGER NOT NULL DEFAULT 0,
  download_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX public_folder_links_mount_folder_idx
  ON public_folder_links (mount_id, folder_id);

-- At most one non-revoked link per (mount, folder): enforced by this partial
-- unique index so a concurrent second create also fails.
CREATE UNIQUE INDEX public_folder_links_active_folder_uq
  ON public_folder_links (mount_id, folder_id)
  WHERE revoked_at IS NULL;

-- Unlock-failure throttling per (slug, client IP): the key is a SHA-256 of
-- `v1|<slug>|<ip>` so no raw client address is persisted. A row appears only
-- after the first failure and is deleted on a successful unlock.
CREATE TABLE public_link_unlock_attempts (
  key TEXT PRIMARY KEY,
  failures INTEGER NOT NULL,
  window_started_at INTEGER NOT NULL,
  locked_until INTEGER,
  updated_at INTEGER NOT NULL
);

-- The per-request prune DELETE filters on updated_at; without this index it
-- scans the whole table on every unlock attempt (review R2c).
CREATE INDEX public_link_unlock_attempts_updated_idx
  ON public_link_unlock_attempts (updated_at);
