/**
 * T15 worker B: stateful fake Google boundary for workerd integration tests.
 *
 * Installed via `vi.stubGlobal('fetch', fake.fetch)` so EVERY outbound call
 * the real worker/DO code makes — Drive API transport, resumable upload
 * session, oauth2 token grants (OAuth + SA JWT inside ProjectCoordinator),
 * about.get, revoke, thumbnails — lands here and is recorded. The fake keeps
 * upstream protocol semantics: resumable 308 + Range progress, probe
 * requests, generated file IDs, error bodies in Google's shape and distinct
 * bearer token issuance per provider so tests can assert the OAuth-vs-SA
 * split (`provider` field on every recorded request).
 *
 * Non-Google hosts throw loudly so a stray internal fetch is never silent.
 */
import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// MD5 (pure TS) — hash-wasm cannot load inside the vitest workerd pool.
// ---------------------------------------------------------------------------

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];
const MD5_K = (() => {
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
  }
  return k;
})();

export function md5Hex(bytes: Uint8Array): string {
  const bitLen = bytes.byteLength * 8;
  const paddedLen = (((bytes.byteLength + 8) >>> 6) + 1) << 6;
  const msg = new Uint8Array(paddedLen);
  msg.set(bytes);
  msg[bytes.byteLength] = 0x80;
  const view = new DataView(msg.buffer);
  view.setUint32(paddedLen - 8, bitLen >>> 0, true);
  view.setUint32(paddedLen - 4, Math.floor(bitLen / 4294967296) >>> 0, true);

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const m = new Uint32Array(16);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = view.getUint32(off + i * 4, true);
    let [a, b, c, d] = [a0, b0, c0, d0];
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (i < 32) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        f = b ^ c ^ d;
        g = (3 * i + 5) % 16;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) % 16;
      }
      const tmp = d;
      d = c;
      c = b;
      b = (b + (((a + f + MD5_K[i]! + m[g]!) | 0) << MD5_S[i]! | ((a + f + MD5_K[i]! + m[g]!) | 0) >>> (32 - MD5_S[i]!))) | 0;
      a = tmp;
    }
    a0 = (a0 + a) | 0;
    b0 = (b0 + b) | 0;
    c0 = (c0 + c) | 0;
    d0 = (d0 + d) | 0;
  }
  const hex = (n: number) => {
    let s = '';
    for (let i = 0; i < 4; i++) s += ((n >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    return s;
  };
  return hex(a0) + hex(b0) + hex(c0) + hex(d0);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Recorded request + file model
// ---------------------------------------------------------------------------

export type FakeProvider = 'google_oauth' | 'service_account' | 'none';

export interface RecordedGoogleRequest {
  method: string;
  url: URL;
  /** Derived from the issued bearer token shape (oat-* vs sat-*). */
  provider: FakeProvider;
  /** Drained request-body byte count (0 for bodyless requests). */
  bytes: number;
  contentRange: string | null;
  authorization: string | null;
}

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  /** Shared Drive id; absent for My Drive files (Google omits it there). */
  driveId?: string;
  /** My Drive owner (OAuth permissionId); drives `ownedByMe` and access. */
  ownerPrincipal?: string;
  trashed: boolean;
  bytes: Uint8Array;
  /** content sha256/md5 computed from `bytes` like upstream would. */
  sha256Checksum?: string;
  md5Checksum?: string;
  headRevisionId: string;
  thumbnailLink?: string;
  capabilities: {
    canDownload?: boolean;
    canAddChildren?: boolean;
    canTrash?: boolean;
  };
  revisions?: Map<string, Uint8Array>;
}

/** A direct user permission on a My Drive file/folder (inherited downward). */
export interface FakePermission {
  id: string;
  type: 'user';
  role: 'reader' | 'writer';
  emailAddress: string;
}

/** One permissions.create the fake received (bodies are not otherwise kept). */
export interface RecordedPermissionCreate {
  fileId: string;
  emailAddress: string;
  type: unknown;
  role: unknown;
  sendNotificationEmail: string | null;
  supportsAllDrives: string | null;
  /** True when the call was answered with an injected failure. */
  failed: boolean;
}

export interface RecordedPermissionDelete {
  fileId: string;
  permissionId: string;
}

interface UploadSessionState {
  id: string;
  meta: { id?: string; name: string; mimeType: string; parents: string[] };
  total: bigint;
  confirmed: bigint;
  parts: Uint8Array[];
  completedFileId: string | null;
  dead: boolean;
}

export interface FakeGoogleOptions {
  driveId?: string;
  /** OAuth permissionId + email returned by about.get. */
  permissionId?: string;
  operatorEmail?: string;
  /** Scope string reported on token grants. */
  oauthScope?: string;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function googleError(status: number, reason: string, message = reason): Response {
  return json(
    { error: { code: status, message, errors: [{ reason, message }] } },
    status,
  );
}

const FOLDER_MIME = 'application/vnd.google-apps.folder';

/** `iss` claim of a JWT assertion (the SA email); a fixed name when unreadable. */
function issuerOf(assertion: string): string {
  try {
    const payload = assertion.split('.')[1] ?? '';
    const claims = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))) as { iss?: unknown };
    return typeof claims.iss === 'string' && claims.iss !== '' ? claims.iss : 'unknown-sa@fake.test';
  } catch {
    return 'unknown-sa@fake.test';
  }
}

export class FakeGoogle {
  readonly requests: RecordedGoogleRequest[] = [];
  readonly files = new Map<string, FakeFile>();
  readonly sessions = new Map<string, UploadSessionState>();
  readonly driveId: string;
  readonly permissionId: string;
  readonly operatorEmail: string;
  oauthScope: string;

  private fileSeq = 0;
  private sessionSeq = 0;
  private oauthTokenSeq = 0;
  private saTokenSeq = 0;
  private refreshSeq = 0;

  // -- fault knobs ----------------------------------------------------------
  /** SA metadata/media requests for these file ids fail with 403. */
  readonly saDeniedFiles = new Set<string>();
  /** OAuth metadata requests for these file ids fail with 404 notFound. */
  readonly oauthLostFiles = new Set<string>();
  /** Disable every OAuth token grant (revoked consent). */
  oauthGrantsDisabled = false;
  /** Omit refresh_token from the next authorization_code exchange. */
  nextExchangeOmitsRefresh = false;
  /** Override scope on the next authorization_code exchange. */
  nextExchangeScope: string | undefined;
  /** Throw/hook escape hatch for tests needing bespoke upstream faults. */
  hook: ((req: RecordedGoogleRequest) => Response | undefined) | undefined;
  /** Delay the next resumable-session POST so callers can race other work. */
  holdNextSessionInit: Promise<void> | undefined;

  // -- My Drive + permissions model ----------------------------------------
  /** fileId -> direct permissions (descendants inherit them). */
  readonly permissions = new Map<string, FakePermission[]>();
  readonly permissionCreates: RecordedPermissionCreate[] = [];
  readonly permissionDeletes: RecordedPermissionDelete[] = [];
  /** `sharingRateLimitExceeded` on the next `remaining` permissions.create calls. */
  sharingRateLimit: { remaining: number; retryAfterSeconds?: number } = { remaining: 0 };
  /** Per-email permissions.create failure (e.g. 400 invalidSharingRequest). */
  readonly permissionCreateFaults = new Map<string, { status: number; reason: string }>();
  /** Answer upload initiation with 403 storageQuotaExceeded. */
  uploadQuotaExceeded = false;
  /** Bearer sat-N -> SA email, taken from the JWT assertion `iss`. */
  private readonly saEmailByToken = new Map<string, string>();
  private permissionSeq = 0;
  private myDriveRootId: string | undefined;

  constructor(options: FakeGoogleOptions = {}) {
    this.driveId = options.driveId ?? '0AFakeDrive0001';
    this.permissionId = options.permissionId ?? 'perm-fake-1';
    this.operatorEmail = options.operatorEmail ?? 'operator@fake.test';
    this.oauthScope = options.oauthScope ?? 'https://www.googleapis.com/auth/drive';
    this.seedDriveRoot();
  }

  private seedDriveRoot(): void {
    const root: FakeFile = {
      id: this.driveId,
      name: 'Fake Shared Drive',
      mimeType: FOLDER_MIME,
      parents: [],
      driveId: this.driveId,
      trashed: false,
      bytes: new Uint8Array(0),
      headRevisionId: `rev-${this.driveId}`,
      capabilities: { canAddChildren: true, canTrash: true, canDownload: true },
    };
    this.files.set(this.driveId, root);
  }

  addFolder(id: string, parentId = this.driveId, name = id): FakeFile {
    const f: FakeFile = {
      id,
      name,
      mimeType: FOLDER_MIME,
      parents: [parentId],
      driveId: this.driveId,
      trashed: false,
      bytes: new Uint8Array(0),
      headRevisionId: `rev-${id}`,
      capabilities: { canAddChildren: true, canTrash: true },
    };
    this.files.set(id, f);
    return f;
  }

  addFile(
    id: string,
    bytes: Uint8Array,
    opts: Partial<FakeFile> & { parentId?: string } = {},
  ): FakeFile {
    const f: FakeFile = {
      id,
      name: opts.name ?? id,
      mimeType: opts.mimeType ?? 'application/octet-stream',
      parents: [opts.parentId ?? this.driveId],
      driveId: opts.driveId ?? this.driveId,
      trashed: opts.trashed ?? false,
      bytes,
      headRevisionId: opts.headRevisionId ?? 'rev-1',
      capabilities: opts.capabilities ?? { canDownload: true, canTrash: true },
      ...(opts.thumbnailLink === undefined ? {} : { thumbnailLink: opts.thumbnailLink }),
      ...(opts.revisions === undefined ? {} : { revisions: opts.revisions }),
    };
    if (bytes.byteLength > 0) {
      f.md5Checksum = md5Hex(bytes);
    }
    this.files.set(id, f);
    return f;
  }

  /** The operator's My Drive root folder (created on first use). */
  ensureMyDriveRoot(): FakeFile {
    const existing = this.myDriveRootId === undefined ? undefined : this.files.get(this.myDriveRootId);
    if (existing !== undefined) return existing;
    const root: FakeFile = {
      id: 'my-drive-root-1',
      name: 'My Drive',
      mimeType: FOLDER_MIME,
      parents: [],
      ownerPrincipal: this.permissionId,
      trashed: false,
      bytes: new Uint8Array(0),
      headRevisionId: 'rev-my-drive-root-1',
      capabilities: { canAddChildren: true, canTrash: true },
    };
    this.files.set(root.id, root);
    this.myDriveRootId = root.id;
    return root;
  }

  /** A My Drive folder owned by the operator (default parent: My Drive root). */
  addMyDriveFolder(
    id: string,
    opts: { parentId?: string; name?: string; ownerPrincipal?: string } = {},
  ): FakeFile {
    const f: FakeFile = {
      id,
      name: opts.name ?? id,
      mimeType: FOLDER_MIME,
      parents: [opts.parentId ?? this.ensureMyDriveRoot().id],
      ownerPrincipal: opts.ownerPrincipal ?? this.permissionId,
      trashed: false,
      bytes: new Uint8Array(0),
      headRevisionId: `rev-${id}`,
      capabilities: { canAddChildren: true, canTrash: true },
    };
    this.files.set(id, f);
    return f;
  }

  /** A My Drive file owned by the operator (default parent: My Drive root). */
  addMyDriveFile(
    id: string,
    bytes: Uint8Array,
    opts: Partial<Omit<FakeFile, 'driveId'>> & { parentId?: string } = {},
  ): FakeFile {
    const f: FakeFile = {
      id,
      name: opts.name ?? id,
      mimeType: opts.mimeType ?? 'application/octet-stream',
      parents: [opts.parentId ?? this.ensureMyDriveRoot().id],
      ownerPrincipal: opts.ownerPrincipal ?? this.permissionId,
      trashed: opts.trashed ?? false,
      bytes,
      headRevisionId: opts.headRevisionId ?? 'rev-1',
      capabilities: opts.capabilities ?? { canDownload: true, canTrash: true },
      ...(opts.thumbnailLink === undefined ? {} : { thumbnailLink: opts.thumbnailLink }),
      ...(opts.revisions === undefined ? {} : { revisions: opts.revisions }),
    };
    if (bytes.byteLength > 0) f.md5Checksum = md5Hex(bytes);
    this.files.set(id, f);
    return f;
  }

  /** Grant a direct reader/writer permission without any API call. */
  grant(fileId: string, emailAddress: string, role: FakePermission['role'] = 'reader'): FakePermission {
    const list = this.permissions.get(fileId) ?? [];
    const existing = list.find((p) => p.emailAddress.toLowerCase() === emailAddress.toLowerCase());
    if (existing !== undefined) {
      existing.role = role;
      return existing;
    }
    const created: FakePermission = {
      id: `perm-${++this.permissionSeq}`,
      type: 'user',
      role,
      emailAddress,
    };
    list.push(created);
    this.permissions.set(fileId, list);
    return created;
  }

  /** Direct permissions currently on a file (a copy). */
  permissionsOf(fileId: string): FakePermission[] {
    return (this.permissions.get(fileId) ?? []).map((p) => ({ ...p }));
  }

  /** Requests recorded so far, optionally filtered. */
  calls(match: Partial<Pick<RecordedGoogleRequest, 'method' | 'provider'>> & {
    hostSuffix?: string;
    pathIncludes?: string;
  } = {}): RecordedGoogleRequest[] {
    return this.requests.filter(
      (r) =>
        (match.method === undefined || r.method === match.method) &&
        (match.provider === undefined || r.provider === match.provider) &&
        (match.hostSuffix === undefined || r.url.hostname.endsWith(match.hostSuffix)) &&
        (match.pathIncludes === undefined || r.url.pathname.includes(match.pathIncludes)),
    );
  }

  install(): this {
    vi.stubGlobal('fetch', this.fetch);
    return this;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const auth = headers.get('authorization');
    const provider: FakeProvider =
      auth === null ? 'none'
      : auth.startsWith('Bearer oat-') ? 'google_oauth'
      : auth.startsWith('Bearer sat-') ? 'service_account'
      : 'none';
    let bodyBytes = new Uint8Array(0);
    if (init?.body !== undefined && init.body !== null) {
      try {
        bodyBytes = new Uint8Array(
          await new Response(init.body as BodyInit).arrayBuffer(),
        );
      } catch {
        bodyBytes = new Uint8Array(0);
      }
    }
    const bytes = bodyBytes.byteLength;
    const req: RecordedGoogleRequest = {
      method,
      url,
      provider,
      bytes,
      contentRange: headers.get('content-range'),
      authorization: auth,
    };
    this.requests.push(req);
    const hooked = this.hook?.(req);
    if (hooked !== undefined) return hooked;
    return this.route(req, headers, init, bodyBytes);
  };

  // -------------------------------------------------------------------------
  // Routing
  // -------------------------------------------------------------------------

  private async route(
    req: RecordedGoogleRequest,
    headers: Headers,
    init: RequestInit | undefined,
    body: Uint8Array,
  ): Promise<Response> {
    const host = req.url.hostname;
    if (host === 'oauth2.googleapis.com') {
      return this.routeOAuth2(req, init);
    }
    if (host === 'www.googleapis.com') {
      return this.routeGoogleApis(req, headers, init, body);
    }
    if (host.endsWith('.googleusercontent.com')) {
      return this.routeUserContent(req);
    }
    throw new Error(`fake-google: unexpected host ${host} for ${req.method} ${req.url}`);
  }

  private routeOAuth2(req: RecordedGoogleRequest, init?: RequestInit): Response {
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const params = new URLSearchParams(bodyText);
    if (req.method === 'POST' && req.url.pathname === '/token') {
      if (this.oauthGrantsDisabled) {
        return googleError(400, 'invalid_grant', 'Token has been expired or revoked.');
      }
      const grantType = params.get('grant_type');
      if (grantType === 'authorization_code') {
        const grant: Record<string, unknown> = {
          access_token: `oat-${++this.oauthTokenSeq}`,
          expires_in: 3600,
          scope: this.nextExchangeScope ?? this.oauthScope,
          token_type: 'Bearer',
        };
        if (!this.nextExchangeOmitsRefresh) {
          grant.refresh_token = `ort-${++this.refreshSeq}`;
        }
        return json(grant);
      }
      if (grantType === 'refresh_token') {
        if (!params.get('refresh_token')?.startsWith('ort-') || !params.get('client_secret')) {
          return googleError(400, 'invalid_grant', 'Bad refresh grant.');
        }
        return json({
          access_token: `oat-${++this.oauthTokenSeq}`,
          expires_in: 3600,
          scope: this.oauthScope,
          token_type: 'Bearer',
        });
      }
      if (grantType === 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
        const assertion = params.get('assertion') ?? '';
        if (assertion.split('.').length !== 3) {
          return googleError(400, 'invalid_grant', 'Malformed JWT.');
        }
        const saToken = `sat-${++this.saTokenSeq}`;
        this.saEmailByToken.set(saToken, issuerOf(assertion));
        return json({
          access_token: saToken,
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      return googleError(400, 'unsupported_grant_type', `grant ${grantType}`);
    }
    if (req.method === 'POST' && req.url.pathname === '/revoke') {
      return new Response(null, { status: 200 });
    }
    return googleError(404, 'notFound', `oauth2 ${req.method} ${req.url.pathname}`);
  }

  private async routeGoogleApis(
    req: RecordedGoogleRequest,
    headers: Headers,
    init: RequestInit | undefined,
    body: Uint8Array,
  ): Promise<Response> {
    const path = req.url.pathname;
    // -- upload host ---------------------------------------------------------
    if (path.startsWith('/upload/drive/v3/')) {
      return this.routeUpload(req, init, body);
    }
    if (!path.startsWith('/drive/v3/')) {
      throw new Error(`fake-google: unexpected path ${req.method} ${path}`);
    }
    if (req.provider === 'none') {
      return googleError(401, 'authError', 'Missing bearer.');
    }

    if (req.method === 'GET' && path === '/drive/v3/about') {
      return json({
        user: {
          kind: 'drive#user',
          permissionId: this.permissionId,
          emailAddress: this.operatorEmail,
          displayName: 'Fake Operator',
        },
      });
    }

    if (path === '/drive/v3/files/generateIds' && req.method === 'GET') {
      const count = Number(req.url.searchParams.get('count') ?? '1');
      return json({
        ids: Array.from({ length: Math.min(count, 64) }, () => `file-${++this.fileSeq}`),
        space: 'drive',
      });
    }

    if (path === '/drive/v3/files' && req.method === 'GET') {
      return this.routeFilesList(req);
    }

    if (path === '/drive/v3/files' && req.method === 'POST') {
      const parsed = body.byteLength > 0
        ? (JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>)
        : {};
      return this.routeFilesCreate(req, parsed);
    }

    const permMatch = /^\/drive\/v3\/files\/([^/]+)\/permissions(?:\/([^/]+))?$/.exec(path);
    if (permMatch !== null) {
      return this.routePermissions(req, body, permMatch[1]!, permMatch[2]);
    }

    const fileMatch = /^\/drive\/v3\/files\/([^/]+)(\/revisions\/([^/]+))?(\/export)?$/.exec(path);
    if (fileMatch !== null) {
      const [, requestedId, , revisionId, exportSuffix] = fileMatch;
      // `root` is Drive's alias for the operator's My Drive root folder.
      const fileId = requestedId === 'root' ? this.ensureMyDriveRoot().id : requestedId;
      const denied = this.isDenied(req.provider, fileId!);
      if (denied !== null) return denied;
      const file = this.files.get(fileId!);
      if (file === undefined || (file.trashed && req.method === 'GET')) {
        return googleError(404, 'notFound', 'File not found.');
      }
      if (
        file.driveId === undefined &&
        !this.canAccessMyDrive(req, file, req.method === 'PATCH' ? 'write' : 'read')
      ) {
        return googleError(404, 'notFound', 'File not found.');
      }
      if (exportSuffix !== undefined && req.method === 'GET') {
        const exported = new TextEncoder().encode(`EXPORTED:${file.name}`);
        return new Response(exported as Uint8Array<ArrayBuffer>, {
          status: 200,
          headers: { 'content-type': req.url.searchParams.get('mimeType') ?? 'application/pdf' },
        });
      }
      if (revisionId !== undefined && req.url.searchParams.get('alt') === 'media') {
        const rev = file.revisions?.get(revisionId!);
        if (rev === undefined && file.headRevisionId !== revisionId) {
          return googleError(404, 'notFound', 'Revision not found.');
        }
        const bytes = rev ?? file.bytes;
        return this.applyRange(req, headers, bytes);
      }
      if (req.url.searchParams.get('alt') === 'media' && req.method === 'GET') {
        if (file.capabilities.canDownload === false) {
          return googleError(403, 'fileNotDownloadable', 'File is not downloadable.');
        }
        return this.applyRange(req, headers, file.bytes);
      }
      if (req.method === 'GET') {
        return json(this.fileJson(file, req.provider));
      }
      if (req.method === 'PATCH') {
        const patch = body.byteLength > 0
          ? (JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>)
          : {};
        if (patch.trashed === true) file.trashed = true;
        if (typeof patch.name === 'string') file.name = patch.name;
        const addParents = req.url.searchParams.get('addParents');
        const removeParents = req.url.searchParams.get('removeParents');
        if (removeParents !== null) {
          const drop = new Set(removeParents.split(','));
          file.parents = file.parents.filter((p) => !drop.has(p));
        }
        if (addParents !== null) {
          for (const p of addParents.split(',')) {
            if (p !== '' && !file.parents.includes(p)) file.parents.push(p);
          }
        }
        return json(this.fileJson(file, req.provider));
      }
      return googleError(405, 'httpMethodNotAllowed', `${req.method} ${path}`);
    }
    throw new Error(`fake-google: unmatched ${req.method} ${req.url}`);
  }

  private isDenied(provider: FakeProvider, fileId: string): Response | null {
    if (provider === 'service_account' && this.saDeniedFiles.has(fileId)) {
      return googleError(403, 'insufficientPermissions', 'The SA cannot access this file.');
    }
    if (provider === 'google_oauth' && this.oauthLostFiles.has(fileId)) {
      return googleError(404, 'notFound', 'The writer cannot access this file.');
    }
    return null;
  }

  private fileJson(file: FakeFile, provider: FakeProvider = 'google_oauth'): Record<string, unknown> {
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: String(file.bytes.byteLength),
      trashed: file.trashed,
      parents: file.parents,
      driveId: file.driveId,
      ...(file.driveId === undefined
        ? { ownedByMe: provider === 'google_oauth' && file.ownerPrincipal === this.permissionId }
        : {}),
      headRevisionId: file.headRevisionId,
      capabilities: file.capabilities,
      ...(file.sha256Checksum === undefined ? {} : { sha256Checksum: file.sha256Checksum }),
      ...(file.md5Checksum === undefined ? {} : { md5Checksum: file.md5Checksum }),
      ...(file.thumbnailLink === undefined ? {} : { thumbnailLink: file.thumbnailLink }),
    };
  }

  /** Identity behind a bearer: the OAuth operator or the SA named in its JWT. */
  private callerIdentity(req: RecordedGoogleRequest): { owner?: string; email: string } | null {
    if (req.provider === 'google_oauth') {
      return { owner: this.permissionId, email: this.operatorEmail };
    }
    if (req.provider === 'service_account') {
      const token = (req.authorization ?? '').replace(/^Bearer /, '');
      return { email: this.saEmailByToken.get(token) ?? 'unknown-sa@fake.test' };
    }
    return null;
  }

  /**
   * My Drive access: the owner, OR a user permission on the file or any
   * ancestor (inherited). 'write' needs the owner or a writer grant.
   */
  private canAccessMyDrive(
    req: RecordedGoogleRequest,
    file: FakeFile,
    need: 'read' | 'write',
  ): boolean {
    const who = this.callerIdentity(req);
    if (who === null) return false;
    if (file.ownerPrincipal !== undefined && file.ownerPrincipal === who.owner) return true;
    const email = who.email.toLowerCase();
    let best: FakePermission['role'] | undefined;
    const seen = new Set<string>();
    let cursor: FakeFile | undefined = file;
    while (cursor !== undefined && !seen.has(cursor.id) && seen.size < 64) {
      seen.add(cursor.id);
      for (const perm of this.permissions.get(cursor.id) ?? []) {
        if (perm.emailAddress.toLowerCase() !== email) continue;
        if (perm.role === 'writer') best = 'writer';
        else best ??= 'reader';
      }
      const parentId: string | undefined = cursor.parents[0];
      cursor = parentId === undefined ? undefined : this.files.get(parentId);
    }
    return need === 'read' ? best !== undefined : best === 'writer';
  }

  /** corpora=user listing over My Drive files the caller can access. */
  private routeMyDriveList(req: RecordedGoogleRequest): Response {
    if (req.url.searchParams.has('driveId')) {
      return googleError(400, 'invalid', 'The driveId parameter can only be used with corpora=drive.');
    }
    const q = req.url.searchParams.get('q') ?? '';
    const parentToken = /'([^']+)' in parents/.exec(q)?.[1];
    const parentId = parentToken === 'root' ? this.ensureMyDriveRoot().id : parentToken;
    const nameRaw = /name contains '((?:\\'|[^'])*)'/.exec(q)?.[1];
    const nameTerm = nameRaw?.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    const mime = /mimeType = '([^']+)'/.exec(q)?.[1];
    const trashed = /trashed = (true|false)/.exec(q)?.[1];
    const onlyMine = /'me' in owners/.test(q);
    const who = this.callerIdentity(req);
    const matches = [...this.files.values()]
      .filter((f) => f.driveId === undefined && f.parents.length > 0)
      .filter((f) => this.canAccessMyDrive(req, f, 'read'))
      .filter((f) => !onlyMine || f.ownerPrincipal === who?.owner)
      .filter((f) => trashed === undefined || f.trashed === (trashed === 'true'))
      .filter((f) => parentId === undefined || f.parents.includes(parentId))
      .filter((f) => nameTerm === undefined || f.name.includes(nameTerm))
      .filter((f) => mime === undefined || f.mimeType === mime)
      .sort((a, b) => {
        const af = a.mimeType === FOLDER_MIME ? 0 : 1;
        const bf = b.mimeType === FOLDER_MIME ? 0 : 1;
        return af !== bf ? af - bf : a.name.localeCompare(b.name, undefined, { numeric: true });
      });
    const pageSizeRaw = Number.parseInt(req.url.searchParams.get('pageSize') ?? '200', 10);
    const pageSize = Number.isInteger(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(pageSizeRaw, 1000) : 200;
    const offset = Math.max(0, Number.parseInt(req.url.searchParams.get('pageToken') ?? '0', 10) || 0);
    const next = offset + pageSize;
    return json({
      files: matches.slice(offset, next).map((f) => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        size: String(f.bytes.byteLength),
        trashed: f.trashed,
        parents: f.parents,
        ownedByMe: f.ownerPrincipal === who?.owner,
        modifiedTime: '2026-10-01T00:00:00.000Z',
        ...(f.thumbnailLink === undefined ? {} : { thumbnailLink: f.thumbnailLink }),
      })),
      ...(next < matches.length ? { nextPageToken: String(next) } : {}),
    });
  }

  private routePermissions(
    req: RecordedGoogleRequest,
    body: Uint8Array,
    requestedId: string,
    permissionId: string | undefined,
  ): Response {
    const fileId = requestedId === 'root' ? this.ensureMyDriveRoot().id : requestedId;
    const file = this.files.get(fileId);
    if (file === undefined || file.driveId !== undefined) {
      return googleError(404, 'notFound', 'File not found.');
    }
    if (!this.canAccessMyDrive(req, file, 'read')) {
      return googleError(404, 'notFound', 'File not found.');
    }
    if (!this.canAccessMyDrive(req, file, 'write')) {
      return googleError(403, 'insufficientFilePermissions', 'Insufficient permissions.');
    }
    const direct = this.permissions.get(fileId) ?? [];

    if (req.method === 'GET' && permissionId === undefined) {
      const owner = file.ownerPrincipal === this.permissionId
        ? [{ id: `owner-${file.id}`, type: 'user', role: 'owner', emailAddress: this.operatorEmail }]
        : [];
      const all = [...owner, ...direct.map((p) => ({ ...p }))];
      const pageSizeRaw = Number.parseInt(req.url.searchParams.get('pageSize') ?? '100', 10);
      const pageSize = Number.isInteger(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(pageSizeRaw, 100) : 100;
      const offset = Math.max(0, Number.parseInt(req.url.searchParams.get('pageToken') ?? '0', 10) || 0);
      const next = offset + pageSize;
      return json({
        permissions: all.slice(offset, next),
        ...(next < all.length ? { nextPageToken: String(next) } : {}),
      });
    }

    if (req.method === 'POST' && permissionId === undefined) {
      const parsed = body.byteLength > 0
        ? (JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>)
        : {};
      const emailAddress = typeof parsed.emailAddress === 'string' ? parsed.emailAddress : '';
      const record: RecordedPermissionCreate = {
        fileId,
        emailAddress,
        type: parsed.type,
        role: parsed.role,
        sendNotificationEmail: req.url.searchParams.get('sendNotificationEmail'),
        supportsAllDrives: req.url.searchParams.get('supportsAllDrives'),
        failed: false,
      };
      this.permissionCreates.push(record);
      // The app must never notify SA addresses: absent or true is a bug.
      if (record.sendNotificationEmail !== 'false') {
        record.failed = true;
        return googleError(400, 'badRequest', 'permissions.create requires sendNotificationEmail=false.');
      }
      if (parsed.type !== 'user' || (parsed.role !== 'reader' && parsed.role !== 'writer') || emailAddress === '') {
        record.failed = true;
        return googleError(400, 'badRequest', 'type=user, role=reader|writer and emailAddress are required.');
      }
      if (this.sharingRateLimit.remaining > 0) {
        this.sharingRateLimit.remaining -= 1;
        record.failed = true;
        const res = googleError(403, 'sharingRateLimitExceeded', 'Rate limit exceeded for sharing.');
        if (this.sharingRateLimit.retryAfterSeconds !== undefined) {
          res.headers.set('retry-after', String(this.sharingRateLimit.retryAfterSeconds));
        }
        return res;
      }
      const fault = this.permissionCreateFaults.get(emailAddress);
      if (fault !== undefined) {
        record.failed = true;
        return googleError(fault.status, fault.reason);
      }
      return json(this.grant(fileId, emailAddress, parsed.role));
    }

    if (req.method === 'DELETE' && permissionId !== undefined) {
      this.permissionDeletes.push({ fileId, permissionId });
      if (permissionId.startsWith('owner-')) {
        return googleError(403, 'forbidden', 'The owner permission cannot be removed.');
      }
      const index = direct.findIndex((p) => p.id === permissionId);
      if (index < 0) return googleError(404, 'notFound', 'Permission not found.');
      direct.splice(index, 1);
      return new Response(null, { status: 204 });
    }
    return googleError(405, 'httpMethodNotAllowed', `${req.method} ${req.url.pathname}`);
  }

  private routeFilesList(req: RecordedGoogleRequest): Response {
    if (req.url.searchParams.get('corpora') === 'user') return this.routeMyDriveList(req);
    const q = req.url.searchParams.get('q') ?? '';
    const inParents = /'([^']+)' in parents/.exec(q)?.[1];
    let files = [...this.files.values()].filter((f) => !f.trashed && f.driveId !== undefined);
    if (inParents !== undefined) {
      files = files.filter((f) => f.parents.includes(inParents));
    }
    return json({
      files: files.map((f) => ({
        id: f.id,
        name: f.name,
        mimeType: f.mimeType,
        size: String(f.bytes.byteLength),
        trashed: f.trashed,
        parents: f.parents,
        driveId: f.driveId,
        modifiedTime: '2026-10-01T00:00:00.000Z',
      })),
    });
  }

  private routeFilesCreate(_req: RecordedGoogleRequest, body: Record<string, unknown>): Response {
    const id = typeof body.id === 'string' && body.id.length > 0 ? body.id : `file-${++this.fileSeq}`;
    if (this.files.has(id)) {
      return googleError(409, 'alreadyExists', 'A file with this ID already exists.');
    }
    const parents = Array.isArray(body.parents) ? body.parents.map(String) : [this.driveId];
    const file: FakeFile = {
      id,
      name: String(body.name ?? id),
      mimeType: String(body.mimeType ?? 'application/octet-stream'),
      parents,
      ...this.placementOf(parents),
      trashed: false,
      bytes: new Uint8Array(0),
      headRevisionId: 'rev-1',
      capabilities: { canDownload: true, canTrash: true, canAddChildren: true },
    };
    this.files.set(id, file);
    return json(this.fileJson(file));
  }

  /**
   * Where a new file lives: under a My Drive parent it is a My Drive file
   * owned by the operator (no driveId); anywhere else it keeps the original
   * Shared Drive placement.
   */
  private placementOf(parents: string[]): Pick<FakeFile, 'driveId' | 'ownerPrincipal'> {
    const parent = parents[0] === undefined ? undefined : this.files.get(parents[0]);
    if (parent !== undefined && parent.driveId === undefined) {
      return { ownerPrincipal: this.permissionId };
    }
    return { driveId: this.driveId };
  }

  private async routeUpload(
    req: RecordedGoogleRequest,
    init: RequestInit | undefined,
    body: Uint8Array,
  ): Promise<Response> {
    const path = req.url.pathname;
    if (req.method === 'POST' && path === '/upload/drive/v3/files' &&
        req.url.searchParams.get('uploadType') === 'resumable') {
      if (this.holdNextSessionInit !== undefined) {
        await this.holdNextSessionInit;
        this.holdNextSessionInit = undefined;
      }
      if (this.uploadQuotaExceeded) {
        return googleError(403, 'storageQuotaExceeded', 'The user storage quota has been exceeded.');
      }
      const meta = body.byteLength > 0
        ? (JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>)
        : {};
      // A resumable initiation pinned to an ID that already exists with
      // different content is a conflict upstream (spec §6.4).
      if (typeof meta.id === 'string' && this.files.has(meta.id)) {
        return googleError(409, 'alreadyExists', 'A file with this ID already exists.');
      }
      const id = `sess-${++this.sessionSeq}`;
      const total = Number.parseInt(
        new Headers(init?.headers).get('x-upload-content-length') ?? '0',
        10,
      );
      this.sessions.set(id, {
        id,
        meta: {
          ...(typeof meta.id === 'string' ? { id: meta.id } : {}),
          name: String(meta.name ?? 'file'),
          mimeType: String(meta.mimeType ?? 'application/octet-stream'),
          parents: Array.isArray(meta.parents) ? meta.parents.map(String) : [this.driveId],
        },
        total: BigInt(Number.isFinite(total) ? total : 0),
        confirmed: 0n,
        parts: [],
        completedFileId: null,
        dead: false,
      });
      return new Response('{}', {
        status: 200,
        headers: {
          'content-type': 'application/json',
          location: `https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=${id}`,
        },
      });
    }
    if (req.method === 'PUT' && path === '/upload/drive/v3/files') {
      const uploadId = req.url.searchParams.get('upload_id') ?? '';
      const session = this.sessions.get(uploadId);
      if (session === undefined || session.dead) {
        return googleError(404, 'notFound', 'Resumable session expired.');
      }
      const range = req.contentRange;
      if (range !== null && range.startsWith('bytes */')) {
        // Probe.
        if (session.completedFileId !== null) {
          const file = this.files.get(session.completedFileId)!;
          return json(this.fileJson(file));
        }
        if (session.confirmed === 0n) {
          return new Response('{}', { status: 308 });
        }
        return new Response('{}', {
          status: 308,
          headers: { range: `bytes=0-${session.confirmed - 1n}` },
        });
      }
      const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(range ?? '');
      if (m === null) {
        return googleError(400, 'badRequest', `Bad Content-Range ${range}`);
      }
      const [, startS, endS, totalS] = m;
      const start = BigInt(startS!), end = BigInt(endS!);
      if (start !== session.confirmed) {
        return new Response('{}', {
          status: 308,
          headers: { range: session.confirmed === 0n ? 'bytes=0-0' : `bytes=0-${session.confirmed - 1n}` },
        });
      }
      const chunk = body;
      if (BigInt(chunk.byteLength) !== end - start + 1n) {
        return googleError(400, 'badRequest', 'Chunk size does not match Content-Range.');
      }
      session.parts.push(chunk);
      session.confirmed = end + 1n;
      const total = totalS === '*' ? session.total : BigInt(totalS!);
      if (session.confirmed < total) {
        return new Response('{}', {
          status: 308,
          headers: { range: `bytes=0-${session.confirmed - 1n}` },
        });
      }
      // Completion: assemble the file under the pinned generated ID.
      const assembled = new Uint8Array(Number(session.confirmed));
      let at = 0;
      for (const part of session.parts) {
        assembled.set(part, at);
        at += part.byteLength;
      }
      const fileId = session.meta.id ?? `file-${++this.fileSeq}`;
      const file: FakeFile = {
        id: fileId,
        name: session.meta.name,
        mimeType: session.meta.mimeType,
        parents: session.meta.parents,
        ...this.placementOf(session.meta.parents),
        trashed: false,
        bytes: assembled,
        sha256Checksum: await sha256Hex(assembled),
        md5Checksum: md5Hex(assembled),
        headRevisionId: 'rev-1',
        capabilities: { canDownload: true, canTrash: true },
        revisions: new Map([['rev-1', assembled]]),
      };
      this.files.set(fileId, file);
      session.completedFileId = fileId;
      return json(this.fileJson(file));
    }
    return googleError(405, 'httpMethodNotAllowed', `${req.method} ${path}`);
  }

  private applyRange(
    _req: RecordedGoogleRequest,
    headers: Headers,
    bytes: Uint8Array,
  ): Response {
    const range = headers.get('range');
    const m = range === null ? null : /^bytes=(\d+)-(\d*)$/.exec(range);
    if (m !== null) {
      const start = Number(m[1]);
      const end = m[2] === '' || m[2] === undefined ? bytes.byteLength - 1 : Number(m[2]);
      const slice = bytes.subarray(start, Math.min(end, bytes.byteLength - 1) + 1);
      return new Response(slice as Uint8Array<ArrayBuffer>, {
        status: 206,
        headers: {
          'content-type': 'application/octet-stream',
          'content-range': `bytes ${start}-${start + slice.byteLength - 1}/${bytes.byteLength}`,
        },
      });
    }
    return new Response(bytes as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }

  private routeUserContent(req: RecordedGoogleRequest): Response {
    const hit = [...this.files.values()].find((f) => f.thumbnailLink === req.url.toString());
    if (hit === undefined) {
      return googleError(404, 'notFound', 'No such thumbnail.');
    }
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return new Response(png as Uint8Array<ArrayBuffer>, {
      status: 200,
      headers: { 'content-type': 'image/png' },
    });
  }
}
