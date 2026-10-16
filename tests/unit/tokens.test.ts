import { describe, expect, it } from 'vitest';
import {
  normalizeScopes,
  SingleFlight,
  TokenCache,
  tokenIdentityKey,
  type OAuthTokenIdentity,
  type ServiceAccountTokenIdentity,
} from '../../src/worker/drive/tokens';

const oauthIdentity: OAuthTokenIdentity = {
  provider: 'google_oauth',
  credentialId: 'conn-1',
  credentialVersion: 3,
  projectId: 'proj-a',
  principalId: 'perm-1',
  oauthClientId: 'client-1',
  oauthClientVersion: 2,
  scopes: ['https://www.googleapis.com/auth/drive'],
};

const saIdentity: ServiceAccountTokenIdentity = {
  provider: 'service_account',
  credentialId: 'sa-1',
  credentialVersion: 1,
  projectId: 'proj-a',
  principalId: 'sa@proj-a.iam.gserviceaccount.com',
  scopes: ['https://www.googleapis.com/auth/drive.readonly'],
};

describe('normalizeScopes', () => {
  it('trims, deduplicates and sorts', () => {
    expect(normalizeScopes([' b ', 'a', 'b', '  '])).toEqual(['a', 'b']);
  });
});

describe('tokenIdentityKey', () => {
  it('is stable under scope ordering (canonical key sorts the list)', () => {
    const a = tokenIdentityKey({ ...oauthIdentity, scopes: ['s2', 's1'] });
    const b = tokenIdentityKey({ ...oauthIdentity, scopes: ['s1', 's2'] });
    expect(a).toBe(b);
  });

  it('changes with every identity field', () => {
    const base = tokenIdentityKey(oauthIdentity);
    const variants = [
      { ...oauthIdentity, credentialId: 'conn-2' },
      { ...oauthIdentity, credentialVersion: 4 },
      { ...oauthIdentity, projectId: 'proj-b' },
      { ...oauthIdentity, principalId: 'perm-2' },
      { ...oauthIdentity, oauthClientId: 'client-2' },
      { ...oauthIdentity, oauthClientVersion: 3 },
      { ...oauthIdentity, scopes: ['other'] },
    ];
    for (const variant of variants) {
      expect(tokenIdentityKey(variant)).not.toBe(base);
    }
  });

  it('never shares a key across providers in the same project', () => {
    expect(tokenIdentityKey(oauthIdentity)).not.toBe(tokenIdentityKey(saIdentity));
  });
});

describe('TokenCache', () => {
  it('serves a grant until the safety margin, then drops it', () => {
    let now = 0;
    const cache = new TokenCache(100, () => now);
    cache.set('k', { accessToken: 'tok', expiresAtMs: 500 });
    now = 399;
    expect(cache.get('k')?.accessToken).toBe('tok');
    now = 400; // inside the 100ms margin
    expect(cache.get('k')).toBeUndefined();
  });

  it('does not store grants already inside the margin', () => {
    const cache = new TokenCache(100, () => 1_000);
    cache.set('k', { accessToken: 'tok', expiresAtMs: 1_050 });
    expect(cache.get('k')).toBeUndefined();
  });

  it('invalidate removes an entry', () => {
    const cache = new TokenCache(100, () => 0);
    cache.set('k', { accessToken: 'tok', expiresAtMs: 10_000 });
    cache.invalidate('k');
    expect(cache.get('k')).toBeUndefined();
  });
});

describe('SingleFlight', () => {
  it('coalesces concurrent runs into one execution', async () => {
    const flight = new SingleFlight();
    let calls = 0;
    const work = () =>
      new Promise<string>((resolve) => {
        calls += 1;
        setTimeout(() => resolve('done'), 5);
      });
    const [a, b] = await Promise.all([flight.run('k', work), flight.run('k', work)]);
    expect(a).toBe('done');
    expect(b).toBe('done');
    expect(calls).toBe(1);
  });

  it('releases the key after completion and after failure', async () => {
    const flight = new SingleFlight();
    let calls = 0;
    const fail = () => {
      calls += 1;
      return Promise.reject(new Error('nope'));
    };
    await expect(flight.run('k', fail)).rejects.toThrow('nope');
    const ok = await flight.run('k', async () => {
      calls += 1;
      return 'ok';
    });
    expect(ok).toBe('ok');
    expect(calls).toBe(2);
  });
});
