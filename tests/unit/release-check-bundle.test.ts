/**
 * Unit tests for the release bundle scanner (plan T16, wave-6 frozen
 * decision 4). These run in the workerd vitest pool, so they exercise only
 * the pure scanner over {path, bytes} entries; the Node fs wrapper is thin
 * and not covered here.
 */
import { describe, expect, it } from 'vitest';
import {
  checkRequiredAssets,
  scanBundle,
  type BundleEntry,
  type ForbiddenLiteral,
} from '../../scripts/release/lib/bundle-scan';

const enc = new TextEncoder();

function entry(path: string, content: string | Uint8Array): BundleEntry {
  return { path, bytes: typeof content === 'string' ? enc.encode(content) : content };
}

const DEV_VARS: readonly ForbiddenLiteral[] = [
  { label: 'APP_MASTER_KEY', value: 'kX9d2mQp7vBn4sL1zC8yT5wR3uH6jK0oP2aS4dF6gH8=' },
  { label: 'SETUP_TOKEN', value: 'mN3bV5cX8zA1sD4fG7hJ9kL2qW5eR8tY1uI4oP7aS0=' },
];

// The committed tests/e2e/e2e-env.ts defaults; duplicated here so the test
// fails loudly if the scanner's copy stops matching the fixture file.
const E2E_SETUP_TOKEN_DEFAULT = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';
const E2E_MASTER_KEY_DEFAULT = '//79/Pv6+fj39vX08/Lx8O/u7ezr6uno5+bl5OPi4eA=';

describe('scanBundle', () => {
  it('returns no findings for a clean bundle', () => {
    const entries = [
      entry('drive_worker/index.js', 'export default { fetch() { return new Response("ok"); } };'),
      entry('client/index.html', '<html><body>app</body></html>'),
      entry('client/assets/index-abc.js', 'const x = 1;'),
    ];
    expect(scanBundle(entries, { devVars: DEV_VARS })).toEqual([]);
  });

  it('flags an emitted .dev.vars file anywhere under dist', () => {
    const entries = [entry('drive_worker/.dev.vars', 'APP_MASTER_KEY=x'), entry('a/b/.dev.vars', '')];
    const findings = scanBundle(entries, { devVars: DEV_VARS });
    expect(findings.map((f) => f.kind)).toEqual(['dev-vars-file', 'dev-vars-file']);
    expect(findings.map((f) => f.path)).toEqual(['drive_worker/.dev.vars', 'a/b/.dev.vars']);
  });

  it('flags a .dev.vars.<env> variant as well', () => {
    const findings = scanBundle([entry('client/.dev.vars.staging', '')], { devVars: DEV_VARS });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('dev-vars-file');
  });

  it('flags every .dev.vars value found in bundle text', () => {
    const leaked = DEV_VARS[0]!.value;
    const findings = scanBundle(
      [entry('client/assets/index-abc.js', `const k = "${leaked}";`)],
      { devVars: DEV_VARS },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ path: 'client/assets/index-abc.js', kind: 'dev-vars-value:APP_MASTER_KEY' });
  });

  it('flags the committed e2e fixture secrets', () => {
    const findings = scanBundle(
      [
        entry('drive_worker/index.js', `const t = "${E2E_SETUP_TOKEN_DEFAULT}";`),
        entry('client/assets/x.js', `key=${E2E_MASTER_KEY_DEFAULT}`),
      ],
      { devVars: [] },
    );
    expect(findings.map((f) => f.kind).sort()).toEqual([
      'e2e-fixture:E2E_APP_MASTER_KEY',
      'e2e-fixture:E2E_SETUP_TOKEN',
    ]);
  });

  it('flags PEM private keys', () => {
    const body = 'A'.repeat(100);
    const pem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
    const rsa = `-----BEGIN RSA PRIVATE KEY-----\n${body}\n-----END RSA PRIVATE KEY-----`;
    const findings = scanBundle([entry('a.js', pem), entry('b.js', rsa)], { devVars: [] });
    expect(findings.map((f) => f.kind)).toEqual(['pem-private-key', 'pem-private-key']);
  });

  it('does not flag the PEM regex literals embedded in validator source', () => {
    // The bundle ships our own PEM validation regexes; a header with no
    // base64 body must not trip the scan.
    const src = 'var PRIVATE_KEY_PATTERN = /-----BEGIN PRIVATE KEY-----[A-Za-z0-9+/=\\s]+-----END PRIVATE KEY-----/;';
    expect(scanBundle([entry('a.js', src)], { devVars: [] })).toEqual([]);
  });

  it('does not flag public keys or certificates', () => {
    const pub = '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----';
    const cert = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
    expect(scanBundle([entry('a.js', pub + cert)], { devVars: [] })).toEqual([]);
  });

  it('flags ya29. access-token shapes', () => {
    const tok = 'ya29.a0AfB_byD-example-access-token-value_123';
    const findings = scanBundle([entry('a.js', `Authorization: Bearer ${tok}`)], { devVars: [] });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('google-access-token');
  });

  it('flags Google refresh-token shapes (1//...)', () => {
    const rt = '1//0gwJk3N0vlO5gCgYIARAAGBASNwF-L9IrAbCdEfGhIjKlMnOp';
    const findings = scanBundle([entry('a.js', `refresh_token=${rt}`)], { devVars: [] });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('google-refresh-token');
  });

  it('flags source maps unless explicitly allowed', () => {
    const entries = [entry('client/assets/index-abc.js.map', '{"version":3}')];
    const flagged = scanBundle(entries, { devVars: [] });
    expect(flagged).toHaveLength(1);
    expect(flagged[0]!.kind).toBe('source-map');
    expect(scanBundle(entries, { devVars: [], allowSourceMaps: true })).toEqual([]);
  });

  it('flags a sourcemap comment reference inside emitted js', () => {
    const js = 'const x=1;\n//# sourceMappingURL=index-abc.js.map\n';
    const findings = scanBundle([entry('client/assets/index-abc.js', js)], { devVars: [] });
    expect(findings.some((f) => f.kind === 'source-map')).toBe(true);
  });

  it('finds secrets inside non-utf8 binary content', () => {
    const bytes = new Uint8Array([0x00, 0xff, 0xfe, ...enc.encode(DEV_VARS[1]!.value), 0x80, 0x81]);
    const findings = scanBundle([entry('client/assets/x.wasm', bytes)], { devVars: DEV_VARS });
    expect(findings).toHaveLength(1);
    expect(findings[0]!.kind).toBe('dev-vars-value:SETUP_TOKEN');
  });

  it('never includes secret values in findings', () => {
    const secret = DEV_VARS[0]!.value;
    const findings = scanBundle(
      [entry('a.js', `k="${secret}"`), entry('b.js', `tok ya29.${'x'.repeat(30)}`)],
      { devVars: DEV_VARS },
    );
    for (const f of findings) {
      const serialized = JSON.stringify(f);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain('ya29.');
    }
  });
});

describe('checkRequiredAssets', () => {
  const complete = [
    'client/_headers',
    'client/index.html',
    'client/assets/pdf.worker.min-AbCd1234.mjs',
    'client/assets/hash.worker-XyZ9.js',
    'client/assets/hls-QwErTy12.js',
    'client/assets/hls-viewer-MnBv45.js',
    'drive_worker/index.js',
    'drive_worker/wrangler.json',
  ];

  it('passes when every required output is present', () => {
    expect(checkRequiredAssets(complete)).toEqual([]);
  });

  it('reports each missing required output', () => {
    const findings = checkRequiredAssets([]);
    expect(findings.map((f) => f.kind).sort()).toEqual([
      'missing:_headers',
      'missing:hash-worker',
      'missing:hls-chunk',
      'missing:pdf-worker',
    ]);
  });

  it('does not mistake the hls viewer chunk for the hls.js bundle chunk', () => {
    const without = complete.filter((p) => !p.includes('assets/hls-'));
    const findings = checkRequiredAssets(without);
    expect(findings.map((f) => f.kind)).toEqual(['missing:hls-chunk']);
  });
});
