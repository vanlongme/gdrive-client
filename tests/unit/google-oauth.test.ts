import { describe, expect, it } from 'vitest';
import {
  buildAuthorizationUrl,
  exchangeAuthorizationCode,
  exchangeServiceAccountJwt,
  fetchAboutUser,
  GOOGLE_ABOUT_ENDPOINT,
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_REVOKE_ENDPOINT,
  GOOGLE_TOKEN_ENDPOINT,
  refreshAccessToken,
  revokeToken,
  SA_READ_SCOPE,
  ServiceAccountScopeError,
  signServiceAccountJwt,
} from '../../src/worker/drive/oauth/google';
import type { FetchLike } from '../../src/worker/drive/tokens';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function fixtureFetch(
  handler: (call: RecordedCall) => Response | Promise<Response>,
): { fetchImpl: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    // Build a real workerd Request so unsupported init values (such as
    // redirect: 'error', which the edge runtime rejects) fail here exactly as
    // they would in production instead of passing through a plain stub.
    new Request(url, init);
    const call = { url, init };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function b64urlToBytes(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

async function generateSaPem(): Promise<{ pem: string; publicKey: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ['sign', 'verify'],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  let binary = '';
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(binary)}\n-----END PRIVATE KEY-----`;
  return { pem, publicKey: pair.publicKey };
}

describe('buildAuthorizationUrl', () => {
  it('targets the fixed endpoint with offline access, consent and S256', () => {
    const url = new URL(
      buildAuthorizationUrl({
        clientId: 'cid',
        redirectUri: 'https://app.test/api/v1/admin/google/oauth/callback',
        state: 'state-token',
        codeChallenge: 'challenge',
        scopes: ['https://www.googleapis.com/auth/drive'],
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTHORIZATION_ENDPOINT);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe('state-token');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://app.test/api/v1/admin/google/oauth/callback',
    );
  });
});

describe('token endpoint grants', () => {
  const exchangeInput = {
    code: 'code-1',
    redirectUri: 'https://app.test/cb',
    clientId: 'cid',
    clientSecret: 'secret',
    codeVerifier: 'verifier',
  };

  it('exchanges a code at the fixed endpoint with redirect forbidden', async () => {
    const { fetchImpl, calls } = fixtureFetch(() =>
      json({
        access_token: 'at-1',
        expires_in: 3600,
        refresh_token: 'rt-1',
        scope: 'a b',
        token_type: 'Bearer',
      }),
    );
    const result = await exchangeAuthorizationCode(exchangeInput, fetchImpl);
    expect(result).toEqual({
      ok: true,
      value: {
        accessToken: 'at-1',
        expiresInSec: 3600,
        refreshToken: 'rt-1',
        grantedScopes: ['a', 'b'],
        tokenType: 'Bearer',
      },
    });
    const call = calls[0];
    expect(call?.url).toBe(GOOGLE_TOKEN_ENDPOINT);
    expect(call?.init?.redirect).toBe('manual');
    const params = new URLSearchParams(call?.init?.body as string);
    expect(params.get('grant_type')).toBe('authorization_code');
    expect(params.get('client_secret')).toBe('secret');
    expect(params.get('code_verifier')).toBe('verifier');
    expect(params.get('redirect_uri')).toBe('https://app.test/cb');
  });

  it('treats a grant without expires_in as malformed, not as a default', async () => {
    const { fetchImpl } = fixtureFetch(() => json({ access_token: 'at-1' }));
    const result = await exchangeAuthorizationCode(exchangeInput, fetchImpl);
    expect(result).toEqual({ ok: false, kind: 'malformed_response', status: 200 });
  });

  it('surfaces invalid_grant as a typed oauth error', async () => {
    const { fetchImpl } = fixtureFetch(() =>
      json({ error: 'invalid_grant', error_description: 'expired' }, 400),
    );
    const result = await refreshAccessToken(
      { refreshToken: 'rt', clientId: 'cid', clientSecret: 'secret' },
      fetchImpl,
    );
    expect(result).toEqual({
      ok: false,
      kind: 'oauth_error',
      error: 'invalid_grant',
      description: 'expired',
      status: 400,
    });
  });

  it('rejects a 307 instead of following it with credentials', async () => {
    const { fetchImpl } = fixtureFetch(
      () => new Response(null, { status: 307, headers: { location: 'https://evil.test/x' } }),
    );
    const result = await refreshAccessToken(
      { refreshToken: 'rt', clientId: 'cid', clientSecret: 'secret' },
      fetchImpl,
    );
    expect(result).toEqual({ ok: false, kind: 'redirect', status: 307 });
  });

  it('maps fetch rejection to transport_error', async () => {
    const { fetchImpl } = fixtureFetch(() => {
      throw new Error('reset');
    });
    const result = await refreshAccessToken(
      { refreshToken: 'rt', clientId: 'cid', clientSecret: 'secret' },
      fetchImpl,
    );
    expect(result).toEqual({ ok: false, kind: 'transport_error' });
  });
});

describe('fetchAboutUser', () => {
  it('extracts permissionId and email', async () => {
    const { fetchImpl, calls } = fixtureFetch(() =>
      json({ user: { permissionId: 'perm-9', emailAddress: 'op@example.com' } }),
    );
    const result = await fetchAboutUser('at', fetchImpl);
    expect(result).toEqual({
      ok: true,
      value: { permissionId: 'perm-9', emailAddress: 'op@example.com', displayName: undefined },
    });
    expect(calls[0]?.url).toBe(`${GOOGLE_ABOUT_ENDPOINT}?fields=user`);
    expect(calls[0]?.init?.redirect).toBe('manual');
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe('Bearer at');
  });

  it('treats a null user object as malformed', async () => {
    const { fetchImpl } = fixtureFetch(() => json({ user: null }));
    const result = await fetchAboutUser('at', fetchImpl);
    expect(result).toEqual({ ok: false, kind: 'malformed_response', status: 200 });
  });

  it('fails typed when permissionId is absent', async () => {
    const { fetchImpl } = fixtureFetch(() => json({ user: { emailAddress: 'x@y' } }));
    const result = await fetchAboutUser('at', fetchImpl);
    expect(result).toEqual({
      ok: false,
      kind: 'oauth_error',
      error: 'missing_permission_id',
      description: undefined,
      status: 200,
    });
  });
});

describe('revokeToken', () => {
  it('posts the token in the RFC 7009 form body at the fixed endpoint', async () => {
    const { fetchImpl, calls } = fixtureFetch(() => new Response(null, { status: 200 }));
    const result = await revokeToken('rt-secret', fetchImpl);
    expect(result).toEqual({ ok: true, value: true });
    expect(calls[0]?.url).toBe(GOOGLE_REVOKE_ENDPOINT);
    expect(new URLSearchParams(calls[0]?.init?.body as string).get('token')).toBe('rt-secret');
    expect(calls[0]?.init?.redirect).toBe('manual');
  });
});

describe('service account JWT', () => {
  it('signs an RS256 assertion with fixed audience and no sub claim', async () => {
    const { pem, publicKey } = await generateSaPem();
    const jwt = await signServiceAccountJwt(
      { clientEmail: 'sa@proj.iam.gserviceaccount.com', privateKeyPem: pem, privateKeyId: 'kid-1' },
      [SA_READ_SCOPE],
      () => 1_700_000_000_000,
    );
    const [h, p, s] = jwt.split('.');
    const header = JSON.parse(decoder.decode(b64urlToBytes(h ?? ''))) as Record<string, unknown>;
    const claims = JSON.parse(decoder.decode(b64urlToBytes(p ?? ''))) as Record<string, unknown>;
    expect(header).toMatchObject({ alg: 'RS256', typ: 'JWT', kid: 'kid-1' });
    expect(claims).toMatchObject({
      iss: 'sa@proj.iam.gserviceaccount.com',
      scope: SA_READ_SCOPE,
      aud: GOOGLE_TOKEN_ENDPOINT,
      iat: 1_700_000_000,
      exp: 1_700_000_000 + 3600,
    });
    expect('sub' in claims).toBe(false);
    const valid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      publicKey,
      b64urlToBytes(s ?? '') as Uint8Array<ArrayBuffer>,
      encoder.encode(`${h}.${p}`),
    );
    expect(valid).toBe(true);
  });

  it('refuses any scope other than drive.readonly at the signing boundary', async () => {
    const { pem } = await generateSaPem();
    await expect(
      signServiceAccountJwt(
        { clientEmail: 'sa@x', privateKeyPem: pem },
        ['https://www.googleapis.com/auth/drive'],
      ),
    ).rejects.toBeInstanceOf(ServiceAccountScopeError);
    await expect(
      signServiceAccountJwt({ clientEmail: 'sa@x', privateKeyPem: pem }, []),
    ).rejects.toBeInstanceOf(ServiceAccountScopeError);
    await expect(
      signServiceAccountJwt(
        { clientEmail: 'sa@x', privateKeyPem: pem },
        [SA_READ_SCOPE, 'https://www.googleapis.com/auth/drive'],
      ),
    ).rejects.toBeInstanceOf(ServiceAccountScopeError);
  });

  it('posts the jwt-bearer grant to the fixed token endpoint', async () => {
    const { fetchImpl, calls } = fixtureFetch(() =>
      json({ access_token: 'sat', expires_in: 3600 }),
    );
    const result = await exchangeServiceAccountJwt('header.payload.sig', fetchImpl);
    expect(result).toEqual({
      ok: true,
      value: {
        accessToken: 'sat',
        expiresInSec: 3600,
        refreshToken: undefined,
        grantedScopes: [],
        tokenType: '',
      },
    });
    const params = new URLSearchParams(calls[0]?.init?.body as string);
    expect(params.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(params.get('assertion')).toBe('header.payload.sig');
  });
});
