/**
 * doctor — local environment sanity checks (read-only).
 * Usage: node scripts/doctor.ts [--execute]
 *   --execute  also probe the local D1 via `wrangler d1 execute --local`.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { isValidKey, parseArgs, readDevVars, readJson, REPO_ROOT, runWrangler, fail } from './lib/common.ts';

const HELP = `doctor — check the local gdrive-client environment.
Options: --execute (run a local D1 probe), --help`;

const args = parseArgs(process.argv.slice(2), ['help', 'execute']);
if (args.flags.has('help')) { console.log(HELP); process.exit(0); }

let bad = 0;
const check = (ok: boolean, name: string, detail = '') => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) bad++;
};

const [maj] = process.versions.node.split('.').map(Number);
check((maj ?? 0) >= 24, 'node>=24', process.version);
check(existsSync(join(REPO_ROOT, 'node_modules', '.bin', 'wrangler')), 'wrangler installed');

const wrangler = readJson(join(REPO_ROOT, 'wrangler.jsonc'));
check(wrangler !== null, 'wrangler.jsonc parses');
const d1 = (wrangler?.d1_databases as { binding?: string }[] | undefined)?.[0]?.binding;
check(d1 === 'DB', 'd1 binding DB present', String(d1));

const migrations = existsSync(join(REPO_ROOT, 'migrations'))
  ? readdirSync(join(REPO_ROOT, 'migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()
  : [];
check(migrations.length >= 1, 'migrations present', `${migrations.length} file(s)`);
const seqOk = migrations.every((f, i) => f.startsWith(String(i + 1).padStart(4, '0')));
check(seqOk, 'migration numbering sequential');

const devVars = readDevVars(join(REPO_ROOT, '.dev.vars'));
if (devVars === null) {
  check(false, '.dev.vars present', 'missing — copy .dev.vars.example and fill both secrets');
} else {
  check(devVars.has('APP_MASTER_KEY') && isValidKey(devVars.get('APP_MASTER_KEY')!), 'APP_MASTER_KEY well-formed', devVars.has('APP_MASTER_KEY') ? 'set' : 'missing');
  check(devVars.has('SETUP_TOKEN') && isValidKey(devVars.get('SETUP_TOKEN')!), 'SETUP_TOKEN well-formed', devVars.has('SETUP_TOKEN') ? 'set' : 'missing');
  const next = devVars.get('APP_MASTER_KEY_NEXT');
  if (next !== undefined) check(isValidKey(next), 'APP_MASTER_KEY_NEXT well-formed (rotation only)');
}

if (args.flags.has('execute')) {
  const rc = runWrangler(['d1', 'execute', 'DB', '--local', '--command', 'SELECT 1']);
  check(rc === 0, 'local D1 reachable');
} else {
  console.log('dry  local D1 probe skipped (pass --execute to run it)');
}
process.exit(bad === 0 ? 0 : 1);
