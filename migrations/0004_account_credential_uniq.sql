-- Drive Worker v1 - credential account uniqueness fence (wave-2 track A).
-- Forward-only; applied by the same D1 migration authority as 0001.
--
-- The Better Auth "account" table has no uniqueness on (providerId,
-- accountId). The resumable setup flow converges an existing user by
-- re-linking a credential account when none exists yet; two concurrent
-- resumes could otherwise both insert a credential row. This index makes
-- the second insert fail atomically, after which the loser re-reads and
-- verifies the persisted credential instead of duplicating it. It also
-- prevents any future duplicate provider-account links.
CREATE UNIQUE INDEX IF NOT EXISTS account_provider_account_uidx
  ON "account" ("providerId", "accountId");
