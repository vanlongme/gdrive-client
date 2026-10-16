/**
 * Fake Google boundary (T15, frozen decision 1): a stateful, in-process fake
 * of the exact Google HTTP surface the built worker calls — Drive v3 under
 * www.googleapis.com (/drive/v3, /upload/drive/v3), the oauth2.googleapis.com
 * token/revoke endpoints and *.googleusercontent.com thumbnails.
 *
 * It keeps upstream protocol semantics (resumable 308 + Range, Content-Range
 * probes, generated IDs, revisions, permission/membership, Google error
 * bodies) and logs every request with its provider identity — OAuth bearer
 * vs SA bearer — plus byte counts, so the journey spec can assert the
 * catalog/write-vs-content split directly from the log.
 *
 * The same dispatch serves both Miniflare `outboundService` (worker-bound
 * traffic) and the loopback control port's data plane, so a request issued
 * through either path is classified, authorized and logged identically.
 */

import { createHash } from "node:crypto";
import {
  createFakeState,
  type DriveRole,
  type FakeFile,
  type FakeProvider,
  type FakeRequestLogEntry,
  type FakeState,
  type FakeUploadSession,
} from "./state";

export * from "./state";

export const GOOGLE_API_HOST = "www.googleapis.com";
export const GOOGLE_TOKEN_HOST = "oauth2.googleapis.com";
export const GOOGLE_AUTH_HOST = "accounts.google.com";
export const GOOGLE_USERCONTENT_SUFFIX = "googleusercontent.com";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
export const SA_READ_SCOPE =
  "https://www.googleapis.com/auth/drive.readonly";
const JWT_BEARER_GRANT = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const FOLDER_MIME = "application/vnd.google-apps.folder";

const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Provider-surface policy: which token provider may touch which surface.
// Mirrors the architecture §5.1 split — content bytes are SA-only; catalog
// and every write are OAuth-only.
// ---------------------------------------------------------------------------

export type SurfacePolicy = "oauth" | "service_account" | "either" | "auth";

interface SurfaceRule {
  readonly policy: SurfacePolicy;
  readonly operation: string;
}

function classifySurface(
  host: string,
  method: string,
  path: string,
  queryKeys: ReadonlySet<string>,
): SurfaceRule | null {
  if (host === GOOGLE_TOKEN_HOST) return { policy: "auth", operation: "token" };
  if (host.endsWith(GOOGLE_USERCONTENT_SUFFIX)) {
    return { policy: "service_account", operation: "thumbnail.fetch" };
  }
  if (host !== GOOGLE_API_HOST) return null;

  if (path === "/drive/v3/about") {
    return { policy: "oauth", operation: "about.get" };
  }
  if (path === "/drive/v3/drives") {
    return { policy: "oauth", operation: "drives.list" };
  }
  if (path === "/drive/v3/files/generateIds") {
    return { policy: "oauth", operation: "files.generateIds" };
  }
  if (path === "/upload/drive/v3/files" && method === "POST") {
    return { policy: "oauth", operation: "upload.start" };
  }
  if (path === "/upload/drive/v3/files" && method === "PUT") {
    return { policy: "oauth", operation: "upload.chunk/probe" };
  }
  const revisionMatch = /^\/drive\/v3\/files\/[^/]+\/revisions\/[^/]+$/.exec(
    path,
  );
  if (revisionMatch !== null && method === "GET") {
    return queryKeys.has("alt")
      ? { policy: "service_account", operation: "revisions.media" }
      : { policy: "either", operation: "revisions.get" };
  }
  const exportMatch = /^\/drive\/v3\/files\/[^/]+\/export$/.exec(path);
  if (exportMatch !== null && method === "GET") {
    return { policy: "service_account", operation: "files.export" };
  }
  const permMatch = /^\/drive\/v3\/files\/[^/]+\/permissions(?:\/[^/]+)?$/.exec(
    path,
  );
  if (permMatch !== null) {
    return { policy: "oauth", operation: `permissions.${method.toLowerCase()}` };
  }
  const fileMatch = /^\/drive\/v3\/files\/[^/]+$/.exec(path);
  if (fileMatch !== null) {
    if (method === "GET" && !queryKeys.has("alt")) {
      return { policy: "either", operation: "files.get" };
    }
    if (method === "GET") {
      return { policy: "service_account", operation: "files.media" };
    }
    if (method === "PATCH") {
      return { policy: "oauth", operation: "files.update" };
    }
    if (method === "DELETE") {
      return { policy: "oauth", operation: "files.delete" };
    }
    return null;
  }
  if (path === "/drive/v3/files") {
    if (method === "GET") return { policy: "oauth", operation: "files.list" };
    if (method === "POST") return { policy: "oauth", operation: "files.create" };
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Google-shaped error bodies (consumed by drive/errors.ts classification).
// ---------------------------------------------------------------------------

function googleError(
  status: number,
  reason: string,
  message: string,
): Response {
  return Response.json(
    {
      error: {
        code: status,
        message,
        errors: [
          { domain: "global", reason, message, locationType: "other" },
        ],
      },
    },
    { status },
  );
}

function oauthErrorBody(
  status: number,
  error: string,
  description?: string,
): Response {
  return Response.json(
    { error, ...(description === undefined ? {} : { error_description: description }) },
    { status },
  );
}

// ---------------------------------------------------------------------------
// Fake
// ---------------------------------------------------------------------------

export interface FakeGoogleOptions {
  /** Pre-seeded drives, e.g. [{id:'journey-drive-1', name:'Journey Drive'}]. */
  drives?: Array<{ id: string; name: string }>;
  /** OAuth permissionId issued on code exchange / used by refresh grants. */
  oauthPrincipal?: string;
  oauthEmail?: string;
  /** Principals granted drive membership at seed time: {driveId, principal, role}. */
  members?: Array<{ driveId: string; principal: string; role: DriveRole }>;
  now?: () => number;
}

export interface FakeGoogle {
  readonly state: FakeState;
  readonly log: FakeRequestLogEntry[];
  /**
   * Serve an upstream-bound request. Miniflare calls this via
   * `outboundService`; the control port calls it for non-control paths.
   */
  handle(request: Request): Promise<Response>;
  /** Synchronous snapshot of the request log (defensive copy). */
  requests(): FakeRequestLogEntry[];
}

interface TokenContext {
  provider: Exclude<FakeProvider, "none">;
  principal: string;
  scopes: string[];
}

export function createFakeGoogle(options: FakeGoogleOptions = {}): FakeGoogle {
  const state = createFakeState();
  const log: FakeRequestLogEntry[] = [];
  const now = options.now ?? Date.now;
  const oauthPrincipal = options.oauthPrincipal ?? "perm-fake-operator";
  const oauthEmail = options.oauthEmail ?? "e2e-operator@fake-google.test";
  let seq = 0;
  let idCounter = 0;

  for (const drive of options.drives ?? []) {
    state.drives.set(drive.id, { id: drive.id, name: drive.name });
    // The Shared Drive root is itself a folder whose driveId is its own id.
    state.files.set(drive.id, {
      id: drive.id,
      name: drive.name,
      mimeType: FOLDER_MIME,
      parents: [],
      driveId: drive.id,
      trashed: false,
      content: null,
      exportable: false,
      canDownload: false,
      revisions: [],
      createdTime: new Date(now()).toISOString(),
      modifiedTime: new Date(now()).toISOString(),
    });
    state.members.set(drive.id, new Map());
  }
  for (const member of options.members ?? []) {
    state.members.get(member.driveId)?.set(member.principal, member.role);
  }

  function nextId(prefix: string): string {
    idCounter += 1;
    return `${prefix}${idCounter.toString(36)}${Math.random()
      .toString(36)
      .slice(2, 12)}`.replace(/[^A-Za-z0-9_-]/g, "x");
  }

  function roleOf(driveId: string, principal: string): DriveRole | undefined {
    return state.members.get(driveId)?.get(principal);
  }

  function canRead(ctx: TokenContext, file: FakeFile): boolean {
    const role = roleOf(file.driveId, ctx.principal);
    return role !== undefined;
  }

  function canWrite(ctx: TokenContext, driveId: string): boolean {
    const role = roleOf(driveId, ctx.principal);
    return role === "writer" || role === "organizer";
  }

  function authenticate(req: Request): TokenContext | null {
    const auth = req.headers.get("authorization");
    if (auth === null || !auth.startsWith("Bearer ")) return null;
    const token = state.accessTokens.get(auth.slice("Bearer ".length));
    if (token === undefined || token.revoked || token.expiresAtMs <= now()) {
      return null;
    }
    return { provider: token.provider, principal: token.principal, scopes: token.scopes };
  }

  function record(
    req: Request,
    rule: SurfaceRule | null,
    ctx: TokenContext | null,
    status: number,
    requestBytes: number,
    responseBytes: number,
    extra?: { sha256?: string; violation?: string },
  ): void {
    const url = new URL(req.url);
    let violation = extra?.violation;
    if (
      violation === undefined &&
      rule !== null &&
      ctx !== null &&
      (rule.policy === "oauth" || rule.policy === "service_account") &&
      ctx.provider !== rule.policy
    ) {
      violation = `${ctx.provider}-token-on-${rule.operation}`;
    }
    log.push({
      seq: seq++,
      at: new Date(now()).toISOString(),
      host: url.host,
      method: req.method,
      path: url.pathname,
      queryKeys: [...url.searchParams.keys()],
      operation: rule?.operation ?? `${req.method} ${url.pathname}`,
      provider: ctx?.provider ?? "none",
      principal: ctx?.principal ?? null,
      status,
      requestBytes,
      responseBytes,
      ...(extra?.sha256 === undefined ? {} : { requestSha256: extra.sha256 }),
      ...(violation === undefined ? {} : { providerViolation: violation }),
    });
  }

  function respond(
    req: Request,
    rule: SurfaceRule | null,
    ctx: TokenContext | null,
    res: Response,
    meta: { requestBytes: number; sha256?: string; responseBytes: number },
  ): Response {
    record(req, rule, ctx, res.status, meta.requestBytes, meta.responseBytes, {
      ...(meta.sha256 === undefined ? {} : { sha256: meta.sha256 }),
    });
    return res;
  }

  // -------------------------------------------------------------------------
  // File meta projection (fields superset; the worker picks what it needs).
  // -------------------------------------------------------------------------

  function fileMetaJson(file: FakeFile, ctx: TokenContext): Record<string, unknown> {
    const isFolder = file.mimeType === FOLDER_MIME;
    const role = roleOf(file.driveId, ctx.principal);
    return {
      kind: "drive#file",
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: file.content === null ? undefined : String(file.content.byteLength),
      modifiedTime: file.modifiedTime,
      createdTime: file.createdTime,
      trashed: file.trashed,
      parents: file.parents,
      driveId: file.driveId,
      headRevisionId: file.headRevisionId,
      md5Checksum: file.md5Checksum,
      sha256Checksum: file.sha256Checksum,
      resourceKey: file.resourceKey,
      thumbnailLink: file.thumbnailLink,
      capabilities: {
        canDownload: !isFolder && file.canDownload && file.content !== null,
        canAddChildren: isFolder && (role === "writer" || role === "organizer"),
        canTrash: role === "writer" || role === "organizer",
        canReadRevisions: role !== undefined && file.revisions.length > 0,
      },
    };
  }

  function requireDriveMember(
    ctx: TokenContext,
    driveId: string,
  ): Response | null {
    if (roleOf(driveId, ctx.principal) === undefined) {
      return googleError(404, "notFound", `Shared drive not found: ${driveId}`);
    }
    return null;
  }

  function visibleFile(ctx: TokenContext, id: string): FakeFile | Response {
    const file = state.files.get(id);
    if (file === undefined || !canRead(ctx, file)) {
      return googleError(404, "notFound", `File not found: ${id}.`);
    }
    return file;
  }

  // -------------------------------------------------------------------------
  // Token endpoint (oauth2.googleapis.com/token + /revoke)
  // -------------------------------------------------------------------------

  function issueAccessToken(
    provider: Exclude<FakeProvider, "none">,
    principal: string,
    scopes: string[],
  ): { access_token: string; expires_in: number; scope: string; token_type: string } {
    const value = `fake-at-${provider === "oauth" ? "oauth" : "sa"}-${nextId("t")}`;
    state.accessTokens.set(value, {
      value,
      provider,
      principal,
      scopes,
      expiresAtMs: now() + 3600_000,
      revoked: false,
    });
    return {
      access_token: value,
      expires_in: 3600,
      scope: scopes.join(" "),
      token_type: "Bearer",
    };
  }

  async function handleToken(req: Request, path: string): Promise<Response> {
    if (path === "/revoke" && req.method === "POST") {
      const form = new URLSearchParams(await req.text());
      const token = form.get("token") ?? "";
      const access = state.accessTokens.get(token);
      if (access !== undefined) access.revoked = true;
      const refresh = state.refreshTokens.get(token);
      if (refresh !== undefined) refresh.revoked = true;
      return new Response(null, { status: 200 });
    }
    if (path !== "/token" || req.method !== "POST") {
      return oauthErrorBody(404, "invalid_request", "unknown token endpoint path");
    }
    const form = new URLSearchParams(await req.text());
    const grantType = form.get("grant_type") ?? "";

    if (grantType === "authorization_code") {
      const code = form.get("code") ?? "";
      const entry = state.authCodes.get(code);
      if (entry === undefined || entry.used) {
        return oauthErrorBody(400, "invalid_grant", "Bad Request");
      }
      if (entry.clientId !== (form.get("client_id") ?? "")) {
        return oauthErrorBody(400, "invalid_grant", "client_id mismatch");
      }
      entry.used = true;
      const grant = issueAccessToken("oauth", entry.principal, entry.scopes);
      const refreshToken = `fake-rt-${nextId("r")}`;
      state.refreshTokens.set(refreshToken, {
        token: refreshToken,
        provider: "oauth",
        clientId: entry.clientId,
        principal: entry.principal,
        scopes: entry.scopes,
        revoked: false,
      });
      return Response.json({ ...grant, refresh_token: refreshToken });
    }

    if (grantType === "refresh_token") {
      const refreshToken = form.get("refresh_token") ?? "";
      const grant = state.refreshTokens.get(refreshToken);
      if (grant === undefined || grant.revoked) {
        return oauthErrorBody(400, "invalid_grant", "Token has been expired or revoked.");
      }
      // No refresh_token in the reply: the existing grant persists.
      return Response.json(issueAccessToken("oauth", grant.principal, grant.scopes));
    }

    if (grantType === JWT_BEARER_GRANT) {
      const assertion = form.get("assertion") ?? "";
      const verified = await verifyServiceAccountJwt(assertion);
      if (verified === null) {
        return oauthErrorBody(400, "invalid_grant", "Invalid JWT: failed verification.");
      }
      return Response.json(
        issueAccessToken("service_account", verified.email, [SA_READ_SCOPE]),
      );
    }

    return oauthErrorBody(400, "unsupported_grant_type", `grant_type ${grantType}`);
  }

  /**
   * RS256 verification against the registered SA public key — Google checks
   * the signature, so the fake does too (a signed JWT flow stays signed).
   */
  async function verifyServiceAccountJwt(
    assertion: string,
  ): Promise<{ email: string; scope: string } | null> {
    const parts = assertion.split(".");
    if (parts.length !== 3) return null;
    const [header, payload, signature] = parts as [string, string, string];
    try {
      const claims = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
      const email = claims.iss;
      const scope = claims.scope;
      const aud = claims.aud;
      const exp = claims.exp;
      if (
        typeof email !== "string" ||
        typeof scope !== "string" ||
        aud !== "https://oauth2.googleapis.com/token" ||
        typeof exp !== "number" ||
        exp * 1000 <= now()
      ) {
        return null;
      }
      const scopes = scope.split(" ").filter(Boolean);
      if (scopes.length !== 1 || scopes[0] !== SA_READ_SCOPE) return null;
      const account = state.serviceAccounts.get(email);
      if (account === undefined || !account.enabled) return null;
      const { createVerify } = await import("node:crypto");
      const verifier = createVerify("RSA-SHA256");
      verifier.update(`${header}.${payload}`);
      if (!verifier.verify(account.publicKeyPem, signature, "base64url")) {
        return null;
      }
      return { email, scope };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Drive v3 handlers
  // -------------------------------------------------------------------------

  async function readBody(req: Request): Promise<{ bytes: Uint8Array; sha256: string }> {
    const buf = new Uint8Array(await req.arrayBuffer());
    return { bytes: buf, sha256: createHash("sha256").update(buf).digest("hex") };
  }

  function listFiles(ctx: TokenContext, url: URL): Response {
    const driveId = url.searchParams.get("driveId") ?? "";
    const denied = requireDriveMember(ctx, driveId);
    if (denied !== null) return denied;
    const q = url.searchParams.get("q") ?? "";
    const parentMatch = /'([^']+)'\s+in\s+parents/.exec(q);
    const nameMatch = /name\s+contains\s+'((?:\\'|[^'])*)'/.exec(q);
    const trashedMatch = /trashed\s*=\s*(true|false)/.exec(q);
    const parentId = parentMatch?.[1];
    const nameTerm = nameMatch?.[1]?.replace(/\\'/g, "'").replace(/\\\\/g, "\\");
    const wantTrashed = trashedMatch?.[1] === "true";
    const pageSizeRaw = Number.parseInt(url.searchParams.get("pageSize") ?? "200", 10);
    const pageSize = Number.isInteger(pageSizeRaw) && pageSizeRaw > 0 ? Math.min(pageSizeRaw, 1000) : 200;
    const offset = Math.max(0, Number.parseInt(url.searchParams.get("pageToken") ?? "0", 10) || 0);

    const entries = [...state.files.values()].filter((file) => {
      if (file.driveId !== driveId) return false;
      if ((file.trashed || false) !== wantTrashed && trashedMatch !== null) {
        if (file.trashed !== wantTrashed) return false;
      }
      if (parentId !== undefined && !file.parents.includes(parentId)) return false;
      if (nameTerm !== undefined && !file.name.includes(nameTerm)) return false;
      return true;
    });
    // orderBy=folder,name_natural: folders first, then natural name order.
    entries.sort((a, b) => {
      const af = a.mimeType === FOLDER_MIME ? 0 : 1;
      const bf = b.mimeType === FOLDER_MIME ? 0 : 1;
      if (af !== bf) return af - bf;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    const page = entries.slice(offset, offset + pageSize);
    const nextOffset = offset + pageSize;
    return Response.json({
      kind: "drive#fileList",
      files: page.map((file) => listEntryJson(file)),
      ...(nextOffset < entries.length
        ? { nextPageToken: String(nextOffset) }
        : {}),
    });
  }

  function listEntryJson(file: FakeFile): Record<string, unknown> {
    return {
      id: file.id,
      name: file.name,
      mimeType: file.mimeType,
      size: file.content === null ? undefined : String(file.content.byteLength),
      modifiedTime: file.modifiedTime,
      trashed: file.trashed,
      resourceKey: file.resourceKey,
      thumbnailLink: file.thumbnailLink,
      shortcutDetails: undefined,
    };
  }

  function fileFromMetadata(
    id: string,
    meta: { name?: unknown; mimeType?: unknown; parents?: unknown },
    ctx: TokenContext,
  ): FakeFile | Response {
    const parentIds = Array.isArray(meta.parents)
      ? meta.parents.filter((p): p is string => typeof p === "string")
      : [];
    if (parentIds.length === 0) {
      return googleError(400, "badRequest", "parents are required");
    }
    const parent = state.files.get(parentIds[0] ?? "");
    if (parent === undefined || parent.mimeType !== FOLDER_MIME) {
      return googleError(404, "notFound", "Parent folder not found.");
    }
    if (!canWrite(ctx, parent.driveId)) {
      return googleError(403, "insufficientPermissions", "Insufficient permissions for the parent.");
    }
    if (state.files.has(id)) {
      return googleError(409, "alreadyExists", `A file with id ${id} already exists.`);
    }
    const nowIso = new Date(now()).toISOString();
    const file: FakeFile = {
      id,
      name: typeof meta.name === "string" ? meta.name : "untitled",
      mimeType: typeof meta.mimeType === "string" ? meta.mimeType : "application/octet-stream",
      parents: parentIds,
      driveId: parent.driveId,
      trashed: false,
      content: null,
      exportable: false,
      canDownload: true,
      revisions: [],
      createdTime: nowIso,
      modifiedTime: nowIso,
    };
    state.files.set(id, file);
    return file;
  }

  function serveMedia(
    file: FakeFile,
    req: Request,
    revisionId?: string,
  ): Response {
    if (file.trashed) {
      return googleError(404, "notFound", `File not found: ${file.id}.`);
    }
    if (!file.canDownload) {
      return googleError(
        403,
        "cannotDownloadFile",
        "The file is restricted from download.",
      );
    }
    const revision =
      revisionId === undefined
        ? undefined
        : file.revisions.find((rev) => rev.id === revisionId);
    if (revisionId !== undefined && revision === undefined) {
      return googleError(404, "notFound", `Revision not found: ${revisionId}.`);
    }
    const content =
      revision === undefined ? file.content : revision.content;
    if (content === null) {
      return googleError(403, "cannotDownloadFile", "File has no content.");
    }
    const total = content.byteLength;
    const mime =
      revision === undefined ? file.mimeType : revision.mimeType;
    const range = req.headers.get("range");
    const etag = `"fake-etag-${file.id}-${file.headRevisionId ?? "0"}"`;
    const baseHeaders: Record<string, string> = {
      "content-type": mime,
      etag,
      "last-modified": file.modifiedTime,
    };
    if (range !== null) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
      if (match === null) {
        return googleError(416, "badRequest", "Invalid range");
      }
      const start = Number.parseInt(match[1] ?? "0", 10);
      const endRaw = match[2] ?? "";
      const end = endRaw === "" ? total - 1 : Math.min(Number.parseInt(endRaw, 10), total - 1);
      if (start >= total || end < start) {
        return new Response(null, {
          status: 416,
          headers: { "content-range": `bytes */${total}` },
        });
      }
      const slice = content.subarray(start, end + 1);
      return new Response(slice.slice().buffer as ArrayBuffer, {
        status: 206,
        headers: {
          ...baseHeaders,
          "content-length": String(slice.byteLength),
          "content-range": `bytes ${start}-${end}/${total}`,
        },
      });
    }
    return new Response(content.slice().buffer as ArrayBuffer, {
      status: 200,
      headers: { ...baseHeaders, "content-length": String(total) },
    });
  }

  function finalizeSession(
    session: FakeUploadSession,
    ctx: TokenContext,
  ): Response {
    const file = state.files.get(session.fileId);
    if (file === undefined) {
      return googleError(404, "notFound", "Upload target not found.");
    }
    const content = session.confirmed;
    const revisionId = file.headRevisionId === undefined ? "rev-1" : `rev-${file.revisions.length + 1}`;
    file.content = content;
    file.canDownload = true;
    file.md5Checksum = createHash("md5").update(content).digest("base64");
    file.sha256Checksum = createHash("sha256").update(content).digest("hex");
    file.headRevisionId = revisionId;
    file.modifiedTime = new Date(now()).toISOString();
    file.revisions.push({
      id: revisionId,
      mimeType: file.mimeType,
      modifiedTime: file.modifiedTime,
      size: String(content.byteLength),
      keepForever: true,
      content,
    });
    session.finalized = true;
    return Response.json(fileMetaJson(file, ctx), { status: 200 });
  }

  function resumeRangeHeader(session: FakeUploadSession): Record<string, string> {
    return session.confirmed.byteLength === 0
      ? {}
      : { range: `bytes=0-${session.confirmed.byteLength - 1}` };
  }

  async function handleUploadPut(
    req: Request,
    ctx: TokenContext,
    url: URL,
  ): Promise<{ res: Response; requestBytes: number; sha256?: string }> {
    const uploadId = url.searchParams.get("upload_id") ?? "";
    const session = state.uploadSessions.get(uploadId);
    if (session === undefined || session.finalized === false && session.expiresAtMs <= now()) {
      return {
        res: googleError(404, "notFound", "Upload session not found or expired."),
        requestBytes: 0,
      };
    }
    if (session.finalized) {
      // Idempotent replay of a completed session: Google re-answers with the file.
      const file = state.files.get(session.fileId);
      if (file !== undefined) {
        return { res: Response.json(fileMetaJson(file, ctx), { status: 200 }), requestBytes: 0 };
      }
    }
    if (!canWrite(ctx, session.driveId)) {
      return {
        res: googleError(403, "insufficientPermissions", "Insufficient permissions."),
        requestBytes: 0,
      };
    }
    const contentRange = req.headers.get("content-range");
    if (contentRange === null) {
      return {
        res: googleError(400, "badRequest", "Content-Range required for resumable PUT."),
        requestBytes: 0,
      };
    }
    const probe = /^bytes \*\/(\d+)$/.exec(contentRange.trim());
    if (probe !== null) {
      const total = BigInt(probe[1] ?? "0");
      if (session.declaredTotal !== undefined && session.declaredTotal !== total) {
        return {
          res: googleError(400, "badRequest", "Declared total does not match the session."),
          requestBytes: 0,
        };
      }
      session.declaredTotal = total;
      if (BigInt(session.confirmed.byteLength) === total) {
        return { res: finalizeSession(session, ctx), requestBytes: 0 };
      }
      return {
        res: new Response(null, {
          status: 308,
          headers: resumeRangeHeader(session),
        }),
        requestBytes: 0,
      };
    }
    const chunk = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange.trim());
    if (chunk === null) {
      return {
        res: googleError(400, "badRequest", "Malformed Content-Range."),
        requestBytes: 0,
      };
    }
    const start = Number.parseInt(chunk[1] ?? "0", 10);
    const end = Number.parseInt(chunk[2] ?? "0", 10);
    const total = Number.parseInt(chunk[3] ?? "0", 10);
    const { bytes, sha256 } = await readBody(req);
    if (bytes.byteLength !== end - start + 1) {
      return {
        res: googleError(400, "badRequest", "Body length does not match Content-Range."),
        requestBytes: bytes.byteLength,
        sha256,
      };
    }
    if (session.declaredTotal !== undefined && BigInt(session.declaredTotal) !== BigInt(total)) {
      return {
        res: googleError(400, "badRequest", "Declared total does not match the session."),
        requestBytes: bytes.byteLength,
        sha256,
      };
    }
    if (start !== session.confirmed.byteLength) {
      // Google answers the confirmed prefix it actually holds.
      return {
        res: new Response(null, {
          status: 308,
          headers: resumeRangeHeader(session),
        }),
        requestBytes: bytes.byteLength,
        sha256,
      };
    }
    const merged = new Uint8Array(session.confirmed.byteLength + bytes.byteLength);
    merged.set(session.confirmed, 0);
    merged.set(bytes, session.confirmed.byteLength);
    session.confirmed = merged;
    if (end === total - 1) {
      return {
        res: finalizeSession(session, ctx),
        requestBytes: bytes.byteLength,
        sha256,
      };
    }
    return {
      res: new Response(null, { status: 308, headers: resumeRangeHeader(session) }),
      requestBytes: bytes.byteLength,
      sha256,
    };
  }

  async function handleUploadStart(
    req: Request,
    ctx: TokenContext,
    url: URL,
  ): Promise<{ res: Response; requestBytes: number; sha256?: string }> {
    if (url.searchParams.get("uploadType") !== "resumable") {
      return {
        res: googleError(400, "badRequest", "uploadType=resumable required."),
        requestBytes: 0,
      };
    }
    const { bytes, sha256 } = await readBody(req);
    let meta: { id?: unknown; name?: unknown; mimeType?: unknown; parents?: unknown };
    try {
      meta = JSON.parse(new TextDecoder().decode(bytes)) as typeof meta;
    } catch {
      return { res: googleError(400, "badRequest", "Malformed metadata."), requestBytes: bytes.byteLength, sha256 };
    }
    const fileId = typeof meta.id === "string" ? meta.id : nextId("file-");
    const created = fileFromMetadata(fileId, meta, ctx);
    if (created instanceof Response) {
      return { res: created, requestBytes: bytes.byteLength, sha256 };
    }
    const uploadId = nextId("upload-");
    const declared = req.headers.get("x-upload-content-length");
    state.uploadSessions.set(uploadId, {
      uploadId,
      fileId,
      name: created.name,
      mimeType: created.mimeType,
      parents: created.parents,
      driveId: created.driveId,
      declaredTotal:
        declared !== null && /^[0-9]+$/.test(declared) ? BigInt(declared) : undefined,
      contentType: req.headers.get("x-upload-content-type") ?? created.mimeType,
      confirmed: new Uint8Array(0),
      pending: new Map(),
      expiresAtMs: now() + 7 * 24 * 3600_000,
      finalized: false,
    });
    const sessionUri =
      `https://${GOOGLE_API_HOST}/upload/drive/v3/files` +
      `?uploadType=resumable&upload_id=${encodeURIComponent(uploadId)}&upload_protocol=resumable`;
    return {
      res: new Response(null, {
        status: 200,
        headers: { location: sessionUri },
      }),
      requestBytes: bytes.byteLength,
      sha256,
    };
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const host = url.host;
    const queryKeys = new Set(url.searchParams.keys());
    const rule = classifySurface(host, req.method, url.pathname, queryKeys);

    // Token endpoint: identity comes from grant material, not a bearer.
    if (host === GOOGLE_TOKEN_HOST) {
      const body = req.method === "POST" ? await req.clone().text() : "";
      const res = await handleToken(req, url.pathname);
      const resClone = res.clone();
      let provider: FakeProvider = "none";
      let principal: string | null = null;
      const grantType = new URLSearchParams(body).get("grant_type") ?? "";
      if (grantType === JWT_BEARER_GRANT) provider = "service_account";
      if (grantType === "authorization_code" || grantType === "refresh_token") {
        provider = "oauth";
      }
      if (res.ok && provider !== "none") {
        try {
          const parsed = (await resClone.json()) as { access_token?: string };
          const issued = state.accessTokens.get(parsed.access_token ?? "");
          principal = issued?.principal ?? null;
        } catch {
          // leave principal null
        }
      }
      log.push({
        seq: seq++,
        at: new Date(now()).toISOString(),
        host,
        method: req.method,
        path: url.pathname,
        queryKeys: [...url.searchParams.keys()],
        operation: `token:${grantType || url.pathname}`,
        provider,
        principal,
        status: res.status,
        requestBytes: encoder.encode(body).byteLength,
        responseBytes: 0,
      });
      return res;
    }

    const ctx = authenticate(req);
    if (ctx === null) {
      const res = googleError(
        401,
        "authError",
        "Request had invalid authentication credentials.",
      );
      record(req, rule, null, res.status, 0, 0);
      return res;
    }

    if (
      (rule?.policy === "oauth" || rule?.policy === "service_account") &&
      ctx.provider !== rule.policy
    ) {
      // Surface the request to the state engine anyway — Google itself does
      // not know our provider split; the violation marker is the evidence.
    }

    if (host.endsWith(GOOGLE_USERCONTENT_SUFFIX)) {
      const thumbId = url.pathname.replace(/^\/fake-thumb\//, "");
      const file = [...state.files.values()].find(
        (f) => f.thumbnailLink === req.url || f.id === thumbId,
      );
      const res =
        file !== undefined &&
        file.thumbnailContent !== undefined &&
        canRead(ctx, file)
          ? new Response(file.thumbnailContent.slice().buffer as ArrayBuffer, {
              status: 200,
              headers: { "content-type": "image/png" },
            })
          : googleError(404, "notFound", "Thumbnail not found.");
      return respond(req, rule, ctx, res, {
        requestBytes: 0,
        responseBytes: file?.thumbnailContent?.byteLength ?? 0,
      });
    }

    if (host !== GOOGLE_API_HOST || rule === null) {
      // Fail closed: non-Google egress and unknown paths never reach a network.
      const res = googleError(502, "badGateway", "fake-google: unhandled destination");
      record(req, rule, ctx, res.status, 0, 0, { violation: "unhandled-destination" });
      return res;
    }

    const path = url.pathname;
    try {
      if (path === "/drive/v3/about" && req.method === "GET") {
        return respond(req, rule, ctx, Response.json({
          kind: "drive#about",
          user: {
            kind: "drive#user",
            displayName: "Fake Operator",
            permissionId: ctx.provider === "oauth" ? ctx.principal : oauthPrincipal,
            emailAddress: oauthEmail,
          },
        }), { requestBytes: 0, responseBytes: 0 });
      }
      if (path === "/drive/v3/drives" && req.method === "GET") {
        const drives = [...state.drives.values()].filter(
          (d) => roleOf(d.id, ctx.principal) !== undefined,
        );
        const pageSize = Math.min(
          Math.max(1, Number.parseInt(url.searchParams.get("pageSize") ?? "100", 10) || 100),
          100,
        );
        const offset = Math.max(0, Number.parseInt(url.searchParams.get("pageToken") ?? "0", 10) || 0);
        const page = drives.slice(offset, offset + pageSize);
        return respond(req, rule, ctx, Response.json({
          kind: "drive#driveList",
          drives: page.map((d) => ({ kind: "drive#drive", id: d.id, name: d.name })),
          ...(offset + pageSize < drives.length ? { nextPageToken: String(offset + pageSize) } : {}),
        }), { requestBytes: 0, responseBytes: 0 });
      }
      if (path === "/drive/v3/files/generateIds" && req.method === "GET") {
        const count = Math.min(
          Math.max(1, Number.parseInt(url.searchParams.get("count") ?? "1", 10) || 1),
          1000,
        );
        return respond(req, rule, ctx, Response.json({
          kind: "drive#generatedIds",
          ids: Array.from({ length: count }, () => nextId("fid-")),
        }), { requestBytes: 0, responseBytes: 0 });
      }
      if (path === "/drive/v3/files" && req.method === "GET") {
        return respond(req, rule, ctx, listFiles(ctx, url), {
          requestBytes: 0,
          responseBytes: 0,
        });
      }
      if (path === "/drive/v3/files" && req.method === "POST") {
        const { bytes, sha256 } = await readBody(req);
        let meta: { id?: unknown; name?: unknown; mimeType?: unknown; parents?: unknown };
        try {
          meta = JSON.parse(new TextDecoder().decode(bytes)) as typeof meta;
        } catch {
          return respond(req, rule, ctx, googleError(400, "badRequest", "Malformed metadata."), {
            requestBytes: bytes.byteLength,
            sha256,
            responseBytes: 0,
          });
        }
        const id = typeof meta.id === "string" ? meta.id : nextId("file-");
        const created = fileFromMetadata(id, meta, ctx);
        return respond(req, rule, ctx, created instanceof Response
          ? created
          : Response.json(fileMetaJson(created, ctx), { status: 200 }), {
          requestBytes: bytes.byteLength,
          sha256,
          responseBytes: 0,
        });
      }
      if (path === "/upload/drive/v3/files" && req.method === "POST") {
        const out = await handleUploadStart(req, ctx, url);
        return respond(req, rule, ctx, out.res, {
          requestBytes: out.requestBytes,
          ...(out.sha256 === undefined ? {} : { sha256: out.sha256 }),
          responseBytes: 0,
        });
      }
      if (path === "/upload/drive/v3/files" && req.method === "PUT") {
        const out = await handleUploadPut(req, ctx, url);
        return respond(req, rule, ctx, out.res, {
          requestBytes: out.requestBytes,
          ...(out.sha256 === undefined ? {} : { sha256: out.sha256 }),
          responseBytes: 0,
        });
      }

      const fileMatch = /^\/drive\/v3\/files\/([^/]+)$/.exec(path);
      if (fileMatch !== null) {
        const fileId = decodeURIComponent(fileMatch[1] ?? "");
        if (req.method === "GET" && url.searchParams.get("alt") === "media") {
          const file = visibleFile(ctx, fileId);
          if (file instanceof Response) {
            return respond(req, rule, ctx, file, { requestBytes: 0, responseBytes: 0 });
          }
          const res = serveMedia(file, req);
          return respond(req, rule, ctx, res, {
            requestBytes: 0,
            responseBytes: Number(res.headers.get("content-length") ?? 0) || file.content?.byteLength || 0,
          });
        }
        if (req.method === "GET") {
          const file = visibleFile(ctx, fileId);
          return respond(req, rule, ctx, file instanceof Response
            ? file
            : Response.json(fileMetaJson(file, ctx)), {
            requestBytes: 0,
            responseBytes: 0,
          });
        }
        if (req.method === "PATCH") {
          const file = visibleFile(ctx, fileId);
          if (file instanceof Response) {
            return respond(req, rule, ctx, file, { requestBytes: 0, responseBytes: 0 });
          }
          if (!canWrite(ctx, file.driveId)) {
            return respond(req, rule, ctx, googleError(403, "insufficientPermissions", "Insufficient permissions."), {
              requestBytes: 0, responseBytes: 0,
            });
          }
          const { bytes, sha256 } = await readBody(req);
          let patch: { trashed?: unknown; name?: unknown };
          try {
            patch = JSON.parse(new TextDecoder().decode(bytes)) as typeof patch;
          } catch {
            return respond(req, rule, ctx, googleError(400, "badRequest", "Malformed body."), {
              requestBytes: bytes.byteLength, sha256, responseBytes: 0,
            });
          }
          if (patch.trashed === true) file.trashed = true;
          if (typeof patch.name === "string" && patch.name !== "") file.name = patch.name;
          const addParents = url.searchParams.get("addParents");
          const removeParents = url.searchParams.get("removeParents");
          if (addParents !== null) {
            for (const p of addParents.split(",")) {
              if (p !== "" && !file.parents.includes(p)) file.parents.push(p);
            }
          }
          if (removeParents !== null) {
            const drop = new Set(removeParents.split(","));
            file.parents = file.parents.filter((p) => !drop.has(p));
          }
          file.modifiedTime = new Date(now()).toISOString();
          return respond(req, rule, ctx, Response.json(fileMetaJson(file, ctx)), {
            requestBytes: bytes.byteLength, sha256, responseBytes: 0,
          });
        }
        return respond(req, rule, ctx, googleError(405, "badRequest", "Method not allowed."), {
          requestBytes: 0, responseBytes: 0,
        });
      }

      const permMatch = /^\/drive\/v3\/files\/([^/]+)\/permissions(?:\/([^/]+))?$/.exec(path);
      if (permMatch !== null) {
        const fileId = decodeURIComponent(permMatch[1] ?? "");
        const file = state.files.get(fileId);
        if (file === undefined) {
          return respond(req, rule, ctx, googleError(404, "notFound", "File not found."), {
            requestBytes: 0, responseBytes: 0,
          });
        }
        if (req.method === "GET") {
          const members = [...(state.members.get(file.driveId)?.entries() ?? [])].map(
            ([principal, role], i) => ({
              id: `perm-${file.driveId}-${i}`,
              type: "user",
              role,
              emailAddress: principal,
            }),
          );
          return respond(req, rule, ctx, Response.json({ kind: "drive#permissionList", permissions: members }), {
            requestBytes: 0, responseBytes: 0,
          });
        }
        if (req.method === "POST") {
          const { bytes, sha256 } = await readBody(req);
          let body: { role?: unknown; emailAddress?: unknown; type?: unknown };
          try {
            body = JSON.parse(new TextDecoder().decode(bytes)) as typeof body;
          } catch {
            return respond(req, rule, ctx, googleError(400, "badRequest", "Malformed body."), {
              requestBytes: bytes.byteLength, sha256, responseBytes: 0,
            });
          }
          const principal = typeof body.emailAddress === "string" ? body.emailAddress : "";
          const role = body.role === "organizer" || body.role === "writer" ? body.role : "reader";
          if (principal === "") {
            return respond(req, rule, ctx, googleError(400, "badRequest", "emailAddress required."), {
              requestBytes: bytes.byteLength, sha256, responseBytes: 0,
            });
          }
          state.members.get(file.driveId)?.set(principal, role);
          return respond(req, rule, ctx, Response.json({ id: `perm-${nextId("p")}`, type: "user", role, emailAddress: principal }, { status: 200 }), {
            requestBytes: bytes.byteLength, sha256, responseBytes: 0,
          });
        }
      }

      const revMatch = /^\/drive\/v3\/files\/([^/]+)\/revisions\/([^/]+)$/.exec(path);
      if (revMatch !== null && req.method === "GET") {
        const fileId = decodeURIComponent(revMatch[1] ?? "");
        const revId = decodeURIComponent(revMatch[2] ?? "");
        const file = visibleFile(ctx, fileId);
        if (file instanceof Response) {
          return respond(req, rule, ctx, file, { requestBytes: 0, responseBytes: 0 });
        }
        const rev = file.revisions.find((r) => r.id === revId);
        if (rev === undefined) {
          return respond(req, rule, ctx, googleError(404, "notFound", "Revision not found."), {
            requestBytes: 0, responseBytes: 0,
          });
        }
        if (url.searchParams.get("alt") === "media") {
          if (!rev.keepForever) {
            return respond(req, rule, ctx, googleError(403, "cannotDownloadFile", "Revision not kept forever."), {
              requestBytes: 0, responseBytes: 0,
            });
          }
          const res = serveMedia(file, req, revId);
          return respond(req, rule, ctx, res, {
            requestBytes: 0,
            responseBytes: rev.content.byteLength,
          });
        }
        return respond(req, rule, ctx, Response.json({
          id: rev.id,
          mimeType: rev.mimeType,
          modifiedTime: rev.modifiedTime,
          size: rev.size,
          keepForever: rev.keepForever,
        }), { requestBytes: 0, responseBytes: 0 });
      }

      const exportMatch = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(path);
      if (exportMatch !== null && req.method === "GET") {
        const file = visibleFile(ctx, decodeURIComponent(exportMatch[1] ?? ""));
        if (file instanceof Response) {
          return respond(req, rule, ctx, file, { requestBytes: 0, responseBytes: 0 });
        }
        if (!file.exportable || file.content === null) {
          return respond(req, rule, ctx, googleError(403, "fileNotExportable", "The file is not exportable."), {
            requestBytes: 0, responseBytes: 0,
          });
        }
        return respond(req, rule, ctx, new Response(file.content.slice().buffer as ArrayBuffer, {
          status: 200,
          headers: { "content-type": url.searchParams.get("mimeType") ?? "application/pdf", "content-length": String(file.content.byteLength) },
        }), { requestBytes: 0, responseBytes: file.content.byteLength });
      }

      return respond(req, rule, ctx, googleError(404, "notFound", `No fake route for ${req.method} ${path}`), {
        requestBytes: 0, responseBytes: 0,
      });
    } catch (err) {
      const res = googleError(500, "internalError", `fake-google internal: ${err instanceof Error ? err.message : String(err)}`);
      record(req, rule, ctx, res.status, 0, 0);
      return res;
    }
  }

  return {
    state,
    log,
    handle: (request: Request) => handle(request),
    requests: () => log.map((entry) => ({ ...entry, queryKeys: [...entry.queryKeys] })),
  };
}
