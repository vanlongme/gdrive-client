-- Drive Worker v1 - OAuth transaction hardening (wave-2 coordinator decision,
-- approved C schema request). Forward-only.
--
-- redirect_uri: the exact callback URI bound to each OAuth state transaction.
-- Rows predating this column carry '' and MUST fail closed at callback time —
-- a transaction without a recorded redirect can never validate.
-- pkce_envelope: AES-256-GCM envelope (vault purpose 'vault', kind
-- 'oauth-pkce-verifier') holding the S256 code verifier for the transaction.
ALTER TABLE oauth_transactions ADD COLUMN redirect_uri TEXT NOT NULL DEFAULT '';
ALTER TABLE oauth_transactions ADD COLUMN pkce_envelope TEXT;
