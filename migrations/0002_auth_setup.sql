-- Drive Worker v1 - T03 setup/auth schema additions (spec section 9.1,
-- plan T03, wave-2 track A). Forward-only; applied by the same D1 migration
-- authority as 0001 (wrangler / applyD1Migrations).
--
-- The "rateLimit" table DDL below is emitted verbatim by the pinned
-- better-auth@1.7.7 migration tooling (getMigrations + compileMigrations on
-- node:sqlite, options: emailAndPassword + admin() plugin +
-- rateLimit.storage='database'), with IF NOT EXISTS added. It backs
-- Better Auth's durable login/sign-in rate limiting so throttling survives
-- isolate restarts. Table/column casing is owned by the library; do not
-- rename.

CREATE TABLE IF NOT EXISTS "rateLimit" (
  "id" text not null primary key,
  "key" text not null unique,
  "count" integer not null,
  "lastRequest" bigint not null
);

-- Bounded setup-token attempts (architecture 9.1): the setup claim route
-- counts consecutive failures here and locks briefly, so an attacker cannot
-- brute-force SETUP_TOKEN at line rate even while setup is unclaimed.
CREATE TABLE IF NOT EXISTS setup_throttle (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER,
  updated_at INTEGER NOT NULL
);

-- Single-owner resumable setup: the winning claim records the admin identity
-- being created so a crash between claim and completion resumes the SAME
-- admin instead of minting a second one. Cleared on completion.
ALTER TABLE app_settings ADD COLUMN setup_pending_email TEXT;
ALTER TABLE app_settings ADD COLUMN setup_pending_name TEXT;
