/**
 * backup — export the D1 database to a timestamped SQL file.
 * Default: dry-run printing the plan. --execute runs against --local.
 * --remote exports the remote DB read-only (requires --yes).
 * Usage: node scripts/backup.ts [--out FILE] [--execute|--remote --yes]
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { flag, has, parseArgs, plan, requireLocalOrDryRun, runWrangler, fail, REPO_ROOT } from './lib/common.ts';

const HELP = `backup — export D1 to a SQL dump.
Options: --out FILE (default backups/drive-worker-<ts>.sql), --execute (local), --remote --yes (remote, read-only export), --help`;

const args = parseArgs(process.argv.slice(2), ['help', 'out', 'execute', 'remote', 'yes', 'local', 'dry-run']);
if (has(args, 'help')) { console.log(HELP); process.exit(0); }

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const out = resolve(REPO_ROOT, flag(args, 'out') || `backups/drive-worker-${stamp}.sql`);
if (!out.endsWith('.sql')) fail('--out must be a .sql file');

const mode = requireLocalOrDryRun(args, 'export');
const cmd = ['d1', 'export', 'DB', '--output', out, mode === 'remote' ? '--remote' : '--local'];

if (mode === 'dry') {
  console.log('dry-run — would run:');
  plan([`npx wrangler`, ...cmd]);
  console.log(`target: ${out}`);
  process.exit(0);
}
if (!existsSync(dirname(out))) mkdirSync(dirname(out), { recursive: true });
const rc = runWrangler(cmd);
if (rc === 0) console.log(`backup written: ${out}`);
process.exit(rc);
