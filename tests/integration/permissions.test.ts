import { describe, expect, it } from 'vitest';

import { classifyHttpStatus, DriveError } from '../../src/worker/drive/errors';
import {
  createDrivePermissionsProvider,
  GRANT_RETRY_AFTER_DEFAULT_S,
  GRANT_SYNC_MAX_MUTATIONS,
  grantErrorCodeOf,
  isConnectionLevelGrantError,
  retryAfterSecondsOf,
} from '../../src/worker/drive/permissions';
import { createDriveTransport } from '../../src/worker/drive/transport';
import type {
  CoordinatorTokenSource,
  ResolvedWriter,
  TokenIdentity,
  TokenResult,
} from '../../src/worker/drive/types';

interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
}

function stubFetch(handler: (req: RecordedRequest) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url,
    );
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body =
      init?.body === undefined || init.body === null
        ? undefined
        : typeof init.body === 'string'
          ? init.body
          : await new Response(init.body).text();
    const req: RecordedRequest = {
      method: init?.method ?? 'GET',
      url,
      headers,
      ...(body === undefined ? {} : { body }),
    };
    requests.push(req);
    return handler(req);
  };
  return { fetchImpl, requests };
}

function jsonResponse(json: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function googleError(status: number, reasons: string[], headers: Record<string, string> = {}): Response {
  return jsonResponse(
    {
      error: {
        code: status,
        message: 'upstream detail that must never reach a DTO',
        errors: reasons.map((reason) => ({ reason, message: 'upstream detail' })),
      },
    },
    status,
    headers,
  );
}

class FakeTokenSource implements CoordinatorTokenSource {
  readonly identities: TokenIdentity[] = [];
  getToken(identity: TokenIdentity): Promise<TokenResult> {
    this.identities.push(identity);
    return Promise.resolve({ ok: true, accessToken: 'tok-1', expiresAtMs: Date.now() + 3_600_000 });
  }
  reportFailure(): Promise<void> {
    return Promise.resolve();
  }
}

const WRITER: ResolvedWriter = {
  connectionId: 'conn-w',
  principalId: 'perm-9',
  oauthClientId: 'client-1',
  projectId: 'proj-1',
  connectionVersion: 3,
  oauthClientVersion: 2,
};
const SA_EMAIL = 'dw-sa-01@drive-worker-sa.iam.gserviceaccount.com';

function setup(handler: (req: RecordedRequest) => Response | Promise<Response>) {
  const { fetchImpl, requests } = stubFetch(handler);
  const source = new FakeTokenSource();
  const provider = createDrivePermissionsProvider({
    tokenSource: source,
    transport: createDriveTransport('google_oauth', { fetchImpl, retry: { maxAttempts: 1 } }),
  });
  const transport = createDriveTransport('google_oauth', { fetchImpl });
  return { provider, requests, source, transport };
}

describe('permissions transport operations', () => {
  it('pins list to supportsAllDrives and the fixed fields', async () => {
    const { provider, requests, source } = setup(() =>
      jsonResponse({
        permissions: [
          { id: 'p1', type: 'user', role: 'reader', emailAddress: SA_EMAIL },
          { id: 'p2', type: 'anyone', role: 'reader' },
        ],
        nextPageToken: 'next-1',
      }),
    );
    const page = await provider.listPermissions({ writer: WRITER, fileId: 'root-1', pageSize: 500, pageToken: 'tok' });
    const req = requests[0]!;
    expect(req.method).toBe('GET');
    expect(req.url.pathname).toBe('/drive/v3/files/root-1/permissions');
    expect(req.url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(req.url.searchParams.get('fields')).toBe('permissions(id,type,role,emailAddress),nextPageToken');
    expect(req.url.searchParams.get('pageSize')).toBe('100');
    expect(req.url.searchParams.get('pageToken')).toBe('tok');
    expect(page.nextPageToken).toBe('next-1');
    expect(page.permissions).toEqual([
      { id: 'p1', type: 'user', role: 'reader', emailAddress: SA_EMAIL },
      { id: 'p2', type: 'anyone', role: 'reader' },
    ]);
    expect(source.identities[0]).toMatchObject({ provider: 'google_oauth', credentialId: 'conn-w' });
  });

  it('pins create to the reader body, no notification e-mail and fields=id', async () => {
    const { provider, requests } = setup(() => jsonResponse({ id: 'perm-new' }));
    const created = await provider.createReaderPermission({ writer: WRITER, fileId: 'root-1', emailAddress: SA_EMAIL });
    expect(created).toEqual({ id: 'perm-new' });
    const req = requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.url.pathname).toBe('/drive/v3/files/root-1/permissions');
    expect(req.url.searchParams.get('sendNotificationEmail')).toBe('false');
    expect(req.url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(req.url.searchParams.get('fields')).toBe('id');
    expect(JSON.parse(req.body ?? '{}')).toEqual({ type: 'user', role: 'reader', emailAddress: SA_EMAIL });
  });

  it('pins delete to supportsAllDrives and accepts 204', async () => {
    const { provider, requests } = setup(() => new Response(null, { status: 204 }));
    await provider.deletePermission({ writer: WRITER, fileId: 'root-1', permissionId: 'perm-77' });
    const req = requests[0]!;
    expect(req.method).toBe('DELETE');
    expect(req.url.pathname).toBe('/drive/v3/files/root-1/permissions/perm-77');
    expect(req.url.searchParams.get('supportsAllDrives')).toBe('true');
  });

  it('rejects a body that overrides role, type, extra fields or the address syntax before fetch', async () => {
    const { transport, requests } = setup(() => {
      throw new Error('fetch must never run');
    });
    const send = (json: unknown) =>
      transport.send({
        operation: 'oauth.permissions.create',
        token: 't',
        path: '/drive/v3/files/root-1/permissions',
        query: { sendNotificationEmail: false, supportsAllDrives: true, fields: 'id' },
        body: { kind: 'json', json },
      });
    for (const bad of [
      { type: 'user', role: 'writer', emailAddress: SA_EMAIL },
      { type: 'user', role: 'owner', emailAddress: SA_EMAIL },
      { type: 'anyone', role: 'reader', emailAddress: SA_EMAIL },
      { type: 'user', role: 'reader', emailAddress: SA_EMAIL, allowFileDiscovery: true },
      { type: 'user', role: 'reader', emailAddress: SA_EMAIL, domain: 'example.com' },
      { type: 'user', role: 'reader' },
      { type: 'user', role: 'reader', emailAddress: 'Name <a@b.example>' },
      { type: 'user', role: 'reader', emailAddress: 'no-at-sign' },
      { type: 'user', role: 'reader', emailAddress: 42 },
      ['user', 'reader', SA_EMAIL],
      null,
    ]) {
      await expect(send(bad), JSON.stringify(bad)).rejects.toMatchObject({ reason: 'invalid-input' });
    }
    await expect(
      transport.send({
        operation: 'oauth.permissions.create',
        token: 't',
        path: '/drive/v3/files/root-1/permissions',
        query: { sendNotificationEmail: false, supportsAllDrives: true, fields: 'id' },
      }),
    ).rejects.toMatchObject({ reason: 'invalid-input' });
    expect(requests).toHaveLength(0);
  });

  it('rejects query overrides: notification e-mail, missing supportsAllDrives, other fields', async () => {
    const { transport, requests } = setup(() => {
      throw new Error('fetch must never run');
    });
    const body = { kind: 'json', json: { type: 'user', role: 'reader', emailAddress: SA_EMAIL } } as const;
    const create = (query: Record<string, string | boolean>) =>
      transport.send({
        operation: 'oauth.permissions.create',
        token: 't',
        path: '/drive/v3/files/root-1/permissions',
        query,
        body,
      });
    await expect(create({ sendNotificationEmail: true, supportsAllDrives: true, fields: 'id' })).rejects.toMatchObject({ reason: 'destination-refused' });
    await expect(create({ supportsAllDrives: true, fields: 'id' })).rejects.toMatchObject({ reason: 'destination-refused' });
    await expect(create({ sendNotificationEmail: false, fields: 'id' })).rejects.toMatchObject({ reason: 'destination-refused' });
    await expect(create({ sendNotificationEmail: false, supportsAllDrives: true, fields: '*' })).rejects.toMatchObject({ reason: 'destination-refused' });
    await expect(
      create({ sendNotificationEmail: false, supportsAllDrives: true, fields: 'id', transferOwnership: true }),
    ).rejects.toMatchObject({ reason: 'destination-refused' });
    await expect(
      transport.send({
        operation: 'oauth.permissions.delete',
        token: 't',
        path: '/drive/v3/files/root-1/permissions/p1',
      }),
    ).rejects.toMatchObject({ reason: 'destination-refused' });
    await expect(
      transport.send({
        operation: 'oauth.permissions.list',
        token: 't',
        path: '/drive/v3/files/root-1/permissions',
        query: { supportsAllDrives: true, fields: '*' },
      }),
    ).rejects.toMatchObject({ reason: 'destination-refused' });
    expect(requests).toHaveLength(0);
  });

  it('is unavailable to the service-account transport', async () => {
    const { requests } = setup(() => {
      throw new Error('fetch must never run');
    });
    const sa = createDriveTransport('service_account');
    for (const operation of ['oauth.permissions.list', 'oauth.permissions.create', 'oauth.permissions.delete'] as const) {
      await expect(
        sa.send({ operation, token: 't', path: '/drive/v3/files/root-1/permissions' }),
      ).rejects.toMatchObject({ reason: 'operation-not-allowed' });
    }
    expect(requests).toHaveLength(0);
  });

  it('refuses ids that are not plain Drive ids', async () => {
    const { provider, requests } = setup(() => {
      throw new Error('fetch must never run');
    });
    await expect(provider.listPermissions({ writer: WRITER, fileId: 'a/b' })).rejects.toMatchObject({ reason: 'invalid-input' });
    await expect(
      provider.deletePermission({ writer: WRITER, fileId: 'root-1', permissionId: '../x' }),
    ).rejects.toMatchObject({ reason: 'invalid-input' });
    expect(requests).toHaveLength(0);
  });

  it('does not replay a failed create inside the transport', async () => {
    const { fetchImpl, requests } = stubFetch(() => googleError(503, []));
    const provider = createDrivePermissionsProvider({
      tokenSource: new FakeTokenSource(),
      transport: createDriveTransport('google_oauth', { fetchImpl, sleep: () => Promise.resolve() }),
    });
    await expect(
      provider.createReaderPermission({ writer: WRITER, fileId: 'root-1', emailAddress: SA_EMAIL }),
    ).rejects.toMatchObject({ reason: 'upstream-unavailable' });
    expect(requests).toHaveLength(1);
  });
});

describe('grant error mapping', () => {
  async function failure(status: number, reasons: string[], headers: Record<string, string> = {}): Promise<DriveError> {
    const { provider } = setup(() => googleError(status, reasons, headers));
    const err: unknown = await provider
      .createReaderPermission({ writer: WRITER, fileId: 'root-1', emailAddress: SA_EMAIL })
      .then(() => undefined, (e: unknown) => e);
    expect(err).toBeInstanceOf(DriveError);
    return err as DriveError;
  }

  it('maps every rate-limit shape to grant:rate_limited and honours Retry-After', async () => {
    const sharing = await failure(403, ['sharingRateLimitExceeded'], { 'retry-after': '45' });
    expect(grantErrorCodeOf(sharing)).toBe('grant:rate_limited');
    expect(retryAfterSecondsOf(sharing)).toBe(45);
    expect(grantErrorCodeOf(await failure(403, ['userRateLimitExceeded']))).toBe('grant:rate_limited');
    const tooMany = await failure(429, []);
    expect(grantErrorCodeOf(tooMany)).toBe('grant:rate_limited');
    expect(retryAfterSecondsOf(tooMany)).toBe(GRANT_RETRY_AFTER_DEFAULT_S);
    expect(retryAfterSecondsOf(classifyHttpStatus(429, { retryAfterMs: 1500 }))).toBe(2);
  });

  it('maps the other upstream failures to stable codes', async () => {
    expect(grantErrorCodeOf(await failure(403, ['insufficientFilePermissions']))).toBe('grant:forbidden');
    expect(grantErrorCodeOf(await failure(404, ['notFound']))).toBe('grant:not_found');
    expect(grantErrorCodeOf(await failure(400, ['invalidSharingRequest']))).toBe('grant:invalid_principal');
    expect(grantErrorCodeOf(await failure(500, []))).toBe('grant:upstream');
    expect(grantErrorCodeOf(await failure(403, ['dailyLimitExceeded']))).toBe('grant:upstream');
  });

  it('never carries upstream message text in the stable code', async () => {
    const err = await failure(403, ['insufficientFilePermissions']);
    expect(grantErrorCodeOf(err)).not.toContain('upstream detail');
  });

  it('treats an unusable writer connection as connection-level, not a per-grant failure', async () => {
    expect(isConnectionLevelGrantError(await failure(401, []))).toBe(true);
    expect(isConnectionLevelGrantError(new DriveError('credential-disabled', 'x'))).toBe(true);
    expect(isConnectionLevelGrantError(await failure(403, ['sharingRateLimitExceeded']))).toBe(false);
    expect(isConnectionLevelGrantError(await failure(404, []))).toBe(false);
  });

  it('exposes the spec constants', () => {
    expect(GRANT_SYNC_MAX_MUTATIONS).toBe(20);
    expect(GRANT_RETRY_AFTER_DEFAULT_S).toBe(30);
  });
});
