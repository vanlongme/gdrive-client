/**
 * restore — load a SQL dump into the LOCAL D1 database.
 * Default: dry-run. --execute performs the local restore.
 * Remote restore is a mutation and is refused in this wave.
 * Usage: node scripts/restore.ts --in FILE [--execute]
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { flag, has, parseArgs, plan, runWrangler, fail, REPO_ROOT } from './lib/common.ts';

const HELP = `restore — load a SQL dump into local D1.
Options: --in FILE (required), --execute (perform local restore), --help
Remote restore is intentionally not supported in this wave.`;

const args = parseArgs(process.argv.slice(2), ['help', 'in', 'execute', 'remote', 'local', 'dry-run']);
if (has(args, 'help')) { console.log(HELP); process.exit(0); }

const input = flag(args, 'in');
if (!input) fail('--in FILE is required; run with --help');
const file = resolve(REPO_ROOT, input);
if (!existsSync(file)) fail(`dump not found: ${file}`);
if (statSync(file).size === 0) fail(`dump is empty: ${file}`);
const head = readFileSync(file, 'utf8').slice(0, 64 * 1024);
if (!/(CREATE TABLE|INSERT INTO|PRAGMA)/i.test(head)) fail(`${file} does not look like a SQL dump`);

const cmd = ['d1', 'execute', 'DB', '--local', '--file', file];
if (has(args, 'remote')) fail('remote restore mutates production — refused in this wave');
if (!has(args, 'execute')) {
  console.log('dry-run — would run:');
  plan(['npx wrangler', ...cmd]);
  console.log(`restore source: ${file} (${statSync(file).size} bytes)`);
  process.exit(0);
}
process.exit(runWrangler(cmd));
