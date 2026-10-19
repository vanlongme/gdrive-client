/**
 * import-service-accounts — bulk-import service-account key JSON files into a
 * deployed instance through the admin API (POST /api/v1/admin/service-accounts).
 *
 * Signs in once with the admin email/password (the password is read from the
 * terminal with echo disabled and never stored or printed), then posts every
 * *.json key in --dir. Keys are sealed server-side; this script never prints
 * key material. With --delete-imported, a local key file is removed only after
 * the server confirmed that key.
 *
 * Usage:
 *   node scripts/import-service-accounts.ts --origin https://app.example \
 *     --dir ~/.config/gdrive-client/sa-keys [--email admin@example.com] \
 *     [--delete-imported] [--dry-run]
 */
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { fail, flag, has, parseArgs } from './lib/common.ts';

const HELP = `import-service-accounts — bulk-import SA key JSON files via the admin API.
Options: --origin URL (canonical origin), --dir DIR (*.json keys), [--email ADMIN_EMAIL] (prompted if omitted),
         --delete-imported (remove each local key after the server accepted it),
         --dry-run (validate files only), --help`;

const args = parseArgs(process.argv.slice(2), ['help', 'origin', 'dir', 'email', 'delete-imported', 'dry-run']);
if (has(args, 'help')) { console.log(HELP); process.exit(0); }

const origin = flag(args, 'origin');
const dirArg = flag(args, 'dir');
const emailArg = flag(args, 'email');
if (!origin || !dirArg) fail('--origin and --dir are required (see --help)');
let base: URL;
try { base = new URL(origin); } catch { fail('--origin must be an absolute URL'); }
if (base.protocol !== 'https:' && base.hostname !== 'localhost') fail('--origin must be https (or localhost)');
const canonical = base.origin;
const dir = resolve(dirArg.replace(/^~(?=\/)/, process.env.HOME ?? '~'));

interface KeyFile { path: string; clientEmail: string; text: string }

function loadKeys(): KeyFile[] {
  const out: KeyFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const path = join(dir, name);
    if (!statSync(path).isFile()) continue;
    const text = readFileSync(path, 'utf8');
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { console.error(`skip ${name}: not JSON`); continue; }
    const rec = parsed as Record<string, unknown>;
    if (rec.type !== 'service_account' || typeof rec.client_email !== 'string' || typeof rec.private_key !== 'string') {
      console.error(`skip ${name}: not a service-account key`);
      continue;
    }
    out.push({ path, clientEmail: rec.client_email, text });
  }
  return out;
}

/** Read a visible line from the terminal. */
function readLine(prompt: string): Promise<string> {
  return new Promise((resolvePromise) => {
    stdout.write(prompt);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.once('data', (chunk: string) => { stdin.pause(); resolvePromise(chunk.trim()); });
  });
}

/** Read a line from the TTY without echoing it. */
function readHidden(prompt: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    if (!stdin.isTTY) { reject(new Error('a TTY is required to read the password')); return; }
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData); stdout.write('\n');
          resolvePromise(value); return;
        }
        if (ch === '\u0003') { stdin.setRawMode(false); stdout.write('\n'); process.exit(130); }
        if (ch === '\u007f' || ch === '\b') { value = value.slice(0, -1); continue; }
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

function cookieHeader(res: Response): string {
  const cookies = res.headers.getSetCookie().map((c) => c.split(';')[0] ?? '').filter(Boolean);
  return cookies.join('; ');
}

async function main(): Promise<void> {
  const keys = loadKeys();
  console.log(`${keys.length} service-account key file(s) in ${dir}`);
  if (keys.length === 0) process.exit(1);
  if (has(args, 'dry-run')) { for (const k of keys) console.log(`  would import ${k.clientEmail}`); return; }

  const email = emailArg ?? (await readLine('Admin email: '));
  if (email === '') fail('admin email is required', 1);
  const password = await readHidden(`Admin password for ${email}: `);
  const signIn = await fetch(new URL('/api/auth/sign-in/email', canonical), {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: canonical },
    body: JSON.stringify({ email, password }),
    redirect: 'manual',
  });
  const cookie = cookieHeader(signIn);
  if (!signIn.ok || cookie === '') fail(`sign-in failed (HTTP ${signIn.status})`, 1);

  const results: string[] = ['client_email,service_account_id,status'];
  let ok = 0;
  for (const key of keys) {
    const res = await fetch(new URL('/api/v1/admin/service-accounts', canonical), {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: canonical, cookie },
      body: JSON.stringify({ keyJson: key.text }),
      redirect: 'manual',
    });
    const body = (await res.json().catch(() => ({}))) as {
      serviceAccount?: { id?: string };
      error?: { code?: string };
    };
    if (res.ok && body.serviceAccount?.id) {
      ok += 1;
      results.push(`${key.clientEmail},${body.serviceAccount.id},imported`);
      console.log(`  ok   ${key.clientEmail}`);
      if (has(args, 'delete-imported')) rmSync(key.path);
    } else {
      results.push(`${key.clientEmail},,${body.error?.code ?? `HTTP_${res.status}`}`);
      console.log(`  FAIL ${key.clientEmail}: ${body.error?.code ?? `HTTP ${res.status}`}`);
    }
  }
  const report = join(dir, 'import-report.csv');
  writeFileSync(report, `${results.join('\n')}\n`, { mode: 0o600 });
  console.log(`${ok}/${keys.length} imported; report (ids only, no secrets): ${report}`);
  process.exit(ok === keys.length ? 0 : 1);
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err), 1));
