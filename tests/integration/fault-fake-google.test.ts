import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeGoogle } from './fault-fake-google';

const API = 'https://www.googleapis.com';
const SA1 = 'dw-sa-01@proj.iam.gserviceaccount.com';
const SA2 = 'dw-sa-02@proj.iam.gserviceaccount.com';
const FOLDER = 'application/vnd.google-apps.folder';

afterEach(() => {
  vi.unstubAllGlobals();
});

function b64url(value: unknown): string {
  return btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function oauthToken(fake: FakeGoogle): Promise<string> {
  const res = await fake.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: 'ort-1',
      client_secret: 's',
    }).toString(),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

async function saToken(fake: FakeGoogle, email: string): Promise<string> {
  const assertion = `${b64url({ alg: 'RS256' })}.${b64url({ iss: email })}.sig`;
  const res = await fake.fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

function call(
  fake: FakeGoogle,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  return fake.fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const CREATE_QUERY = 'sendNotificationEmail=false&supportsAllDrives=true&fields=id';

describe('fault fake: My Drive + permissions model', () => {
  it('serves My Drive metadata, the root alias and corpora=user listings', async () => {
    const fake = new FakeGoogle();
    const op = await oauthToken(fake);
    fake.addMyDriveFolder('mounted');
    fake.addMyDriveFolder('sub', { parentId: 'mounted' });
    fake.addMyDriveFile('a', new TextEncoder().encode('a'), { parentId: 'mounted', name: 'a.txt' });
    fake.addMyDriveFile('outside', new TextEncoder().encode('o'));

    const root = (await (await call(fake, op, 'GET', '/drive/v3/files/root')).json()) as { id: string };
    expect(root.id).toBe(fake.ensureMyDriveRoot().id);

    const meta = (await (await call(fake, op, 'GET', '/drive/v3/files/mounted')).json()) as {
      ownedByMe?: boolean; driveId?: string; parents?: string[];
    };
    expect(meta).toMatchObject({ ownedByMe: true, parents: [root.id] });
    expect(meta.driveId).toBeUndefined();

    const q = (query: string, extra = '') =>
      call(fake, op, 'GET', `/drive/v3/files?corpora=user&supportsAllDrives=true&q=${encodeURIComponent(query)}${extra}`)
        .then((r) => r.json() as Promise<{ files: { id: string }[]; nextPageToken?: string }>);
    expect((await q("'mounted' in parents and trashed = false")).files.map((f) => f.id).sort()).toEqual(['a', 'sub']);
    expect((await q("name contains 'a.txt' and trashed = false")).files.map((f) => f.id)).toEqual(['a']);
    expect((await q(`'${root.id}' in parents and mimeType = '${FOLDER}' and 'me' in owners`)).files.map((f) => f.id)).toEqual(['mounted']);
    const paged = await q("'mounted' in parents", '&pageSize=1');
    expect(paged.files).toHaveLength(1);
    expect(paged.nextPageToken).toBe('1');
    const bad = await call(fake, op, 'GET', `/drive/v3/files?corpora=user&driveId=x&q=${encodeURIComponent('trashed = false')}`);
    expect(bad.status).toBe(400);
  });

  it('keeps Shared Drive listings free of My Drive files', async () => {
    const fake = new FakeGoogle();
    const op = await oauthToken(fake);
    fake.addMyDriveFolder('mounted');
    const res = await call(fake, op, 'GET', `/drive/v3/files?corpora=drive&driveId=${fake.driveId}&q=${encodeURIComponent("'mounted' in parents")}`);
    expect(((await res.json()) as { files: unknown[] }).files).toEqual([]);
  });

  it('grants, lists and deletes permissions; an SA only sees what is shared', async () => {
    const fake = new FakeGoogle();
    const op = await oauthToken(fake);
    const sa = await saToken(fake, SA1);
    fake.addMyDriveFolder('mounted');
    fake.addMyDriveFile('deep', new TextEncoder().encode('deep'), { parentId: 'mounted' });
    fake.addMyDriveFile('outside', new TextEncoder().encode('o'));
    expect((await call(fake, sa, 'GET', '/drive/v3/files/deep')).status).toBe(404);

    const body = { type: 'user', role: 'reader', emailAddress: SA1 };
    const missing = await call(fake, op, 'POST', '/drive/v3/files/mounted/permissions?supportsAllDrives=true', body);
    expect(missing.status).toBe(400);
    const created = await call(fake, op, 'POST', `/drive/v3/files/mounted/permissions?${CREATE_QUERY}`, body);
    expect(created.status).toBe(200);
    const perm = (await created.json()) as { id: string };

    expect((await call(fake, sa, 'GET', '/drive/v3/files/deep?alt=media')).status).toBe(200);
    expect((await call(fake, sa, 'GET', '/drive/v3/files/outside?alt=media')).status).toBe(404);
    expect((await call(fake, await saToken(fake, SA2), 'GET', '/drive/v3/files/deep')).status).toBe(404);

    const list = (await (await call(fake, op, 'GET', '/drive/v3/files/mounted/permissions?supportsAllDrives=true')).json()) as {
      permissions: { id: string; emailAddress: string; role: string }[];
    };
    expect(list.permissions.map((p) => [p.emailAddress, p.role])).toEqual([
      [fake.operatorEmail, 'owner'],
      [SA1, 'reader'],
    ]);

    expect((await call(fake, op, 'DELETE', `/drive/v3/files/mounted/permissions/${perm.id}?supportsAllDrives=true`)).status).toBe(204);
    expect((await call(fake, sa, 'GET', '/drive/v3/files/deep')).status).toBe(404);
    expect(fake.permissionCreates.map((c) => [c.emailAddress, c.failed])).toEqual([[SA1, true], [SA1, false]]);
    expect(fake.permissionDeletes).toEqual([{ fileId: 'mounted', permissionId: perm.id }]);
  });

  it('injects sharingRateLimitExceeded with Retry-After and per-email faults', async () => {
    const fake = new FakeGoogle();
    const op = await oauthToken(fake);
    fake.addMyDriveFolder('mounted');
    fake.sharingRateLimit = { remaining: 1, retryAfterSeconds: 7 };
    fake.permissionCreateFaults.set(SA2, { status: 400, reason: 'invalidSharingRequest' });

    const limited = await call(fake, op, 'POST', `/drive/v3/files/mounted/permissions?${CREATE_QUERY}`, { type: 'user', role: 'reader', emailAddress: SA1 });
    expect(limited.status).toBe(403);
    expect(limited.headers.get('retry-after')).toBe('7');
    expect(((await limited.json()) as { error: { errors: { reason: string }[] } }).error.errors[0]?.reason).toBe('sharingRateLimitExceeded');

    expect((await call(fake, op, 'POST', `/drive/v3/files/mounted/permissions?${CREATE_QUERY}`, { type: 'user', role: 'reader', emailAddress: SA1 })).status).toBe(200);
    const invalid = await call(fake, op, 'POST', `/drive/v3/files/mounted/permissions?${CREATE_QUERY}`, { type: 'user', role: 'reader', emailAddress: SA2 });
    expect(invalid.status).toBe(400);
    expect(fake.permissionsOf('mounted').map((p) => p.emailAddress)).toEqual([SA1]);
  });

  it('uploads into a My Drive folder as a My Drive file and can answer quota exceeded', async () => {
    const fake = new FakeGoogle();
    const op = await oauthToken(fake);
    fake.addMyDriveFolder('mounted');
    const start = async (id: string) =>
      fake.fetch(`${API}/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true`, {
        method: 'POST',
        headers: { authorization: `Bearer ${op}`, 'x-upload-content-length': '3', 'content-type': 'application/json' },
        body: JSON.stringify({ id, name: 'u.txt', mimeType: 'text/plain', parents: ['mounted'] }),
      });
    const res = await start('up-1');
    const location = res.headers.get('location') ?? '';
    const put = await fake.fetch(location, {
      method: 'PUT',
      headers: { authorization: `Bearer ${op}`, 'content-range': 'bytes 0-2/3' },
      body: new Uint8Array([1, 2, 3]),
    });
    const done = (await put.json()) as { id: string; driveId?: string; ownedByMe?: boolean };
    expect(done).toMatchObject({ id: 'up-1', ownedByMe: true });
    expect(done.driveId).toBeUndefined();
    expect(fake.files.get('up-1')?.driveId).toBeUndefined();

    fake.uploadQuotaExceeded = true;
    const quota = await start('up-2');
    expect(quota.status).toBe(403);
    expect(((await quota.json()) as { error: { errors: { reason: string }[] } }).error.errors[0]?.reason).toBe('storageQuotaExceeded');
  });

  it('moves files with addParents/removeParents', async () => {
    const fake = new FakeGoogle();
    const op = await oauthToken(fake);
    fake.addMyDriveFolder('f1');
    fake.addMyDriveFolder('f2');
    fake.addMyDriveFile('x', new Uint8Array([1]), { parentId: 'f1' });
    const res = await call(fake, op, 'PATCH', '/drive/v3/files/x?addParents=f2&removeParents=f1&supportsAllDrives=true', {});
    expect(((await res.json()) as { parents: string[] }).parents).toEqual(['f2']);
  });
});
