/**
 * Optional secrets that `wrangler types` cannot express: it only emits
 * `secrets.required`, and APP_MASTER_KEY_NEXT must stay optional (staged only
 * during a key rotation; see docs/operations.md). The generated file declares
 * the global `Env` and `Cloudflare.Env` separately, so both are augmented.
 */
interface OptionalSecrets {
  APP_MASTER_KEY_NEXT?: string;
}

interface Env extends OptionalSecrets {}

declare namespace Cloudflare {
  interface Env extends OptionalSecrets {}
}
