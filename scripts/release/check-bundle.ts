/**
 * check-bundle — release bundle secret/output scan (plan T16, wave-6
 * frozen decision 4). Scans the built dist/ tree and fails on leaked
 * secrets, token shapes, emitted .dev.vars files, source maps (unless
 * explicitly allowed) and missing required outputs.
 *
 * Usage: node scripts/release/check-bundle.ts [--dir dist] [--allow-source-maps]
 *
 * Never prints secret values: a finding names only the file and the kind
 * of match.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fail, flag, has, parseArgs, readDevVars, REPO_ROOT } from '../lib/common.ts';
import { E2E_APP_MASTER_KEY, E2E_SETUP_TOKEN } from '../../tests/e2e/e2e-env.ts';
import {
  checkRequiredAssets,
  E2E_FIXTURE_SECRETS,
  scanBundle,
  type BundleEntry,
  type ForbiddenLiteral,
} from './lib/bundle-scan.ts';

const HELP = `check-bundle — scan the built dist/ for leaked secrets and required outputs.
Options:
  --dir <path>           directory to scan (default: dist)
  --allow-source-maps    permit *.map files and sourceMappingURL comments
  --help`;

const args = parseArgs(process.argv.slice(2), ['help', 'dir', 'allow-source-maps']);
if (has(args, 'help')) { console.log(HELP); process.exit(0); }

const root = resolve(REPO_ROOT, flag(args, 'dir') ?? 'dist');
if (!statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
  fail(`scan directory not found: ${relative(REPO_ROOT, root)} — run npm run build first`);
}

const entries: BundleEntry[] = [];
const walk = (dir: string): void => {
  for (const d of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, d.name);
    if (d.isDirectory()) walk(full);
    else if (d.isFile()) {
      entries.push({
        path: relative(root, full).split(sep).join('/'),
        bytes: new Uint8Array(readFileSync(full)),
      });
    }
  }
};
walk(root);

// .dev.vars values are loaded in-process and only ever reported by name.
const devVars: ForbiddenLiteral[] = [];
const varsPath = join(REPO_ROOT, '.dev.vars');
for (const [key, value] of readDevVars(varsPath) ?? []) {
  if (value.length > 0) devVars.push({ label: key, value });
}

// Env overrides of the e2e fixtures (E2E_SETUP_TOKEN / E2E_APP_MASTER_KEY)
// are forbidden too; the committed defaults are covered by the scanner.
const extraLiterals: ForbiddenLiteral[] = [];
for (const { label, value } of [
  { label: 'E2E_SETUP_TOKEN', value: E2E_SETUP_TOKEN },
  { label: 'E2E_APP_MASTER_KEY', value: E2E_APP_MASTER_KEY },
]) {
  if (!E2E_FIXTURE_SECRETS.some((s) => s.label === label && s.value === value)) {
    extraLiterals.push({ label: `e2e-env:${label}`, value });
  }
}

const findings = [
  ...scanBundle(entries, {
    devVars,
    extraLiterals,
    allowSourceMaps: has(args, 'allow-source-maps'),
  }),
  ...checkRequiredAssets(entries.map((e) => e.path)),
];

for (const f of findings) {
  console.log(`FAIL ${f.path === '' ? '(bundle)' : f.path} — ${f.kind}`);
}
if (findings.some((f) => f.kind === 'dev-vars-file')) {
  console.log('hint: vite build copies .dev.vars into the worker output dir for preview; run `node scripts/release/strip-dev-vars.ts` before deploying (the deploy scripts do this automatically)');
}
if (findings.length > 0) {
  console.error(`check:bundle: ${findings.length} finding(s)`);
  process.exit(1);
}
console.log(`check:bundle: clean (${entries.length} files scanned in ${relative(REPO_ROOT, root) || '.'})`);
