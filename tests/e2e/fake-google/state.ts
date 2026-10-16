/**
 * State and shared types for the fake Google boundary (T15).
 *
 * The fake keeps upstream Drive v3 semantics in-process: drives, files,
 * revisions, resumable upload sessions, permission/membership state and
 * issued OAuth/SA tokens. Nothing here is reachable from production code —
 * it is only ever bound as Miniflare's `outboundService` or contacted on a
 * loopback control port by the Playwright runner.
 */

export type FakeProvider = "oauth" | "service_account" | "none";

/** One recorded upstream-bound request. Tokens are never logged. */
export interface FakeRequestLogEntry {
  seq: number;
  at: string;
  host: string;
  method: string;
  /** Pathname only — query values may carry user content. */
  path: string;
  /** Query parameter names only (e.g. ['alt','supportsAllDrives']). */
  queryKeys: string[];
  /** Classified operation, e.g. 'files.list' or 'token:refresh_token'. */
  operation: string;
  provider: FakeProvider;
  /** Drive principal id (OAuth permissionId) or SA email; null if none. */
  principal: string | null;
  status: number;
  requestBytes: number;
  responseBytes: number;
  /** sha256 hex of the request body, present only for upload bodies. */
  requestSha256?: string;
  /** Set when the token's provider is not allowed on this surface. */
  providerViolation?: string;
}

export interface FakeDrive {
  id: string;
  name: string;
}

export interface FakeRevision {
  id: string;
  mimeType: string;
  modifiedTime: string;
  size: string;
  keepForever: boolean;
  content: Uint8Array;
}

export interface FakeFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  /** Owning Shared Drive id (the root folder's driveId is itself). */
  driveId: string;
  trashed: boolean;
  headRevisionId?: string;
  md5Checksum?: string;
  sha256Checksum?: string;
  resourceKey?: string;
  thumbnailLink?: string;
  /** null for folders and files whose bytes have not been uploaded. */
  content: Uint8Array | null;
  /** Workspace docs exportable via /export (e.g. to PDF). */
  exportable: boolean;
  /** File-level download restriction (capabilities.canDownload). */
  canDownload: boolean;
  revisions: FakeRevision[];
  thumbnailContent?: Uint8Array;
  createdTime: string;
  modifiedTime: string;
}

export interface FakeUploadSession {
  uploadId: string;
  fileId: string;
  name: string;
  mimeType: string;
  parents: string[];
  driveId: string;
  /** Declared total from X-Upload-Content-Length / Content-Range `*\/N`. */
  declaredTotal?: bigint;
  contentType: string;
  /** Bytes confirmed contiguously from offset 0. */
  confirmed: Uint8Array;
  /** Out-of-order received fragments keyed by start offset. */
  pending: Map<number, Uint8Array>;
  expiresAtMs: number;
  finalized: boolean;
}

export interface FakeAccessToken {
  value: string;
  provider: Exclude<FakeProvider, "none">;
  /** OAuth: permissionId. SA: client email. */
  principal: string;
  scopes: string[];
  expiresAtMs: number;
  revoked: boolean;
}

export interface FakeRefreshGrant {
  token: string;
  provider: "oauth";
  clientId: string;
  principal: string;
  scopes: string[];
  revoked: boolean;
}

export interface FakeAuthCode {
  code: string;
  clientId: string;
  /** permissionId the exchanged tokens will resolve to. */
  principal: string;
  scopes: string[];
  used: boolean;
}

export interface FakeServiceAccount {
  email: string;
  projectId: string;
  /** SPKI PEM used to verify RS256 JWT assertions (Google does verify). */
  publicKeyPem: string;
  enabled: boolean;
}

export type DriveRole = "reader" | "writer" | "organizer";

export interface FakeState {
  drives: Map<string, FakeDrive>;
  files: Map<string, FakeFile>;
  uploadSessions: Map<string, FakeUploadSession>;
  accessTokens: Map<string, FakeAccessToken>;
  refreshTokens: Map<string, FakeRefreshGrant>;
  authCodes: Map<string, FakeAuthCode>;
  serviceAccounts: Map<string, FakeServiceAccount>;
  /**
   * driveId -> principal (permissionId or SA email) -> role.
   * Only members may see/read/write inside the drive; exactly like Google,
   * non-members get 404 rather than an existence leak.
   */
  members: Map<string, Map<string, DriveRole>>;
}

export function createFakeState(): FakeState {
  return {
    drives: new Map(),
    files: new Map(),
    uploadSessions: new Map(),
    accessTokens: new Map(),
    refreshTokens: new Map(),
    authCodes: new Map(),
    serviceAccounts: new Map(),
    members: new Map(),
  };
}
