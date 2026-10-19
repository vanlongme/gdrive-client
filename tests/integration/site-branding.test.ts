/** Site branding integration tests (wave 8 B1): defaults before setup,
 * admin-only writes, logo validation (magic, oversize, SVG rules), and the
 * public logo GET contract through createApp wiring. */

import { env } from 'cloudflare:workers';
import { applyD1Migrations, createExecutionContext, type D1Migration } from 'cloudflare:test';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/worker/app';
import { createSiteAdminRouter, createSiteRouter, isSafeSvg, SITE_LOGO_MAX_BYTES } from '../../src/worker/site/routes';

const TEST_MIGRATIONS = JSON.parse((env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS) as D1Migration[];
const NOW = 1_700_000_000_000;
const ORIGIN = 'https://app.test';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 9]);
const SVG_OK = new TextEncoder().encode('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><use href="#a"/></svg>');

async function reset() {
  for (const t of ['site_branding', 'audit_events', 'user', 'app_settings']) {
    await env.DB.prepare(`DELETE FROM "${t}"`).run();
  }
}

function harness(adminOk = true) {
  const app = new Hono<{ Bindings: Env; Variables: { requestId?: string } }>();
  app.use('/api/*', async (c, next) => { c.set('requestId', 'req-t'); await next(); });
  const deps = {
    requireAdmin: adminOk
      ? () => Promise.resolve({ userId: 'u-admin', sessionId: 's1' })
      : () => Promise.reject({ status: 403, code: 'FORBIDDEN', message: 'nope' }),
    now: () => NOW,
  };
  app.route('/api/v1/site', createSiteRouter(deps));
  app.route('/api/v1/admin', createSiteAdminRouter(deps));
  return app;
}

type TestApp = Hono<{ Bindings: Env; Variables: { requestId?: string } }>;
const api = (app: TestApp, p: string, init?: RequestInit) =>
  Promise.resolve(app.fetch(new Request(`${ORIGIN}${p}`, init), env as unknown as Env));

beforeEach(async () => {
  await applyD1Migrations(env.DB, TEST_MIGRATIONS);
  await reset();
  await env.DB.prepare('INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role, banned) VALUES (\'u-admin\', \'Admin\', \'admin@x.test\', 1, 1, 1, \'admin\', 0)').run();
});

describe('pre-setup anonymous surface (createApp)', () => {
  it('GET /api/v1/site answers defaults before setup with no admin row', async () => {
    const app = createApp();
    const res = await app.fetch(new Request(`${ORIGIN}/api/v1/site`), env as unknown as Env, createExecutionContext());
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({ title: 'Drive Worker', tagline: '', welcome: '', supportEmail: null, defaultLocale: 'vi', logoUrl: null });
    expect(res.headers.get('cache-control')).toContain('no-store');
  });
  it('GET /api/v1/site/logo is 404 pre-setup', async () => {
    const app = createApp();
    const res = await app.fetch(new Request(`${ORIGIN}/api/v1/site/logo`), env as unknown as Env, createExecutionContext());
    expect(res.status).toBe(404);
  });
});

describe('admin branding writes', () => {
  it('PUT /admin/site upserts the singleton and defaultLocale', async () => {
    await env.DB.prepare("INSERT INTO app_settings (id, setup_state, canonical_origin, default_locale, created_at, updated_at) VALUES (1, 'complete', ?, 'vi', ?, ?)").bind(ORIGIN, NOW, NOW).run();
    const app = harness();
    const res = await api(app, '/api/v1/admin/site', {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: '  Orbit Drive  ', tagline: 'Files, fast', welcome: 'Hi', supportEmail: 'help@x.test', defaultLocale: 'en' }),
    });
    expect(res.status).toBe(200);
    const view = (await res.json()) as { title: string; defaultLocale: string };
    expect(view.title).toBe('Orbit Drive');
    expect(view.defaultLocale).toBe('en');
    const row = await env.DB.prepare('SELECT default_locale FROM app_settings WHERE id = 1').first<{ default_locale: string }>();
    expect(row?.default_locale).toBe('en');
    const audit = await env.DB.prepare("SELECT operation FROM audit_events WHERE target_type='site_branding'").first<{ operation: string }>();
    expect(audit?.operation).toBe('site.branding.update');
    // Now visible anonymously:
    const pub = await api(app, '/api/v1/site');
    expect(((await pub.json()) as { title: string }).title).toBe('Orbit Drive');
  });
  it('rejects invalid bodies and non-admin callers', async () => {
    const app = harness();
    expect((await api(app, '/api/v1/admin/site', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: '', tagline: '', welcome: '', supportEmail: null, defaultLocale: 'vi' }) })).status).toBe(400);
    expect((await api(app, '/api/v1/admin/site', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 't', tagline: '', welcome: '', supportEmail: 'not-mail', defaultLocale: 'vi' }) })).status).toBe(400);
    expect((await api(harness(false), '/api/v1/admin/site', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 't', tagline: '', welcome: '', supportEmail: null, defaultLocale: 'vi' }) })).status).toBe(403);
  });
});

describe('logo upload', () => {
  async function put(app: TestApp, mime: string, body: Uint8Array) {
    return api(app, '/api/v1/admin/site/logo', { method: 'PUT', headers: { 'content-type': mime, 'content-length': String(body.byteLength) }, body: body as Uint8Array<ArrayBuffer> });
  }
  it('accepts png/webp/svg and serves bytes with contract headers', async () => {
    const app = harness();
    expect((await put(app, 'image/png', PNG)).status).toBe(200);
    const view = (await api(app, '/api/v1/site').then((r) => r.json())) as { logoUrl: string };
    expect(view.logoUrl).toBe('/api/v1/site/logo?v=1');
    const got = await api(app, `/api/v1/site/logo`);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(PNG);
    expect((await put(app, 'image/webp', WEBP)).status).toBe(200);
    const view2 = (await api(app, '/api/v1/site').then((r) => r.json())) as { logoUrl: string };
    expect(view2.logoUrl).toBe('/api/v1/site/logo?v=2');
    expect((await put(app, 'image/svg+xml', SVG_OK)).status).toBe(200);
    const svg = await api(app, '/api/v1/site/logo');
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
  });
  it('rejects bad mime, bad magic, oversize and malicious SVG', async () => {
    const app = harness();
    expect((await put(app, 'image/jpeg', PNG)).status).toBe(400);
    expect((await put(app, 'image/png', WEBP)).status).toBe(400);
    expect((await put(app, 'image/webp', PNG)).status).toBe(400);
    const big = new Uint8Array(SITE_LOGO_MAX_BYTES + 1).fill(0x89);
    big.set(PNG);
    expect((await put(app, 'image/png', big)).status).toBe(413);
    for (const svg of [
      '<svg><script>alert(1)</script></svg>',
      '<svg><foreignObject><body>x</body></foreignObject></svg>',
      '<svg onload="x()"></svg>',
      '<svg><a href="javascript:x()"/></svg>',
      '<svg><image href="https://evil.test/x.png"/></svg>',
      '<svg><image xlink:href="//evil.test/x"/></svg>',
      '<div>not svg</div>',
      '<!DOCTYPE svg><svg/>',
    ]) {
      expect(isSafeSvg(new TextEncoder().encode(svg)), svg).toBe(false);
    }
    expect((await put(app, 'image/svg+xml', new TextEncoder().encode('<svg><script/></svg>'))).status).toBe(400);
  });
  it('streams-enforces the cap when Content-Length lies', async () => {
    const app = harness();
    const big = new Uint8Array(SITE_LOGO_MAX_BYTES + 10);
    const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(big); c.close(); } });
    const res = await api(app, '/api/v1/admin/site/logo', { method: 'PUT', headers: { 'content-type': 'image/png', 'content-length': '10' }, body: stream });
    expect(res.status).toBe(413);
  });
  it('DELETE clears the logo (logoUrl null, GET 404)', async () => {
    const app = harness();
    await put(app, 'image/png', PNG);
    const del = await api(app, '/api/v1/admin/site/logo', { method: 'DELETE' });
    expect(del.status).toBe(200);
    const view = (await del.json()) as { logoUrl: string | null };
    expect(view.logoUrl).toBeNull();
    expect((await api(app, '/api/v1/site/logo')).status).toBe(404);
  });
});

describe('isSafeSvg root + fragment rules', () => {
  it('accepts prolog, comments, fragments and inline shapes', () => {
    expect(isSafeSvg(new TextEncoder().encode('<?xml version="1.0"?><!-- c --><svg><defs><g id="a"/><use href="#a" xlink:href="#a"/></defs></svg>'))).toBe(true);
    expect(isSafeSvg(new TextEncoder().encode('<svg/>'))).toBe(true);
  });
});

describe('isSafeSvg security-review bypasses (L1)', () => {
  const bad = [
    '<svg><a href="jav\nascript:alert(1)"/></svg>', // newline inside href
    '<svg><set attributeName="x" to="java&#115;cript:alert(1)"/></svg>', // numeric char ref + <set
    '<svg><style>@import url(https://evil.test/x.css)</style></svg>',
    '<svg><rect style="fill:url(https://evil.test/x.png)"/></svg>',
    '<svg><style>rect{fill:url(https://evil.test)}</style></svg>',
    '<svg><animate attributeName="href" values="javascript:alert(1)"/></svg>',
    '<svg><animateTransform/></svg>',
    '<svg><use href="data:image/svg+xml;base64,AAAA"/></svg>',
    '<svg><use href=javascript:alert(1)/></svg>', // unquoted href
    '<svg><a href="java&#115;cript:alert(1)"/></svg>', // entity-encoded scheme
    // Review R4: namespace-prefixed deny-listed elements.
    '<svg xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>',
    '<svg xmlns:s="http://www.w3.org/2000/svg"><s:set attributeName="href" to="java&#9;script:alert(1)"/></svg>', // prefix + tab-charref scheme
    '<svg xmlns:s="http://www.w3.org/2000/svg"><s:foreignObject><body>x</body></s:foreignObject></svg>',
    '<svg xmlns:s="http://www.w3.org/2000/svg"><s:style>@import "https://evil.test/x.css";</s:style></svg>',
    '<svg><rect fill="java&#13;&#10;script:alert(1)"/></svg>', // CR/LF charrefs in a scheme
    // Review L-a: non-ASCII namespace prefix.
    '<svg xmlns:\u00e9="http://www.w3.org/2000/svg"><\u00e9:script>alert(1)</\u00e9:script></svg>',
    // Review L-b: CSS escapes inside style / presentation attributes.
    '<svg><rect style="fill:u\\72l(#a)"/></svg>',
    '<svg><rect fill="u\\72l(#a)"/></svg>',
  ];
  for (const [i, svg] of bad.entries()) {
    it(`rejects bypass #${i}`, () => {
      expect(isSafeSvg(new TextEncoder().encode(svg)), svg).toBe(false);
    });
  }
  it('still accepts a clean inline logo', () => {
    expect(isSafeSvg(new TextEncoder().encode('<svg viewBox="0 0 10 10"><rect width="10" height="10" fill="#fff"/></svg>'))).toBe(true);
  });
});
