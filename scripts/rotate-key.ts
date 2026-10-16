/**
 * rotate-key — drive a master-key rotation against a running Worker.
 * Default: dry-run printing the runbook. --execute performs the HTTP steps
 * against --url (default http://localhost:8787) with admin credentials.
 * Usage: node scripts/rotate-key.ts [--execute --url URL --email E --password P]
 *        [--generate] (print a fresh APP_MASTER_KEY_NEXT value)
 */
import { randomBytes } from 'node:crypto';
import { flag, has, isValidKey, parseArgs, fail } from './lib/common.ts';

const HELP = `rotate-key — orchestrate APP_MASTER_KEY rotation via the admin API.
Options:
  --generate            print a fresh 32-byte base64 key for APP_MASTER_KEY_NEXT
  --execute             perform the steps (otherwise a dry-run plan is printed)
  --url URL             worker origin (default http://localhost:8787)
  --email E --password P admin credentials used for sign-in
  --yes                 required with --execute when --url is not loopback
  --help`;

const args = parseArgs(process.argv.slice(2), ['help', 'execute', 'url', 'email', 'password', 'generate', 'local', 'dry-run', 'yes']);
if (has(args, 'help')) { console.log(HELP); process.exit(0); }

if (has(args, 'generate')) {
  console.log(`APP_MASTER_KEY_NEXT=${randomBytes(32).toString('base64')}`);
  process.exit(0);
}

const url = (flag(args, 'url') || 'http://localhost:8787').replace(/\/+$/, '');
try { new URL(url); } catch { fail('--url is not a valid URL'); }
if (!url.startsWith('http://localhost') && !url.startsWith('http://127.0.0.1') && !url.startsWith('https://')) {
  fail('--url must be loopback http or https');
}

const steps = [
  '1. Set APP_MASTER_KEY_NEXT=<new key> in .dev.vars (local) or worker secrets, restart the worker.',
  '2. Sign in as admin; POST /api/v1/admin/maintenance/rotation/start',
  '3. POST /api/v1/admin/maintenance/rotation/step  (repeat until phase=verifying)',
  '4. POST /api/v1/admin/maintenance/rotation/verify (must return ok)',
  '5. POST /api/v1/admin/maintenance/rotation/complete (revokes sessions/tickets)',
  '6. Promote: set APP_MASTER_KEY=<new key>, remove APP_MASTER_KEY_NEXT, redeploy.',
];

if (!has(args, 'execute')) {
  console.log('dry-run — rotation plan:');
  for (const s of steps) console.log(`  ${s}`);
  console.log(`\ntarget: ${url}`);
  console.log('generate a key first: node scripts/rotate-key.ts --generate');
  process.exit(0);
}

const email = flag(args, 'email'); const password = flag(args, 'password');
if (!email || !password) fail('--email and --password are required with --execute');

// Same confirmation gate the other ops scripts use: --execute against a
// non-loopback target mutates remote state and must be confirmed.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
if (!LOOPBACK_HOSTS.has(new URL(url).hostname) && !has(args, 'yes')) {
  fail('remote --execute requires --yes; this wave never mutates remote state unprompted');
}

const login = await fetch(`${url}/api/auth/sign-in/email`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
});
if (!login.ok) fail(`admin sign-in failed: HTTP ${login.status}`);
const cookie = (login.headers.getSetCookie?.() ?? []).find((c) => c.includes('session_token='));
if (!cookie) fail('sign-in returned no session cookie');

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${url}/api/v1/admin/maintenance${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookie.split(';')[0]! },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) fail(`${path} failed: HTTP ${res.status} ${JSON.stringify(json)}`);
  return json as Record<string, unknown>;
};

console.log('start:', JSON.stringify(await post('/rotation/start', {})));
for (let i = 0; i < 1000; i++) {
  const r = (await post('/rotation/step', { batchSize: 200 })) as { step: { phase: string; remaining: boolean } };
  console.log(`step ${i + 1}: ${r.step.phase}`);
  if (r.step.phase === 'verifying') break;
  // A failed run can never reach 'verifying' — stop instead of stepping
  // another 999 times (W4-R1 #7).
  if (r.step.phase === 'failed') {
    fail('rotation entered phase=failed; inspect last_error via /status, fix the row, then re-step');
  }
}
console.log('verify:', JSON.stringify(await post('/rotation/verify', {})));
console.log('complete:', JSON.stringify(await post('/rotation/complete', {})));
console.log('Now promote APP_MASTER_KEY to the NEXT value and remove APP_MASTER_KEY_NEXT.');
