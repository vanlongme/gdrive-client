/**
 * Shared helpers for the ops scripts. These run under Node 24's built-in
 * type stripping (`node script.ts`) — no build step, no imports from src/.
 * Every script defaults to --dry-run against --local resources only; remote
 * mutation is never performed in this wave.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface ParsedArgs {
  readonly flags: Map<string, string | true>;
  readonly positional: string[];
}

const NO_VALUE_FLAGS = new Set(['help', 'dry-run', 'execute', 'local', 'remote', 'yes']);

export function parseArgs(argv: string[], allowed: readonly string[]): ParsedArgs {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const name = (eq === -1 ? a.slice(2) : a.slice(2, eq)).trim();
    if (!allowed.includes(name)) {
      fail(`unknown flag --${name}; run with --help`);
    }
    if (eq !== -1) {
      flags.set(name, a.slice(eq + 1));
    } else if (!NO_VALUE_FLAGS.has(name) && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) {
      flags.set(name, argv[++i]!);
    } else {
      flags.set(name, true);
    }
  }
  return { flags, positional };
}

export function fail(message: string, code = 2): never {
  console.error(`error: ${message}`);
  process.exit(code);
}

export function flag(args: ParsedArgs, name: string): string | undefined {
  const v = args.flags.get(name);
  return v === true ? '' : v;
}

export function has(args: ParsedArgs, name: string): boolean {
  return args.flags.has(name);
}

/** Repo root = two levels up from scripts/lib/common.ts. */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

export function wranglerBin(): string {
  const local = resolve(REPO_ROOT, 'node_modules', '.bin', 'wrangler');
  return existsSync(local) ? local : 'wrangler';
}

/** Run a wrangler command; returns exit code. Never called in dry-run mode. */
export function runWrangler(args: string[]): number {
  const res = spawnSync(wranglerBin(), args, { stdio: 'inherit', cwd: REPO_ROOT });
  return res.status ?? 1;
}

/** Print the command a real run would execute. */
export function plan(cmd: string[]): void {
  console.log(`  ${cmd.join(' ')}`);
}

/** Canonical 32-byte base64 validation (mirrors bootstrap-config rules). */
export function isValidKey(text: string): boolean {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) return false;
  const buf = Buffer.from(text, 'base64');
  return buf.length === 32 && buf.toString('base64') === text;
}

export function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Parse .dev.vars into a map without printing values. */
export function readDevVars(path: string): Map<string, string> | null {
  if (!existsSync(path)) return null;
  const out = new Map<string, string>();
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith('#')) out.set(m[1]!, m[2]!);
  }
  return out;
}

export function requireLocalOrDryRun(args: ParsedArgs, remoteDescription: string): 'local' | 'remote' | 'dry' {
  if (has(args, 'remote')) {
    if (!has(args, 'yes')) {
      fail(`remote ${remoteDescription} requires --yes; this wave never mutates remote state unprompted`);
    }
    return 'remote';
  }
  if (has(args, 'execute')) return 'local';
  return 'dry';
}
