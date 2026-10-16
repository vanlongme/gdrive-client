-- T14 maintenance: singleton maintenance/rotation state (checked by the
-- ProjectCoordinator admission gate) and owner-issued one-use admin recovery
-- tokens stored only as SHA-256 hashes.
CREATE TABLE maintenance_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  mode TEXT NOT NULL DEFAULT 'off',
  phase TEXT NOT NULL DEFAULT 'idle',
  from_key_label TEXT,
  to_key_label TEXT,
  checkpoint TEXT NOT NULL DEFAULT '{}',
  processed_count INTEGER NOT NULL DEFAULT 0,
  verified_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);

CREATE TABLE admin_recovery_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX admin_recovery_tokens_expires_idx ON admin_recovery_tokens (expires_at);
