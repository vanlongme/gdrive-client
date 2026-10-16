/**
 * strip-dev-vars — remove .dev.vars[.*] files emitted by vite build under dist/.
 *
 * `vite build` copies the developer's .dev.vars into dist/drive_worker/ so
 * `wrangler dev`/preview can read secrets; the same copy must not sit next
 * to the bundle at deploy time. The E2E webServer already deletes it
 * (playwright.config.ts); deploy scripts run this between build and
 * wrangler. Idempotent: exits 0 when nothing is found.
 *
 * Usage: node scripts/release/strip-dev-vars.ts [--dir dist]
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fail, flag, has, parseArgs, REPO_ROOT } from '../lib/common.ts';

const HELP = `strip-dev-vars — delete .dev.vars[.*] files emitted by vite build under dist/.
Options:
  --dir <path>  directory to clean (default: dist)
  --help`;

const args = parseArgs(process.argv.slice(2), ['help', 'dir']);
if (has(args, 'help')) { console.log(HELP); process.exit(0); }

const root = resolve(REPO_ROOT, flag(args, 'dir') ?? 'dist');
if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
  fail(`directory not found: ${relative(REPO_ROOT, root)} — run npm run build first`);
}

const NAME = /^\.dev\.vars(\..+)?$/;
const found: string[] = [];
const walk = (dir: string): void => {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, d.name);
    if (d.isDirectory()) walk(full);
    else if (d.isFile() && NAME.test(d.name)) {
      rmSync(full);
      found.push(relative(REPO_ROOT, full));
    }
  }
};
walk(root);

for (const p of found) console.log(`removed ${p}`);
console.log(`strip-dev-vars: ${found.length === 0 ? 'nothing to remove' : `${found.length} file(s) removed`}`);
