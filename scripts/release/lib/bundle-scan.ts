/**
 * Pure release-bundle scanner (plan T16, wave-6 frozen decision 4).
 *
 * This module is deliberately free of node:* imports so the unit tests can
 * run inside the workerd vitest pool. It operates on {path, bytes} entries
 * produced by the thin Node wrapper in ../check-bundle.ts.
 *
 * Output contract: a finding reports only the file path and the kind of
 * match — never a secret value, token text, or matched substring.
 */

export interface BundleEntry {
  /** Path relative to the scanned root, forward slashes. */
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** A forbidden literal with a safe-to-print label (never the value). */
export interface ForbiddenLiteral {
  readonly label: string;
  readonly value: string;
}

export interface ScanOptions {
  /** Values from the local .dev.vars (label = variable name). */
  readonly devVars: readonly ForbiddenLiteral[];
  /**
   * Additional forbidden literals (e.g. env-overridden e2e fixture values).
   * Each is reported as `forbidden:<label>`.
   */
  readonly extraLiterals?: readonly ForbiddenLiteral[];
  /** Allow *.map artifacts and sourceMappingURL comments. */
  readonly allowSourceMaps?: boolean;
}

export interface ScanFinding {
  readonly path: string;
  readonly kind: string;
}

/**
 * The committed test fixtures from tests/e2e/e2e-env.ts. These are public
 * constants, but a production bundle must never embed them: their presence
 * means fixture plumbing leaked into release output. Keep in sync with the
 * `?? "<default>"` literals in e2e-env.ts.
 */
export const E2E_FIXTURE_SECRETS: readonly ForbiddenLiteral[] = [
  { label: 'E2E_SETUP_TOKEN', value: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=' },
  { label: 'E2E_APP_MASTER_KEY', value: '//79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA=' },
];

// Header alone is not enough: the shipped bundle legitimately contains the
// literal text "-----BEGIN PRIVATE KEY-----" inside our own key-validator
// regexes. A real PEM carries a long base64 body right after the header.
const PEM_PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[0-9A-Za-z+/=\r\n]{64,}/;
// Google OAuth access tokens carry the `ya29.` prefix.
const GOOGLE_ACCESS_TOKEN = /ya29\.[0-9A-Za-z_-]{10,}/;
// Google OAuth refresh tokens start with `1//` followed by a long body.
const GOOGLE_REFRESH_TOKEN = /1\/\/[0-9A-Za-z_-]{20,}/;
const SOURCEMAP_COMMENT = /[#@]\s*sourceMappingURL=/;

const DEV_VARS_BASENAME = /^\.dev\.vars(\..+)?$/;

const decoder = new TextDecoder();

function textOf(entry: BundleEntry): string {
  return decoder.decode(entry.bytes);
}

function baseName(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** Scan decoded text for every forbidden literal and token shape. */
export function scanText(
  path: string,
  text: string,
  options: ScanOptions,
): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const { label, value } of options.devVars) {
    if (value.length > 0 && text.includes(value)) {
      findings.push({ path, kind: `dev-vars-value:${label}` });
    }
  }
  for (const { label, value } of E2E_FIXTURE_SECRETS) {
    if (text.includes(value)) {
      findings.push({ path, kind: `e2e-fixture:${label}` });
    }
  }
  for (const { label, value } of options.extraLiterals ?? []) {
    if (value.length > 0 && text.includes(value)) {
      findings.push({ path, kind: `forbidden:${label}` });
    }
  }
  if (PEM_PRIVATE_KEY.test(text)) findings.push({ path, kind: 'pem-private-key' });
  if (GOOGLE_ACCESS_TOKEN.test(text)) findings.push({ path, kind: 'google-access-token' });
  if (GOOGLE_REFRESH_TOKEN.test(text)) findings.push({ path, kind: 'google-refresh-token' });
  if (!options.allowSourceMaps && SOURCEMAP_COMMENT.test(text)) {
    findings.push({ path, kind: 'source-map' });
  }
  return findings;
}

/** Scan one bundle; findings are path + kind only, never matched text. */
export function scanBundle(
  entries: Iterable<BundleEntry>,
  options: ScanOptions,
): ScanFinding[] {
  const findings: ScanFinding[] = [];
  for (const entry of entries) {
    if (!options.allowSourceMaps && entry.path.endsWith('.map')) {
      findings.push({ path: entry.path, kind: 'source-map' });
    }
    if (DEV_VARS_BASENAME.test(baseName(entry.path))) {
      findings.push({ path: entry.path, kind: 'dev-vars-file' });
    }
    findings.push(...scanText(entry.path, textOf(entry), options));
  }
  return findings;
}

/**
 * Required build outputs (frozen decision 4): the asset _headers file, the
 * pdf.js web worker, the upload hash worker and the hls.js chunk. Paths are
 * relative to the dist/ root.
 */
export function checkRequiredAssets(paths: Iterable<string>): ScanFinding[] {
  const list = [...paths];
  const required: ReadonlyArray<{ kind: string; match: RegExp }> = [
    { kind: 'missing:_headers', match: /(^|\/)_headers$/ },
    { kind: 'missing:pdf-worker', match: /(^|\/)pdf\.worker\.min-[A-Za-z0-9_-]+\.mjs$/ },
    { kind: 'missing:hash-worker', match: /(^|\/)hash\.worker-[A-Za-z0-9_-]+\.js$/ },
    { kind: 'missing:hls-chunk', match: /(^|\/)hls-[A-Za-z0-9_-]+\.js$/ },
  ];
  const findings: ScanFinding[] = [];
  for (const { kind, match } of required) {
    if (!list.some((p) => match.test(p))) findings.push({ path: '', kind });
  }
  return findings;
}
