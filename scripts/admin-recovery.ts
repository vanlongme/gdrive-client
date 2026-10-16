/**
 * admin-recovery — issue a one-use admin recovery token (owner runbook).
 * Default: dry-run printing the token + the exact SQL to store its hash.
 * --execute inserts the hash into LOCAL D1 via wrangler.
 * Remote printing only; remote mutation is refused in this wave.
 * Usage: node scripts/admin-recovery.ts [--ttl-minutes N] [--execute|--remote]
 */
import { createHash, randomBytes } from 'node:crypto';
import { flag, has, parseArgs, plan, runWrangler, fail } from './lib/common.ts';

const HELP = `admin-recovery — issue a one-use recovery token for a locked-out admin.
Options: --ttl-minutes N (default 60, max 120), --execute (insert into local D1),
         --remote (print the SQL; remote writes are refused in this wave), --help
Claim flow: POST /api/v1/admin/maintenance/recovery/claim {token,email,newPassword}`;

const args = parseArgs(process.argv.slice(2), ['help', 'ttl-minutes', 'execute', 'remote', 'local', 'dry-run']);
if (has(args, 'help')) { console.log(HELP); process.exit(0); }

const ttlMin = Number(flag(args, 'ttl-minutes') ?? '60');
if (!Number.isInteger(ttlMin) || ttlMin < 1 || ttlMin > 120) fail('--ttl-minutes must be an integer in [1,120]');

const token = `grt_${randomBytes(32).toString('base64url')}`;
const hash = createHash('sha256').update(`admin-recovery:${token}`).digest('hex');
const id = crypto.randomUUID();
const expiresAt = Date.now() + ttlMin * 60_000;
const sql =
  `INSERT INTO admin_recovery_tokens (id, token_hash, expires_at, created_at) ` +
  `VALUES ('${id}', '${hash}', ${expiresAt}, ${Date.now()});`;

console.log(`token (show once, never stored): ${token}`);
console.log(`expires: ${new Date(expiresAt).toISOString()}`);
console.log(`sql: ${sql}`);

if (has(args, 'remote')) {
  console.log('remote writes are refused in this wave — run the SQL via the Cloudflare dashboard/wrangler yourself.');
  process.exit(0);
}
if (!has(args, 'execute')) {
  console.log('dry-run — would run:');
  plan(['npx', 'wrangler', 'd1', 'execute', 'DB', '--local', '--command', sql]);
  process.exit(0);
}
const rc = runWrangler(['d1', 'execute', 'DB', '--local', '--command', sql]);
if (rc === 0) console.log('token issued — the claim endpoint can consume it once.');
process.exit(rc);
