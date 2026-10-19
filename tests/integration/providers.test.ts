import { env } from 'cloudflare:workers';
import { applyD1Migrations, type D1Migration } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import {
  classifyHttpStatus,
  driveErrorToApiCode,
  DriveError,
  failureKindForDriveError,
  parseRetryAfterMs,
  tokenResultToDriveError,
} from '../../src/worker/drive/errors';
import {
  assertUploadSessionUri,
  createDriveTransport,
  drivePathSegment,
  validateDriveId,
} from '../../src/worker/drive/transport';
import { createCoordinatorTokenSource } from '../../src/worker/drive/coordinator-client';
import type { MountScope } from '../../src/worker/drive/containment';
import { createGoogleOAuthProvider } from '../../src/worker/drive/providers/google-oauth';
import { createServiceAccountReadProvider } from '../../src/worker/drive/providers/service-account-read';
import type {
  CoordinatorTokenSource,
  ReadIdentity,
  ResolvedWriter,
  TokenFailureKind,
  TokenIdentity,
  TokenResult,
} from '../../src/worker/drive/types';

// ---------------------------------------------------------------------------
// Fetch stub: a `typeof fetch` double injected into the transport. Records
// every request (method, URL, headers, drained body) and routes to a scripted
// reply. `cloudflare:test` in this plugin version exposes no outbound
// fetchMock, so the real workerd fetch boundary is covered separately in
// protocol-spike.test.ts via a Durable Object fetch bridge.
// ---------------------------------------------------------------------------

interface RecordedRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body?: string;
}

type StubHandler = (
  req: RecordedRequest,
) => Response | Promise<Response>;

function stubFetch(handler: StubHandler): {
  fetchImpl: typeof fetch;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url,
    );
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    let body: string | undefined;
    if (init?.body !== undefined && init.body !== null) {
      body =
        typeof init.body === 'string'
          ? init.body
          : await new Response(init.body).text();
    }
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

/** Queue-style stub: each request consumes the next scripted reply. */
function queueFetch(
  replies: Array<Response | ((req: RecordedRequest) => Response | Promise<Response>)>,
): { fetchImpl: typeof fetch; requests: RecordedRequest[] } {
  const queue = [...replies];
  return stubFetch((req) => {
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`unexpected extra request: ${req.method} ${req.url}`);
    }
    return typeof next === 'function' ? next(req) : next;
  });
}

function jsonResponse(
  json: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function googleErrorResponse(
  status: number,
  reasons: string[],
  message = 'upstream message',
): Response {
  return jsonResponse(
    {
      error: {
        code: status,
        message,
        errors: reasons.map((reason) => ({ reason, message })),
      },
    },
    status,
  );
}

// ---------------------------------------------------------------------------
// Token source double: records identities, scripted results, failures.
// ---------------------------------------------------------------------------

class FakeTokenSource implements CoordinatorTokenSource {
  readonly calls: Array<{
    identity: TokenIdentity;
    options?: { fileId?: string };
  }> = [];
  readonly failures: Array<{
    identity: TokenIdentity;
    kind: TokenFailureKind;
    retryAfterMs?: number;
    fileId?: string;
  }> = [];
  script: TokenResult[] = [];
  private index = 0;

  getToken(
    identity: TokenIdentity,
    options?: { fileId?: string },
  ): Promise<TokenResult> {
    this.calls.push({ identity, ...(options === undefined ? {} : { options }) });
    const next =
      this.script.length === 0
        ? ({
            ok: true,
            accessToken: `tok-${++this.index}`,
            expiresAtMs: Date.now() + 3_600_000,
          } as const)
        : (this.script[Math.min(this.index++, this.script.length - 1)] ??
          this.script[this.script.length - 1]);
    return Promise.resolve(next as TokenResult);
  }

  reportFailure(
    identity: TokenIdentity,
    info: { kind: TokenFailureKind; retryAfterMs?: number; fileId?: string },
  ): Promise<void> {
    this.failures.push({ identity, ...info });
    return Promise.resolve();
  }
}

const TEST_MIGRATIONS = JSON.parse(
  (env as unknown as { TEST_MIGRATIONS: string }).TEST_MIGRATIONS,
) as D1Migration[];

const WRITER: ResolvedWriter = {
  connectionId: 'conn-1',
  principalId: 'perm-9',
  oauthClientId: 'client-1',
  projectId: 'proj-1',
  connectionVersion: 3,
  oauthClientVersion: 2,
};

const READER: ReadIdentity = {
  serviceAccountId: 'sa-1',
  serviceAccountVersion: 4,
  email: 'sa-1@proj-1.iam.gserviceaccount.com',
  projectId: 'proj-1',
};

const SHARED_SCOPE: MountScope = {
  mountId: 'mount-1',
  rootFolderId: 'drive-7',
  driveId: 'drive-7',
};
const MY_DRIVE_SCOPE: MountScope = {
  mountId: 'mount-2',
  rootFolderId: 'folder-root',
  driveId: null,
};

function fileJson(overrides: Record<string, unknown> = {}) {
  return {
    id: 'file-1',
    name: 'doc.txt',
    mimeType: 'text/plain',
    size: '12',
    modifiedTime: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Allowlist + destination policy
// ---------------------------------------------------------------------------

describe('operation allowlist', () => {
  it('blocks every OAuth-named operation on the SA transport before fetch', async () => {
    const transport = createDriveTransport('service_account');
    await expect(
      transport.send({
        operation: 'oauth.files.create',
        token: 't',
        path: '/drive/v3/files',
        body: { kind: 'json', json: {} },
      }),
    ).rejects.toMatchObject({ reason: 'operation-not-allowed' });
  });

  it('blocks SA-named operations on the OAuth transport', async () => {
    const transport = createDriveTransport('google_oauth');
    await expect(
      transport.send({
        operation: 'sa.files.media',
        token: 't',
        path: '/drive/v3/files/x',
      }),
    ).rejects.toMatchObject({ reason: 'operation-not-allowed' });
  });

  it('pins the method on the operation spec — SA ops stay GET', async () => {
    const { fetchImpl, requests } = stubFetch(() => jsonResponse(fileJson()));
    const transport = createDriveTransport('service_account', { fetchImpl });
    const res = await transport.send({
      operation: 'sa.files.get',
      token: 't',
      path: '/drive/v3/files/file-1',
    });
    expect(res.status).toBe(200);
    expect(requests[0]?.method).toBe('GET');
  });
});

describe('destination policy', () => {
  it('accepts only resumable upload session URIs on the Google upload host', () => {
    expect(
      assertUploadSessionUri(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=abc123',
      ),
    ).toContain('upload_id=abc123');
    for (const bad of [
      'https://evil.example.com/upload/drive/v3/files?upload_id=x',
      'http://www.googleapis.com/upload/drive/v3/files?upload_id=x',
      'https://www.googleapis.com/drive/v3/files?upload_id=x',
      'https://lh3.googleusercontent.com/drive-storage/x',
      'not a url',
      'https://www.googleapis.com:8443/upload/drive/v3/files',
    ]) {
      expect(() => assertUploadSessionUri(bad)).toThrowError(DriveError);
    }
  });

  it('refuses absolute URLs outside the thumbnail host allowlist', async () => {
    const { fetchImpl, requests } = stubFetch(() => {
      throw new Error('fetch must never run');
    });
    const transport = createDriveTransport('service_account', { fetchImpl });
    for (const bad of [
      'https://evil.example.com/t.png',
      'https://googleusercontent.com.evil.example.com/t.png',
      'http://lh3.googleusercontent.com/t.png',
      'https://user:pass@lh3.googleusercontent.com/t.png',
    ]) {
      await expect(
        transport.send({
          operation: 'sa.thumbnail.fetch',
          token: 't',
          absoluteUrl: bad,
        }),
      ).rejects.toMatchObject({ reason: 'destination-refused' });
    }
    expect(requests).toHaveLength(0);
  });

  it('refuses paths that escape the required API prefix', async () => {
    const { fetchImpl, requests } = stubFetch(() => {
      throw new Error('fetch must never run');
    });
    const transport = createDriveTransport('google_oauth', { fetchImpl });
    await expect(
      transport.send({
        operation: 'oauth.files.get',
        token: 't',
        path: '/drive/v3/../oauth2/token',
      }),
    ).rejects.toMatchObject({ reason: 'destination-refused' });
    await expect(
      transport.send({
        operation: 'oauth.upload.start',
        token: 't',
        path: '/drive/v3/files',
      }),
    ).rejects.toMatchObject({ reason: 'destination-refused' });
    expect(requests).toHaveLength(0);
  });

  it('validates Drive IDs before they reach a URL or query', () => {
    expect(drivePathSegment('aZ09_-x', 'op')).toBe('aZ09_-x');
    for (const bad of ['a/b', 'a b', 'a%20b', "a'b", '', 'a?x=1']) {
      expect(() => validateDriveId(bad, 'op')).toThrowError(DriveError);
      expect(() => drivePathSegment(bad, 'op')).toThrowError(DriveError);
    }
  });

  it('rejects a protocol-relative path that would carry the bearer off-host', async () => {
    const { fetchImpl, requests } = stubFetch(() => {
      throw new Error('fetch must never run');
    });
    const transport = createDriveTransport('google_oauth', { fetchImpl });
    for (const bad of [
      '//evil.example.com/drive/v3/files/x',
      '//www.googleapis.com.evil.example.com/drive/v3/files/x',
      '/\\evil.example.com/drive/v3/files/x',
      '/drive/v3/files?alt=media',
      '/drive/v3/../%2e%2e/oauth2/token',
      '/drive/v3/#fragment',
    ]) {
      await expect(
        transport.send({
          operation: 'oauth.files.get',
          token: 't',
          path: bad,
        }),
      ).rejects.toThrowError(DriveError);
    }
    expect(requests).toHaveLength(0);
  });

  it('constrains operations to their own route and query shape', async () => {
    const { fetchImpl, requests } = stubFetch(() => {
      throw new Error('fetch must never run');
    });
    const saTransport = createDriveTransport('service_account', { fetchImpl });
    const oauthTransport = createDriveTransport('google_oauth', { fetchImpl });
    // sa.files.get on the collection path is a disguised catalog list.
    await expect(
      saTransport.send({
        operation: 'sa.files.get',
        token: 't',
        path: '/drive/v3/files',
      }),
    ).rejects.toMatchObject({ reason: 'destination-refused' });
    // oauth.files.get with alt=media crosses into the content surface.
    await expect(
      oauthTransport.send({
        operation: 'oauth.files.get',
        token: 't',
        path: '/drive/v3/files/f1',
        query: { alt: 'media' },
      }),
    ).rejects.toMatchObject({ reason: 'destination-refused' });
    // sa.files.media without alt=media is a disguised metadata read.
    await expect(
      saTransport.send({
        operation: 'sa.files.media',
        token: 't',
        path: '/drive/v3/files/f1',
        query: { fields: 'id' },
      }),
    ).rejects.toMatchObject({ reason: 'destination-refused' });
    // sa.files.export without a mimeType is refused.
    await expect(
      saTransport.send({
        operation: 'sa.files.export',
        token: 't',
        path: '/drive/v3/files/f1/export',
      }),
    ).rejects.toMatchObject({ reason: 'destination-refused' });
    expect(requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Structured errors
// ---------------------------------------------------------------------------

describe('files.list corpora rules', () => {
  const send = (query: Record<string, string | boolean | undefined>) => {
    const { fetchImpl, requests } = stubFetch(() => jsonResponse({ files: [] }));
    const transport = createDriveTransport('google_oauth', { fetchImpl });
    return {
      requests,
      result: transport.send({
        operation: 'oauth.files.list',
        token: 't',
        path: '/drive/v3/files',
        query,
      }),
    };
  };

  it('accepts a Shared Drive listing and a My Drive listing', async () => {
    const shared = send({
      q: 'trashed = false',
      corpora: 'drive',
      driveId: 'drive-1',
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    await expect(shared.result).resolves.toBeInstanceOf(Response);
    const mine = send({ q: 'trashed = false', corpora: 'user', supportsAllDrives: true });
    await expect(mine.result).resolves.toBeInstanceOf(Response);
    expect(mine.requests[0]?.url.searchParams.get('corpora')).toBe('user');
    expect(mine.requests[0]?.url.searchParams.has('driveId')).toBe(false);
  });

  it('refuses a missing or unknown corpora before fetch', async () => {
    for (const query of [
      { q: 'x', supportsAllDrives: true },
      { q: 'x', corpora: 'allDrives', supportsAllDrives: true },
      { q: 'x', corpora: 'domain', supportsAllDrives: true },
      { q: 'x', corpora: '', supportsAllDrives: true },
    ]) {
      const attempt = send(query);
      await expect(attempt.result, JSON.stringify(query)).rejects.toMatchObject({ reason: 'destination-refused' });
      expect(attempt.requests).toHaveLength(0);
    }
  });

  it('allows driveId and includeItemsFromAllDrives only with corpora=drive', async () => {
    for (const extra of [
      { driveId: 'drive-1' },
      { includeItemsFromAllDrives: true },
      { driveId: 'drive-1', includeItemsFromAllDrives: true },
    ]) {
      const attempt = send({ q: 'x', corpora: 'user', supportsAllDrives: true, ...extra });
      await expect(attempt.result, JSON.stringify(extra)).rejects.toMatchObject({ reason: 'destination-refused' });
      expect(attempt.requests).toHaveLength(0);
    }
    const noDrive = send({ q: 'x', corpora: 'drive', includeItemsFromAllDrives: true, supportsAllDrives: true });
    await expect(noDrive.result).rejects.toMatchObject({ reason: 'destination-refused' });
    expect(noDrive.requests).toHaveLength(0);
  });
});

describe('error classification', () => {
  it('maps Google reason tokens into Drive failure reasons', () => {
    expect(classifyHttpStatus(401).reason).toBe('unauthorized');
    expect(classifyHttpStatus(404).reason).toBe('not-found');
    expect(classifyHttpStatus(409).reason).toBe('conflict');
    expect(classifyHttpStatus(410).reason).toBe('gone');
    expect(classifyHttpStatus(412).reason).toBe('precondition-failed');
    expect(classifyHttpStatus(429).reason).toBe('rate-limited');
    expect(classifyHttpStatus(503).reason).toBe('upstream-unavailable');
    expect(classifyHttpStatus(302).reason).toBe('unexpected-redirect');
    expect(
      classifyHttpStatus(403, { googleReasons: ['rateLimitExceeded'] }).reason,
    ).toBe('rate-limited');
    expect(
      classifyHttpStatus(403, { googleReasons: ['userRateLimitExceeded'] })
        .reason,
    ).toBe('rate-limited');
    expect(
      classifyHttpStatus(403, { googleReasons: ['dailyLimitExceeded'] }).reason,
    ).toBe('quota-exceeded');
    expect(
      classifyHttpStatus(403, { googleReasons: ['storageQuotaExceeded'] })
        .reason,
    ).toBe('storage-full');
    expect(
      classifyHttpStatus(403, { googleReasons: ['cannotDownloadFile'] }).reason,
    ).toBe('download-restricted');
    expect(
      classifyHttpStatus(403, { googleReasons: ['insufficientPermissions'] })
        .reason,
    ).toBe('permission-denied');
    expect(classifyHttpStatus(403, { googleReasons: [] }).reason).toBe(
      'permission-denied',
    );
  });

  it('marks only the retryable classes retryable', () => {
    expect(classifyHttpStatus(429).retryable).toBe(true);
    expect(classifyHttpStatus(503).retryable).toBe(true);
    expect(
      classifyHttpStatus(403, { googleReasons: ['rateLimitExceeded'] })
        .retryable,
    ).toBe(true);
    expect(classifyHttpStatus(403, { googleReasons: [] }).retryable).toBe(false);
    expect(classifyHttpStatus(404).retryable).toBe(false);
  });

  it('parses Retry-After in seconds and caps absurd values', () => {
    expect(parseRetryAfterMs('5')).toBe(5000);
    expect(parseRetryAfterMs('999999')).toBe(300000);
    expect(parseRetryAfterMs('garbage')).toBeUndefined();
    expect(parseRetryAfterMs(null)).toBeUndefined();
  });

  it('translates TokenResult failures without losing the admission code', () => {
    const cases = [
      ['CREDENTIAL_DISABLED', 'credential-disabled'],
      ['CREDENTIAL_VERSION_CHANGED', 'credential-version-changed'],
      ['OAUTH_NEEDS_REAUTH', 'unauthorized'],
      ['UPSTREAM_AUTH_FAILED', 'unauthorized'],
      ['UPSTREAM_UNAVAILABLE', 'upstream-unavailable'],
      ['COOLDOWN', 'rate-limited'],
    ] as const;
    for (const [code, reason] of cases) {
      const err = tokenResultToDriveError({ ok: false, code }, 'op');
      expect(err.reason).toBe(reason);
    }
    const cooldown = tokenResultToDriveError(
      { ok: false, code: 'COOLDOWN', retryAfterMs: 1500 },
      'op',
    );
    expect(cooldown.retryAfterMs).toBe(1500);
    expect(cooldown.retryable).toBe(true);
  });

  it('maps failures to API codes per provider and surface', () => {
    const mk = (reason: DriveError['reason']) => new DriveError(reason, 'm');
    const oauth = { provider: 'google_oauth', surface: 'catalog' } as const;
    const sa = { provider: 'service_account', surface: 'content' } as const;
    expect(driveErrorToApiCode(mk('unauthorized'), oauth)).toBe(
      'GOOGLE_REAUTH_REQUIRED',
    );
    expect(driveErrorToApiCode(mk('unauthorized'), sa)).toBe(
      'READ_PROVIDER_UNAVAILABLE',
    );
    expect(driveErrorToApiCode(mk('credential-disabled'), oauth)).toBe(
      'GOOGLE_CONNECTION_DISABLED',
    );
    expect(driveErrorToApiCode(mk('credential-disabled'), sa)).toBe(
      'READ_PROVIDER_UNAVAILABLE',
    );
    expect(driveErrorToApiCode(mk('permission-denied'), sa)).toBe(
      'FILE_NOT_READABLE_BY_POOL',
    );
    expect(driveErrorToApiCode(mk('not-found'), oauth)).toBe(
      'FILE_NOT_ACCESSIBLE',
    );
    expect(
      driveErrorToApiCode(mk('not-found'), {
        provider: 'google_oauth',
        surface: 'upload-session',
      }),
    ).toBe('UPLOAD_EXPIRED');
    expect(driveErrorToApiCode(mk('rate-limited'), oauth)).toBe('RATE_LIMITED');
    expect(driveErrorToApiCode(mk('quota-exceeded'), oauth)).toBe(
      'PROJECT_LIMITED',
    );
    expect(driveErrorToApiCode(mk('storage-full'), oauth)).toBe('STORAGE_FULL');
    expect(driveErrorToApiCode(mk('download-restricted'), sa)).toBe(
      'FILE_NOT_READABLE_BY_POOL',
    );
    expect(driveErrorToApiCode(mk('conflict'), oauth)).toBe('FILE_CONFLICT');
    expect(driveErrorToApiCode(mk('upstream-unavailable'), oauth)).toBe(
      'DRIVE_UNAVAILABLE',
    );
    expect(driveErrorToApiCode(mk('upstream-unavailable'), sa)).toBe(
      'READ_PROVIDER_UNAVAILABLE',
    );
    expect(
      driveErrorToApiCode(mk('aborted'), {
        provider: 'google_oauth',
        surface: 'upload',
      }),
    ).toBe('UPLOAD_NEEDS_RECONCILIATION');
    expect(driveErrorToApiCode(mk('operation-not-allowed'), oauth)).toBe(
      'INTERNAL_ERROR',
    );
  });

  it('derives coordinator failure kinds only from credential-health errors', () => {
    const mk = (reason: DriveError['reason']) => new DriveError(reason, 'm');
    expect(failureKindForDriveError(mk('unauthorized'))).toBe('auth');
    expect(failureKindForDriveError(mk('rate-limited'))).toBe('rate_limit');
    expect(failureKindForDriveError(mk('quota-exceeded'))).toBe('rate_limit');
    expect(failureKindForDriveError(mk('download-restricted'))).toBe(
      'file_limited',
    );
    expect(failureKindForDriveError(mk('upstream-unavailable'))).toBe(
      'upstream_5xx',
    );
    expect(failureKindForDriveError(mk('aborted'))).toBeUndefined();
    expect(failureKindForDriveError(mk('invalid-input'))).toBeUndefined();
    expect(failureKindForDriveError(mk('not-found'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Bounded retries
// ---------------------------------------------------------------------------

describe('bounded retries', () => {
  const silent = { sleep: () => Promise.resolve(), random: () => 0 };

  it('retries a replayable op on 500 then succeeds', async () => {
    const { fetchImpl, requests } = queueFetch([
      googleErrorResponse(500, []),
      jsonResponse({ ok: true }),
    ]);
    const transport = createDriveTransport('google_oauth', {
      fetchImpl,
      ...silent,
    });
    const res = await transport.send({
      operation: 'oauth.files.get',
      token: 't',
      path: '/drive/v3/files/f1',
    });
    expect(res.status).toBe(200);
    expect(requests).toHaveLength(2);
  });

  it('gives up after the attempt budget', async () => {
    const { fetchImpl, requests } = queueFetch([
      googleErrorResponse(503, []),
      googleErrorResponse(503, []),
      googleErrorResponse(503, []),
      googleErrorResponse(503, []),
    ]);
    const transport = createDriveTransport('google_oauth', {
      fetchImpl,
      ...silent,
      retry: { maxAttempts: 4 },
    });
    await expect(
      transport.send({
        operation: 'oauth.files.get',
        token: 't',
        path: '/drive/v3/files/f1',
      }),
    ).rejects.toMatchObject({ reason: 'upstream-unavailable' });
    expect(requests).toHaveLength(4);
  });

  it('never sleeps past the Retry-After cap — surfaces it instead', async () => {
    const { fetchImpl, requests } = queueFetch([
      jsonResponse(googleErrorBody(429, ['rateLimitExceeded']), 429, {
        'retry-after': '400',
      }),
    ]);
    const transport = createDriveTransport('google_oauth', {
      fetchImpl,
      ...silent,
    });
    const err = await transport
      .send({
        operation: 'oauth.files.get',
        token: 't',
        path: '/drive/v3/files/f1',
      })
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ reason: 'rate-limited', retryAfterMs: 300000 });
    expect(requests).toHaveLength(1);
  });

  it('does not retry permission errors', async () => {
    const { fetchImpl, requests } = queueFetch([
      googleErrorResponse(403, ['insufficientPermissions']),
    ]);
    const transport = createDriveTransport('google_oauth', {
      fetchImpl,
      ...silent,
    });
    await expect(
      transport.send({
        operation: 'oauth.files.get',
        token: 't',
        path: '/drive/v3/files/f1',
      }),
    ).rejects.toMatchObject({ reason: 'permission-denied', status: 403 });
    expect(requests).toHaveLength(1);
  });

  it('never retries a streamed request body', async () => {
    const { fetchImpl, requests } = queueFetch([
      googleErrorResponse(500, []),
      jsonResponse({ ok: true }),
    ]);
    const transport = createDriveTransport('google_oauth', {
      fetchImpl,
      ...silent,
    });
    await expect(
      transport.send({
        operation: 'oauth.upload.chunk',
        token: 't',
        absoluteUrl:
          'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=s1',
        body: {
          kind: 'stream',
          stream: new ReadableStream<Uint8Array>({
            start(c) {
              c.enqueue(new TextEncoder().encode('abc'));
              c.close();
            },
          }),
          bytes: 3,
        },
      }),
    ).rejects.toMatchObject({ reason: 'upstream-unavailable' });
    expect(requests).toHaveLength(1);
  });
});

function googleErrorBody(status: number, reasons: string[]) {
  return {
    error: {
      code: status,
      message: 'upstream message',
      errors: reasons.map((reason) => ({ reason, message: 'upstream message' })),
    },
  };
}

// ---------------------------------------------------------------------------
// OAuth provider flows
// ---------------------------------------------------------------------------

describe('GoogleOAuthProvider', () => {
  it('lists children with Shared Drive flags and maps entry kinds', async () => {
    const { fetchImpl, requests } = stubFetch((req) => {
      expect(req.method).toBe('GET');
      expect(req.url.pathname).toBe('/drive/v3/files');
      return jsonResponse({
        nextPageToken: 'tok-2',
        files: [
          fileJson({ id: 'f1', mimeType: 'text/plain' }),
          fileJson({
            id: 'd1',
            name: 'dir',
            mimeType: 'application/vnd.google-apps.folder',
          }),
          fileJson({
            id: 's1',
            name: 'link',
            mimeType: 'application/vnd.google-apps.shortcut',
            shortcutDetails: { targetId: 't-9' },
            thumbnailLink: 'https://lh3.googleusercontent.com/x',
          }),
        ],
      });
    });
    const source = new FakeTokenSource();
    const provider = createGoogleOAuthProvider({
      tokenSource: source,
      transport: createDriveTransport('google_oauth', { fetchImpl }),
    });
    const page = await provider.listChildren({
      writer: WRITER,
      scope: SHARED_SCOPE,
      parentFolderId: 'root',
      pageSize: 5000,
    });
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.url.searchParams.get('q')).toBe(
      "'root' in parents and trashed = false",
    );
    expect(req.url.searchParams.get('corpora')).toBe('drive');
    expect(req.url.searchParams.get('driveId')).toBe('drive-7');
    expect(req.url.searchParams.get('includeItemsFromAllDrives')).toBe('true');
    expect(req.url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(req.url.searchParams.get('pageSize')).toBe('1000');
    expect(req.headers.authorization).toBe('Bearer tok-1');
    expect(page.nextPageToken).toBe('tok-2');
    expect(page.entries.map((e) => e.kind)).toEqual([
      'file',
      'folder',
      'shortcut',
    ]);
    expect(page.entries[2]?.shortcutTargetId).toBe('t-9');
    expect(page.entries[2]?.hasThumbnail).toBe(true);
    // thumbnailLink must never leak through the internal entry shape.
    expect('thumbnailLink' in (page.entries[2] ?? {})).toBe(false);
    // Token identity: pinned writer + required versions + drive scope.
    expect(source.calls[0]?.identity).toMatchObject({
      provider: 'google_oauth',
      credentialId: 'conn-1',
      credentialVersion: 3,
      oauthClientId: 'client-1',
      oauthClientVersion: 2,
      principalId: 'perm-9',
      projectId: 'proj-1',
      scopes: ['https://www.googleapis.com/auth/drive'],
    });
  });

  it('escapes search terms and scopes folder search to direct children', async () => {
    const { fetchImpl, requests } = stubFetch(() =>
      jsonResponse({ files: [] }),
    );
    const provider = createGoogleOAuthProvider({
      tokenSource: new FakeTokenSource(),
      transport: createDriveTransport('google_oauth', { fetchImpl }),
    });
    await provider.search({
      writer: WRITER,
      scope: { ...SHARED_SCOPE, rootFolderId: 'd1', driveId: 'd1' },
      query: `it's a \\ test`,
      searchScope: 'folder',
      folderId: 'fld-1',
    });
    expect(requests[0]?.url.searchParams.get('q')).toBe(
      `name contains 'it\\'s a \\\\ test' and trashed = false and 'fld-1' in parents`,
    );
  });

  it('lists a My Drive folder with corpora=user and no Shared Drive parameters', async () => {
    const { fetchImpl, requests } = stubFetch(() =>
      jsonResponse({ files: [fileJson({ id: 'f1' })] }),
    );
    const provider = createGoogleOAuthProvider({
      tokenSource: new FakeTokenSource(),
      transport: createDriveTransport('google_oauth', { fetchImpl }),
    });
    const page = await provider.listChildren({
      writer: WRITER,
      scope: MY_DRIVE_SCOPE,
      parentFolderId: 'folder-root',
    });
    expect(page.entries.map((e) => e.id)).toEqual(['f1']);
    const params = requests[0]!.url.searchParams;
    expect(params.get('q')).toBe("'folder-root' in parents and trashed = false");
    expect(params.get('corpora')).toBe('user');
    expect(params.get('supportsAllDrives')).toBe('true');
    expect(params.has('driveId')).toBe(false);
    expect(params.has('includeItemsFromAllDrives')).toBe(false);
    expect(params.get('orderBy')).toBe('folder,name_natural');
  });

  it('searches My Drive by folder or whole corpus without leaking a driveId', async () => {
    const { fetchImpl, requests } = stubFetch(() => jsonResponse({ files: [] }));
    const provider = createGoogleOAuthProvider({
      tokenSource: new FakeTokenSource(),
      transport: createDriveTransport('google_oauth', { fetchImpl }),
    });
    await provider.search({
      writer: WRITER,
      scope: MY_DRIVE_SCOPE,
      query: 'report',
      searchScope: 'drive',
      pageSize: 100,
      pageToken: 'g-2',
    });
    await provider.search({
      writer: WRITER,
      scope: MY_DRIVE_SCOPE,
      query: 'report',
      searchScope: 'folder',
      folderId: 'fld-1',
    });
    expect(requests[0]!.url.searchParams.get('q')).toBe(
      "name contains 'report' and trashed = false",
    );
    expect(requests[0]!.url.searchParams.get('pageSize')).toBe('100');
    expect(requests[0]!.url.searchParams.get('pageToken')).toBe('g-2');
    expect(requests[1]!.url.searchParams.get('q')).toBe(
      "name contains 'report' and trashed = false and 'fld-1' in parents",
    );
    for (const req of requests) {
      expect(req.url.searchParams.get('corpora')).toBe('user');
      expect(req.url.searchParams.has('driveId')).toBe(false);
      expect(req.url.searchParams.has('includeItemsFromAllDrives')).toBe(false);
    }
  });

  it('requests and parses ownedByMe on file metadata', async () => {
    const { fetchImpl, requests } = stubFetch(() =>
      jsonResponse(fileJson({ ownedByMe: true, mimeType: 'application/vnd.google-apps.folder' })),
    );
    const provider = createGoogleOAuthProvider({
      tokenSource: new FakeTokenSource(),
      transport: createDriveTransport('google_oauth', { fetchImpl }),
    });
    const meta = await provider.getMetadata({ writer: WRITER, ref: { id: 'folder-root' } });
    expect(meta.ownedByMe).toBe(true);
    expect(requests[0]!.url.searchParams.get('fields')).toContain('ownedByMe');
    const absent = createGoogleOAuthProvider({
      tokenSource: new FakeTokenSource(),
      transport: createDriveTransport('google_oauth', {
        fetchImpl: stubFetch(() => jsonResponse(fileJson())).fetchImpl,
      }),
    });
    expect((await absent.getMetadata({ writer: WRITER, ref: { id: 'f' } })).ownedByMe).toBeUndefined();
  });

  it('rejects empty search and folder scope without folderId locally', async () => {
    const provider = createGoogleOAuthProvider({
      tokenSource: new FakeTokenSource(),
    });
    await expect(
      provider.search({
        writer: WRITER,
        scope: SHARED_SCOPE,
        query: '  ',
        searchScope: 'drive',
      }),
    ).rejects.toMatchObject({ reason: 'invalid-input' });
    await expect(
      provider.search({
        writer: WRITER,
        scope: SHARED_SCOPE,
        query: 'x',
        searchScope: 'folder',
      }),
    ).rejects.toMatchObject({ reason: 'invalid-input' });
  });

  it('sends resource keys on metadata reads', async () => {
    const { fetchImpl, requests } = stubFetch(() =>
      jsonResponse(fileJson()),
    );
    const provider = createGoogleOAuthProvider({
      tokenSource: new FakeTokenSource(),
      transport: createDriveTransport('google_oauth', { fetchImpl }),
    });
    await provider.getMetadata({
      writer: WRITER,
      ref: { id: 'file-1', resourceKey: 'rk-1' },
    });
    expect(requests[0]?.headers['x-goog-drive-resource-keys']).toBe(
      'file-1/rk-1',
    );
  });

  it('generates file IDs from the Drive endpoint', async () => {
    const { fetchImpl, requests } = stubFetch((req) => {
      expect(req.url.pathname).toBe('/drive/v3/files/generateIds');
      return jsonResponse({ ids: ['gen-id-1'], space: 'drive' });
    });
    const provider = createGoogleOAuthProvider({
      tokenSource: new FakeTokenSource(),
      transport: createDriveTransport('google_oauth', { fetchImpl }),
    });
    await expect(provider.generateId({ writer: WRITER })).resolves.toBe(
      'gen-id-1',
    );
    expect(requests[0]?.url.searchParams.get('space')).toBe('drive');
  });

  it('creates folders metadata-only with the pinned generated ID', async () => {
    const { fetchImpl, requests } = stubFetch((req) => {
      expect(req.method).toBe('POST');
      expect(req.url.pathname).toBe('/drive/v3/files');
      return jsonResponse(
        fileJson({ id: 'gen-1', mimeType: 'application/vnd.google-apps.folder' }),
      );
    });
    const provider = createGoogleOAuthProvider({
      tokenSource: new FakeTokenSource(),
      transport: createDriveTransport('google_oauth', { fetchImpl }),
    });
    const meta = await provider.createFolder({
      writer: WRITER,
      parentFolderId: 'parent-1',
      name: 'new dir',
      generatedId: 'gen-1',
    });
    expect(meta.id).toBe('gen-1');
    const body = JSON.parse(requests[0]!.body ?? '{}') as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      id: 'gen-1',
      name: 'new dir',
      mimeType: 'application/vnd.google-apps.folder',
      parents: ['parent-1'],
    });
  });

  it('starts a zero-byte upload as metadata-only create', async () => {
    const { fetchImpl, requests } = stubFetch((req) => {
      expect(req.method).toBe('POST');
      expect(req.url.pathname).toBe('/drive/v3/files');
      return jsonResponse(fileJson({ id: 'gen-2', size: '0' }));
    });
    const provider = createGoogleOAuthProvider({
      tokenSource: new FakeTokenSource(),
      transport: createDriveTransport('google_oauth', { fetchImpl }),
    });
    const start = await provider.startUpload({
      writer: WRITER,
      parentFolderId: 'p',
      name: 'empty.bin',
      mimeType: 'application/octet-stream',
      totalBytes: 0n,
      generatedFileId: 'gen-2',
    });
    expect(start.kind).toBe('created-empty');
    expect(requests).toHaveLength(1);
  });

  it('starts a resumable session and validates the returned URI', async () => {
    const { fetchImpl, requests } = stubFetch((req) => {
      expect(req.method).toBe('POST');
      expect(req.url.pathname).toBe('/upload/drive/v3/files');
      expect(req.url.searchParams.get('uploadType')).toBe('resumable');
      return jsonResponse({}, 200, {
        location:
          'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=sess-9',
      });
    });
    const provider = createGoogleOAuthProvider({
      tokenSource: new FakeTokenSource(),
      transport: createDriveTransport('google_oauth', { fetchImpl }),
    });
    const start = await provider.startUpload({
      writer: WRITER,
      parentFolderId: 'p-1',
      name: 'big.bin',
      mimeType: 'application/octet-stream',
      totalBytes: 10n,
      generatedFileId: 'gen-3',
    });
    expect(start).toEqual({
      kind: 'resumable',
      sessionUri:
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=sess-9',
      generatedFileId: 'gen-3',
    });
    expect(requests[0]?.headers['x-upload-content-length']).toBe('10');
    expect(requests[0]?.headers['x-upload-content-type']).toBe(
      'application/octet-stream',
    );
    const meta = JSON.parse(requests[0]!.body ?? '{}') as Record<
      string,
      unknown
    >;
    expect(meta.id).toBe('gen-3');
  });

  it('rejects a session URI outside the Google upload host', async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse({}, 200, { location: 'https://evil.example.com/sess' }),
    );
    const provider = createGoogleOAuthProvider({
      tokenSource: new FakeTokenSource(),
      transport: createDriveTransport('google_oauth', { fetchImpl }),
    });
    await expect(
      provider.startUpload({
        writer: WRITER,
        parentFolderId: 'p',
        name: 'x',
        mimeType: 'application/octet-stream',
        totalBytes: 5n,
        generatedFileId: 'g',
      }),
    ).rejects.toMatchObject({ reason: 'destination-refused' });
  });

  it('sends chunk bytes with Content-Range and parses 308 progress', async () => {
    const { fetchImpl, requests } = stubFetch((req) => {
      expect(req.method).toBe('PUT');
      expect(req.headers['content-range']).toBe('bytes 0-3/4');
      expect(req.body).toBe('abcd');
      return new Response('{}', {
        status: 308,
        headers: { range: 'bytes=0-3' },
      });
    });
    const provider = createGoogleOAuthProvider({
      tokenSource: new FakeTokenSource(),
      transport: createDriveTransport('google_oauth', { fetchImpl }),
    });
    const result = await provider.putChunk({
      writer: WRITER,
      sessionUri:
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=s1',
      offset: 0n,
      chunkBytes: 4,
      totalBytes: 4n,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('abcd'));
          c.close();
        },
      }),
    });
    expect(result).toEqual({ kind: 'incomplete', confirmedOffset: 4n });
    expect(requests).toHaveLength(1);
  });

  it('returns the completed file on a final 200 chunk response', async () => {
    const { fetchImpl } = stubFetch(() =>
      jsonResponse(fileJson({ id: 'gen-9' })),
    );
    const provider = createGoogleOAuthProvider({
      tokenSource: new FakeTokenSource(),
      transport: createDriveTransport('google_oauth', { fetchImpl }),
    });
    const result = await provider.putChunk({
      writer: WRITER,
      sessionUri:
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=s2',
      offset: 0n,
      chunkBytes: 4,
      totalBytes: 4n,
      body: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode('wxyz'));
          c.close();
        },
      }),
    });
    expect(result).toMatchObject({
      kind: 'completed',
      file: { id: 'gen-9' },
    });
  });

  it('probes a session and treats a missing Range as zero confirmed bytes', async () => {
    const { fetchImpl, requests } = stubFetch((req) => {
      expect(req.method).toBe('PUT');
      expect(req.headers['content-range']).toBe('bytes */100');
      return new Response('{}', { status: 308 });
    });
    const provider = createGoogleOAuthProvider({
      tokenSource: new FakeTokenSource(),
      transport: createDriveTransport('google_oauth', { fetchImpl }),
    });
    const result = await provider.probeUpload({
      writer: WRITER,
      sessionUri:
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=s3',
      totalBytes: 100n,
    });
    expect(result).toEqual({ kind: 'incomplete', confirmedOffset: 0n });
    expect(requests).toHaveLength(1);
  });

  it('verifies a file by ID with checksum fields', async () => {
    const { fetchImpl, requests } = stubFetch(() =>
      jsonResponse(
        fileJson({ id: 'f-5', md5Checksum: 'abc', sha256Checksum: 'def' }),
      ),
    );
    const provider = createGoogleOAuthProvider({
      tokenSource: new FakeTokenSource(),
      transport: createDriveTransport('google_oauth', { fetchImpl }),
    });
    const meta = await provider.verifyFile({
      writer: WRITER,
      ref: { id: 'f-5' },
    });
    expect(meta.md5Checksum).toBe('abc');
    expect(meta.sha256Checksum).toBe('def');
    expect(requests[0]?.url.searchParams.get('fields')).toContain(
      'sha256Checksum',
    );
  });

  it('trashes via files.update with the pinned connection', async () => {
    const { fetchImpl, requests } = stubFetch((req) => {
      expect(req.method).toBe('PATCH');
      return jsonResponse(fileJson({ id: 'f-6', trashed: true }));
    });
    const provider = createGoogleOAuthProvider({
      tokenSource: new FakeTokenSource(),
      transport: createDriveTransport('google_oauth', { fetchImpl }),
    });
    await provider.trashFile({ writer: WRITER, ref: { id: 'f-6' } });
    expect(requests).toHaveLength(1);
    expect(JSON.parse(requests[0]!.body ?? '{}')).toEqual({ trashed: true });
  });

  it('reports a 401, takes one fresh token and retries once', async () => {
    const { fetchImpl, requests } = queueFetch([
      googleErrorResponse(401, ['authError']),
      jsonResponse(fileJson()),
    ]);
    const source = new FakeTokenSource();
    const provider = createGoogleOAuthProvider({
      tokenSource: source,
      transport: createDriveTransport('google_oauth', { fetchImpl }),
    });
    const meta = await provider.getMetadata({
      writer: WRITER,
      ref: { id: 'file-1' },
    });
    expect(meta.id).toBe('file-1');
    expect(source.calls).toHaveLength(2);
    expect(requests[1]?.headers.authorization).toBe('Bearer tok-2');
    expect(source.failures).toEqual([
      {
        identity: source.calls[0]?.identity,
        kind: 'auth',
        fileId: 'file-1',
      },
    ]);
  });

  it('fails closed on a second 401 and reports the auth failure', async () => {
    const { fetchImpl } = queueFetch([
      googleErrorResponse(401, []),
      googleErrorResponse(401, []),
    ]);
    const source = new FakeTokenSource();
    const provider = createGoogleOAuthProvider({
      tokenSource: source,
      transport: createDriveTransport('google_oauth', { fetchImpl }),
    });
    await expect(
      provider.getMetadata({ writer: WRITER, ref: { id: 'f' } }),
    ).rejects.toMatchObject({ reason: 'unauthorized' });
    expect(source.calls).toHaveLength(2);
    expect(source.failures).toEqual([
      {
        identity: source.calls[0]?.identity,
        kind: 'auth',
        fileId: 'f',
      },
      {
        identity: source.calls[1]?.identity,
        kind: 'auth',
        fileId: 'f',
      },
    ]);
  });

  it('maps admission failures and never retries under a different identity', async () => {
    const { fetchImpl, requests } = stubFetch(() => {
      throw new Error('no upstream call expected');
    });
    const source = new FakeTokenSource();
    source.script = [{ ok: false, code: 'CREDENTIAL_DISABLED' }];
    const provider = createGoogleOAuthProvider({
      tokenSource: source,
      transport: createDriveTransport('google_oauth', { fetchImpl }),
    });
    await expect(
      provider.getMetadata({ writer: WRITER, ref: { id: 'f' } }),
    ).rejects.toMatchObject({ reason: 'credential-disabled' });
    expect(
      driveErrorToApiCode(
        tokenResultToDriveError({ ok: false, code: 'CREDENTIAL_DISABLED' }),
        { provider: 'google_oauth', surface: 'catalog' },
      ),
    ).toBe('GOOGLE_CONNECTION_DISABLED');
    // No upstream request happened: only the admission call was recorded.
    expect(source.calls).toHaveLength(1);
    expect(requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Service-account read provider
// ---------------------------------------------------------------------------

describe('ServiceAccountReadProvider', () => {
  function saProvider(
    fetchImpl: typeof fetch,
    source = new FakeTokenSource(),
  ) {
    return {
      source,
      provider: createServiceAccountReadProvider({
        tokenSource: source,
        transport: createDriveTransport('service_account', { fetchImpl }),
      }),
    };
  }

  it('requests drive.readonly only under the service_account identity', async () => {
    const { fetchImpl } = stubFetch(() => jsonResponse(fileJson()));
    const { source, provider } = saProvider(fetchImpl);
    await provider.getReadMetadata({ identity: READER, ref: { id: 'file-1' } });
    expect(source.calls[0]?.identity).toMatchObject({
      provider: 'service_account',
      credentialId: 'sa-1',
      credentialVersion: 4,
      principalId: READER.email,
      projectId: 'proj-1',
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });
    expect(source.calls[0]?.identity).not.toHaveProperty('oauthClientId');
  });

  it('streams full content with status and headers preserved', async () => {
    const { fetchImpl, requests } = stubFetch((req) => {
      expect(req.url.pathname).toBe('/drive/v3/files/big-1');
      expect(req.url.searchParams.get('alt')).toBe('media');
      expect(req.url.searchParams.get('supportsAllDrives')).toBe('true');
      return new Response('hello world', {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': '11',
          etag: '"v3"',
        },
      });
    });
    const { provider } = saProvider(fetchImpl);
    const content = await provider.openContent({
      identity: READER,
      ref: { id: 'big-1' },
    });
    expect(requests).toHaveLength(1);
    expect(content.status).toBe(200);
    expect(content.contentLength).toBe(11n);
    expect(content.contentType).toBe('application/octet-stream');
    expect(content.etag).toBe('"v3"');
    expect(await new Response(content.body).text()).toBe('hello world');
  });

  it('forwards a single Range and preserves the 206 contract', async () => {
    const { fetchImpl, requests } = stubFetch(
      () =>
        new Response('llo', {
          status: 206,
          headers: {
            'content-type': 'application/octet-stream',
            'content-range': 'bytes 2-4/11',
            'content-length': '3',
          },
        }),
    );
    const { provider } = saProvider(fetchImpl);
    const content = await provider.openContent({
      identity: READER,
      ref: { id: 'big-2' },
      range: { start: 2n, end: 4n },
    });
    expect(requests[0]?.headers.range).toBe('bytes=2-4');
    expect(content.status).toBe(206);
    expect(content.contentRange).toBe('bytes 2-4/11');
    expect(content.contentLength).toBe(3n);
    expect(await new Response(content.body).text()).toBe('llo');
  });

  it('reads pinned revisions via the revisions media path', async () => {
    const { fetchImpl, requests } = stubFetch((req) => {
      expect(req.url.pathname).toBe('/drive/v3/files/f-7/revisions/42');
      expect(req.url.searchParams.get('alt')).toBe('media');
      return new Response('rev-bytes', {
        status: 200,
        headers: { 'content-type': 'application/octet-stream' },
      });
    });
    const { provider } = saProvider(fetchImpl);
    const content = await provider.openContent({
      identity: READER,
      ref: { id: 'f-7' },
      revisionId: '42',
    });
    expect(await new Response(content.body).text()).toBe('rev-bytes');
    expect(requests).toHaveLength(1);
  });

  it('returns revision metadata for pinned-mode checks', async () => {
    const { fetchImpl } = stubFetch((req) => {
      expect(req.url.pathname).toBe('/drive/v3/files/f-8/revisions/7');
      return jsonResponse({
        id: '7',
        size: '100',
        mimeType: 'text/plain',
        keepForever: true,
      });
    });
    const { provider } = saProvider(fetchImpl);
    const rev = await provider.getRevision({
      identity: READER,
      ref: { id: 'f-8' },
      revisionId: '7',
    });
    expect(rev).toMatchObject({ id: '7', size: '100', keepForever: true });
  });

  it('fetches thumbnails only through a validated googleusercontent URL', async () => {
    const { fetchImpl, requests } = stubFetch((req) => {
      if (req.url.hostname === 'www.googleapis.com') {
        expect(req.url.pathname).toBe('/drive/v3/files/t-1');
        return jsonResponse({
          thumbnailLink: 'https://lh3.googleusercontent.com/thumb-abc',
        });
      }
      if (req.url.hostname === 'lh3.googleusercontent.com') {
        expect(req.url.pathname).toBe('/thumb-abc');
        // openThumbnail takes a fresh admission for the second request.
        expect(req.headers.authorization).toBe('Bearer tok-2');
        return new Response('PNG!', {
          status: 200,
          headers: { 'content-type': 'image/png', 'content-length': '4' },
        });
      }
      throw new Error(`unexpected host ${req.url.hostname}`);
    });
    const { provider } = saProvider(fetchImpl);
    const thumb = await provider.openThumbnail({
      identity: READER,
      ref: { id: 't-1' },
    });
    expect(thumb.contentType).toBe('image/png');
    expect(await new Response(thumb.body).text()).toBe('PNG!');
    expect(requests).toHaveLength(2);
  });

  it('refuses a thumbnail URL outside the allowlist before fetching it', async () => {
    const { fetchImpl, requests } = stubFetch((req) => {
      if (req.url.hostname === 'www.googleapis.com') {
        return jsonResponse({
          thumbnailLink: 'https://evil.example.com/steal',
        });
      }
      throw new Error(`unexpected host ${req.url.hostname}`);
    });
    const { provider } = saProvider(fetchImpl);
    await expect(
      provider.openThumbnail({ identity: READER, ref: { id: 't-2' } }),
    ).rejects.toMatchObject({ reason: 'destination-refused' });
    // Only the metadata call ran; the off-allowlist fetch never happened.
    expect(requests).toHaveLength(1);
  });

  it('exports Workspace documents only through the format allowlist', async () => {
    const { fetchImpl, requests } = stubFetch((req) => {
      expect(req.url.pathname).toBe('/drive/v3/files/doc-1/export');
      expect(req.url.searchParams.get('mimeType')).toBe('application/pdf');
      return new Response('%PDF-1.4', {
        status: 200,
        headers: { 'content-type': 'application/pdf' },
      });
    });
    const { provider } = saProvider(fetchImpl);
    const out = await provider.exportDocument({
      identity: READER,
      ref: { id: 'doc-1' },
      format: 'pdf',
    });
    expect(await new Response(out.body).text()).toBe('%PDF-1.4');
    expect(requests).toHaveLength(1);
  });

  it('reports file download limits without alternate-identity retry', async () => {
    const { fetchImpl, requests } = queueFetch([
      googleErrorResponse(403, ['cannotDownloadFile']),
    ]);
    const { source, provider } = saProvider(fetchImpl);
    await expect(
      provider.openContent({ identity: READER, ref: { id: 'locked' } }),
    ).rejects.toMatchObject({ reason: 'download-restricted' });
    expect(source.calls).toHaveLength(1);
    expect(source.calls[0]?.options).toEqual({ fileId: 'locked' });
    expect(source.failures).toEqual([
      { identity: source.calls[0]?.identity, kind: 'file_limited', fileId: 'locked' },
    ]);
    expect(requests).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Coordinator token source integration — the real B/C seam must compile and
// run so interface drift cannot hide behind a test-only double.
// ---------------------------------------------------------------------------

describe('CoordinatorTokenSource integration', () => {
  it('constructs providers against the real coordinator client', async () => {
    await applyD1Migrations(env.DB, TEST_MIGRATIONS);
    const source = createCoordinatorTokenSource(env);
    const saProvider = createServiceAccountReadProvider({ tokenSource: source });
    const oauthProvider = createGoogleOAuthProvider({ tokenSource: source });
    // Schema exists but no connection/SA rows: admission deterministically
    // fails CREDENTIAL_DISABLED and the providers surface a typed DriveError
    // — the real B/C seam exercised end to end.
    await expect(
      saProvider.getReadMetadata({ identity: READER, ref: { id: 'file-1' } }),
    ).rejects.toMatchObject({ reason: 'credential-disabled' });
    await expect(
      oauthProvider.getMetadata({ writer: WRITER, ref: { id: 'file-1' } }),
    ).rejects.toMatchObject({ reason: 'credential-disabled' });
  });
});
