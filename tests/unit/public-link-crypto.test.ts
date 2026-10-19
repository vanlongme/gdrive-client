/** Public-link crypto unit tests (wave 8 B2): PBKDF2 records, MACed
 * unlock cookies, slug folding, throttle-key shape. */
import { describe, expect, it } from 'vitest';
import {
  asciiFoldName,
  generatePublicLinkSlug,
  hashPublicLinkPassword,
  openPublicLinkCookie,
  publicLinkCookieHeader,
  readPublicLinkCookie,
  sealPublicLinkCookie,
  verifyPublicLinkPassword,
  PUBLIC_LINK_COOKIE_NAME,
  PUBLIC_LINK_PBKDF2_ITERATIONS,
} from '../../src/worker/public-links/crypto';
import { unlockAttemptKey } from '../../src/worker/public-links/links';

const ENV = { APP_MASTER_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=' };
const OTHER_ENV = { APP_MASTER_KEY: 'AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE=' };

describe('password hashing', () => {
  it('writes a pbkdf2-sha256$iter$salt$hash record and verifies', async () => {
    const stored = await hashPublicLinkPassword('correct-horse', 1000);
    expect(stored.startsWith('pbkdf2-sha256$1000$')).toBe(true);
    expect(stored.split('$')).toHaveLength(4);
    expect(await verifyPublicLinkPassword('correct-horse', stored)).toBe(true);
    expect(await verifyPublicLinkPassword('wrong-horse', stored)).toBe(false);
  });
  it('uses the platform-ceiling iteration count by default', () => {
    expect(PUBLIC_LINK_PBKDF2_ITERATIONS).toBe(100_000);
  });
  it('rejects malformed and over-iterated stored records', async () => {
    expect(await verifyPublicLinkPassword('x', 'garbage')).toBe(false);
    expect(await verifyPublicLinkPassword('x', 'pbkdf2-sha256$100001$AAAA$BBBB')).toBe(false);
    expect(await verifyPublicLinkPassword('x', 'scrypt$1000$AAAA$BBBB')).toBe(false);
    expect(await verifyPublicLinkPassword('x', 'pbkdf2-sha256$1000$AAAA$BBBB')).toBe(false);
  });
  it('produces different salts for identical passwords', async () => {
    const a = await hashPublicLinkPassword('same', 500);
    const b = await hashPublicLinkPassword('same', 500);
    expect(a).not.toBe(b);
  });
});

describe('unlock cookie', () => {
  const payload = { v: 1 as const, linkId: 'pl_x', credentialVersion: 3, exp: 1_800_000_000_000 };
  it('round-trips a sealed payload', async () => {
    const value = await sealPublicLinkCookie(ENV, payload);
    const opened = await openPublicLinkCookie(ENV, value);
    expect(opened).toEqual(payload);
  });
  it('rejects tampered payloads, wrong MAC and wrong keys', async () => {
    const value = await sealPublicLinkCookie(ENV, payload);
    const [data, mac] = value.split('.');
    expect(await openPublicLinkCookie(ENV, `${data}.${mac!.slice(0, -2)}AA`)).toBeNull();
    const b64u = (t: string) => btoa(Array.from(new TextEncoder().encode(t), (b) => String.fromCharCode(b)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const forged = `${b64u(JSON.stringify({ ...payload, linkId: 'pl_other' }))}.${mac}`;
    expect(await openPublicLinkCookie(ENV, forged)).toBeNull();
    expect(await openPublicLinkCookie(OTHER_ENV, value)).toBeNull();
    expect(await openPublicLinkCookie(ENV, 'garbage')).toBeNull();
    expect(await openPublicLinkCookie(ENV, `${data}.`)).toBeNull();
  });
  it('builds a locked-down Set-Cookie and reads it back', () => {
    const header = publicLinkCookieHeader('my-slug', 'value123', 43200);
    expect(header).toContain(`${PUBLIC_LINK_COOKIE_NAME}=value123`);
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    expect(header).toContain('SameSite=Lax');
    expect(header).toContain('Path=/api/v1/p/my-slug');
    expect(header).toContain('Max-Age=43200');
    const req = new Request('https://x/api/v1/p/s/children', {
      headers: { cookie: `session_token=abc; ${PUBLIC_LINK_COOKIE_NAME}=value123` },
    });
    expect(readPublicLinkCookie(req)).toBe('value123');
    expect(readPublicLinkCookie(new Request('https://x/'))).toBeNull();
  });
});

describe('slugs', () => {
  it('ascii-folds Vietnamese names and appends a base32 suffix', () => {
    const slug = generatePublicLinkSlug('Tài liệu tháng 10!');
    expect(/^[a-z0-9-]+-[a-z2-7]{6}$/.test(slug)).toBe(true);
    expect(slug.startsWith('tai-lieu-thang-10-')).toBe(true);
  });
  it('clips the folded name to 32 chars and handles empties', () => {
    const slug = generatePublicLinkSlug('a'.repeat(80));
    const folded = slug.slice(0, -7);
    expect(folded.length).toBeLessThanOrEqual(32);
    expect(generatePublicLinkSlug('!!!').startsWith('folder-')).toBe(true);
  });
  it('folds accents case-insensitively and dedupes dashes', () => {
    expect(asciiFoldName('Hé llo— Wørld')).toBe('he-llo-w-rld');
  });
});

describe('unlock throttle key', () => {
  it('is a stable sha256 hex of slug+ip, never containing the ip', async () => {
    const a = await unlockAttemptKey('slug1', '1.2.3.4');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(await unlockAttemptKey('slug1', '1.2.3.4'));
    expect(a).not.toBe(await unlockAttemptKey('slug1', '5.6.7.8'));
    expect(a).not.toBe(await unlockAttemptKey('slug2', '1.2.3.4'));
    expect(a).not.toContain('1.2.3.4');
  });
});
