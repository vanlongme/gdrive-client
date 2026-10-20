/**
 * Internal Google Drive contracts shared by the transport, the two providers
 * and the coordinator's token issuance (wave 2 track B / T04).
 *
 * Server-only surface: these types carry credential IDs, Google principals and
 * bearer-token plumbing and must never appear in public DTOs (spec §10.2).
 * Token acquisition, refresh and ProjectCoordinator admission are owned by
 * track C — providers here only consume the injected `CoordinatorTokenSource`
 * and never store or refresh tokens themselves (wave-2 contract §3; frozen
 * interface decision in docs/tasks/wave-2.md).
 */

import type { DecimalBytes } from '../../shared/contracts/common';
import type { MountScope } from './containment';

// ---------------------------------------------------------------------------
// Identities
// ---------------------------------------------------------------------------

/**
 * OAuth writer identity pinned to an upload operation (spec §5.3). Every
 * Drive write names exactly this tuple; a reconnect under a different
 * principal or client creates a new connection and never replaces a pinned
 * writer on a running upload. This exact shape is a coordinator-frozen
 * contract shared with C and the D1 tombstone columns.
 */
export interface PinnedWriter {
  readonly connectionId: string;
  readonly principalId: string;
  readonly oauthClientId: string;
  readonly projectId: string;
}

/**
 * Pinned writer plus the credential versions observed when the writer was
 * resolved (wave-2 frozen interface: identity inputs carry required
 * versions; the coordinator re-verifies them against current D1 state on
 * every admission). Version staleness surfaces as
 * `CREDENTIAL_VERSION_CHANGED`; the caller re-resolves and retries.
 */
export interface ResolvedWriter extends PinnedWriter {
  readonly connectionVersion: number;
  readonly oauthClientVersion: number;
}

/**
 * Server-internal Drive file reference (plan T02). `id` is the Drive file ID;
 * `resourceKey` is required by Google to address some shared resources and is
 * forwarded via `X-Goog-Drive-Resource-Keys`. Never part of public DTOs.
 */
export interface DriveResourceRef {
  readonly id: string;
  readonly resourceKey?: string;
}

/**
 * Selected service-account read identity for one content request (spec §5.4).
 * Chosen by the caller from the mount read pool after admission; providers
 * only translate it into a token request — they never pick an SA themselves.
 * `email` is the stable SA principal (spec §5.3); `serviceAccountVersion` is
 * the credential row version observed at selection time.
 */
export interface ReadIdentity {
  readonly serviceAccountId: string;
  readonly serviceAccountVersion: number;
  readonly email: string;
  readonly projectId: string;
}

export type DriveProviderKind = 'google_oauth' | 'service_account';

// ---------------------------------------------------------------------------
// Token source — frozen interface owned by B, implemented by C
// (coordinator decision, docs/tasks/wave-2.md "Frozen internal interfaces")
// ---------------------------------------------------------------------------

export const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
export const GOOGLE_DRIVE_READONLY_SCOPE =
  'https://www.googleapis.com/auth/drive.readonly';

/** The only scope set the SA read provider is allowed to request. */
export const SA_READ_SCOPES: readonly string[] = [GOOGLE_DRIVE_READONLY_SCOPE];

/** Operator connection scopes for catalog + writes (spec §5.2). */
export const OAUTH_CATALOG_WRITE_SCOPES: readonly string[] = [GOOGLE_DRIVE_SCOPE];

/**
 * Input to token issuance — the identity the coordinator keys on (spec §5.4).
 * Discriminated by provider so a token can never be shared across providers.
 * All fields are references the coordinator re-validates against current D1
 * state on every admission; caller input is not authority.
 */
export type TokenIdentity = {
  /** service_accounts.id or google_connections.id. */
  readonly credentialId: string;
  /** Credential row version the caller resolved; staleness → version error. */
  readonly credentialVersion: number;
  readonly projectId: string;
  /** Drive permissionId (OAuth) or SA email (service_account). */
  readonly principalId: string;
  /** Normalized (sorted, deduplicated) scope list. */
  readonly scopes: readonly string[];
} & (
  | {
      readonly provider: 'google_oauth';
      /** google_oauth_clients.id */
      readonly oauthClientId: string;
      readonly oauthClientVersion: number;
    }
  | { readonly provider: 'service_account' }
);

/**
 * Token issuance result. Failure codes are the admission vocabulary the
 * coordinator owns; providers translate them into DriveError (errors.ts)
 * and never retry an operation on a different identity — file limits in
 * particular must never trigger alternate-identity retry (spec §5.4).
 */
export type TokenResult =
  | { readonly ok: true; readonly accessToken: string; readonly expiresAtMs: number }
  | {
      readonly ok: false;
      readonly code:
        | 'CREDENTIAL_DISABLED'
        | 'CREDENTIAL_VERSION_CHANGED'
        | 'OAUTH_NEEDS_REAUTH'
        | 'UPSTREAM_AUTH_FAILED'
        | 'UPSTREAM_UNAVAILABLE'
        | 'COOLDOWN';
      readonly retryAfterMs?: number;
    };

/** Failure classes providers report back for health/cooldown accounting. */
export type TokenFailureKind =
  | 'rate_limit'
  | 'upstream_5xx'
  | 'auth'
  | 'file_limited';

/**
 * Admission options (coordinator-approved extension): `fileId` names the
 * file so file-scoped cooldowns apply to this admission.
 */
export interface GetTokenOptions {
  readonly fileId?: string;
}

export interface CoordinatorTokenSource {
  getToken(
    identity: TokenIdentity,
    options?: GetTokenOptions,
  ): Promise<TokenResult>;
  reportFailure(
    identity: TokenIdentity,
    info: {
      kind: TokenFailureKind;
      retryAfterMs?: number;
      /** File-scoped cooldowns (download-abuse limits) carry the file id. */
      fileId?: string;
    },
  ): Promise<void>;
}

/** Build the OAuth identity for a resolved writer (catalog + writes). */
export function oauthTokenIdentity(writer: ResolvedWriter): TokenIdentity {
  return {
    provider: 'google_oauth',
    credentialId: writer.connectionId,
    credentialVersion: writer.connectionVersion,
    oauthClientId: writer.oauthClientId,
    oauthClientVersion: writer.oauthClientVersion,
    principalId: writer.principalId,
    projectId: writer.projectId,
    scopes: OAUTH_CATALOG_WRITE_SCOPES,
  };
}

/** Build the SA identity for a selected read credential (drive.readonly). */
export function saTokenIdentity(identity: ReadIdentity): TokenIdentity {
  return {
    provider: 'service_account',
    credentialId: identity.serviceAccountId,
    credentialVersion: identity.serviceAccountVersion,
    principalId: identity.email,
    projectId: identity.projectId,
    scopes: SA_READ_SCOPES,
  };
}

/**
 * Canonical single-flight key for token issuance (spec §5.4): provider,
 * credential ID + version, OAuth client ID + version when present, principal,
 * project and normalized scopes. Serialized as a JSON tuple so no field can
 * smuggle separators; scopes are trimmed, deduplicated and sorted.
 */
export function tokenIdentityKey(identity: TokenIdentity): string {
  const scopes = Array.from(
    new Set(
      identity.scopes.map((scope) => scope.trim()).filter((s) => s !== ''),
    ),
  ).sort();
  const tuple: readonly unknown[] =
    identity.provider === 'google_oauth'
      ? [
          identity.provider,
          identity.credentialId,
          identity.credentialVersion,
          identity.oauthClientId,
          identity.oauthClientVersion,
          identity.principalId,
          identity.projectId,
          scopes,
        ]
      : [
          identity.provider,
          identity.credentialId,
          identity.credentialVersion,
          identity.principalId,
          identity.projectId,
          scopes,
        ];
  return JSON.stringify(tuple);
}

// ---------------------------------------------------------------------------
// Shared value objects returned by providers
// ---------------------------------------------------------------------------

/**
 * Drive file metadata as the Worker consumes it. `size` stays a decimal
 * string (folders and Google-native docs may carry no size). Capability
 * flags are advisory signals only: OAuth capabilities never imply SA read
 * access and vice versa (spec §5.4, §9.4).
 */
export interface DriveFileMeta {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size?: DecimalBytes;
  readonly modifiedTime?: string;
  readonly trashed?: boolean;
  readonly parents?: readonly string[];
  readonly driveId?: string;
  /** True when the requesting principal owns the file (My Drive mounts). */
  readonly ownedByMe?: boolean;
  readonly headRevisionId?: string;
  readonly md5Checksum?: string;
  readonly sha256Checksum?: string;
  readonly resourceKey?: string;
  readonly hasThumbnail: boolean;
  /** SA-observed thumbnail URL when the file has one (server-internal). */
  readonly thumbnailLink?: string;
  /**
   * Present when mimeType is the shortcut MIME: the target's Drive file ID,
   * its MIME type and the resource key Google may require to address it
   * (shortcutDetails.targetResourceKey). Resolution stays server-side; the
   * target is never followed outside the mount's scope (spec §9).
   */
  readonly shortcutTargetId?: string;
  readonly shortcutTargetMimeType?: string;
  readonly shortcutTargetResourceKey?: string;
  readonly capabilities?: {
    readonly canDownload?: boolean;
    readonly canAddChildren?: boolean;
    readonly canTrash?: boolean;
    readonly canReadRevisions?: boolean;
  };
}

export type CatalogEntryKind = 'file' | 'folder' | 'shortcut';

/** One row of a catalog listing/search page (internal; DTO mapping is T05). */
export interface CatalogEntry {
  readonly id: string;
  readonly kind: CatalogEntryKind;
  readonly name: string;
  readonly mimeType: string;
  readonly size: DecimalBytes;
  readonly modifiedTime?: string;
  readonly shortcutTargetId?: string;
  /** Resource key Google may require to address the shortcut target. */
  readonly shortcutTargetResourceKey?: string;
  readonly resourceKey?: string;
  /** Parent folder ids as listed (My Drive: at most one). Containment input only; never in a DTO. */
  readonly parents?: readonly string[];
  readonly hasThumbnail: boolean;
  // Cache-fill fields (wave 10): requested in the listing fields so an
  // OAuth page can populate file_metadata_cache. Never in public DTOs.
  readonly trashed?: boolean;
  readonly driveId?: string;
  readonly md5Checksum?: string;
  readonly headRevisionId?: string;
  /** Legacy "viewers cannot download" flag (owner's view; reader verdict). */
  readonly copyRequiresWriterPermission?: boolean;
  /** Effective reader/writer download restriction (item + context). */
  readonly downloadRestrictions?: {
    readonly restrictedForReaders?: boolean;
    readonly restrictedForWriters?: boolean;
  };
}

export interface CatalogPage {
  readonly entries: readonly CatalogEntry[];
  /** Raw Google page token; the signed public cursor is built in T05. */
  readonly nextPageToken?: string;
}

/** Revision metadata relevant to pinned-content mode (spec §7.3). */
export interface DriveRevisionMeta {
  readonly id: string;
  readonly size?: DecimalBytes;
  readonly mimeType?: string;
  readonly modifiedTime?: string;
  readonly keepForever: boolean;
}

/**
 * Successful binary response from Google, ready for pass-through streaming.
 * The body is unconsumed; the caller owns cancellation, which must abort the
 * upstream connection. Headers are verbatim upstream values — a 206 always
 * carries `contentRange`; the route layer decides what to emit downstream
 * (spec §7.2).
 */
export interface UpstreamContent {
  readonly status: 200 | 206;
  readonly contentType?: string;
  readonly contentLength?: bigint;
  /** Raw `Content-Range` value on 206 responses, format-checked. */
  readonly contentRange?: string;
  readonly etag?: string;
  readonly lastModified?: string;
  readonly body: ReadableStream<Uint8Array>;
}

// ---------------------------------------------------------------------------
// Provider inputs
// ---------------------------------------------------------------------------

export interface ProviderRequestContext {
  /** Cancellation propagated to the upstream fetch. */
  readonly signal?: AbortSignal;
}

export interface ListChildrenInput extends ProviderRequestContext {
  readonly writer: ResolvedWriter;
  /** Shared Drive scope lists with corpora=drive, My Drive scope with corpora=user. */
  readonly scope: MountScope;
  readonly parentFolderId: string;
  readonly pageToken?: string;
  readonly pageSize?: number;
}

export interface SearchFilesInput extends ProviderRequestContext {
  readonly writer: ResolvedWriter;
  readonly scope: MountScope;
  /** Raw user query text; the provider escapes it into the Drive `q` term. */
  readonly query: string;
  /**
   * 'folder' searches the direct children of `folderId`; 'drive' searches
   * the whole corpus (for My Drive the caller filters hits by containment).
   */
  readonly searchScope: 'folder' | 'drive';
  /** Required when searchScope is 'folder' (direct children of one folder). */
  readonly folderId?: string;
  readonly pageToken?: string;
  readonly pageSize?: number;
}

export interface GetMetadataInput extends ProviderRequestContext {
  readonly writer: ResolvedWriter;
  readonly ref: DriveResourceRef;
}

export interface GenerateIdInput extends ProviderRequestContext {
  readonly writer: ResolvedWriter;
}

export interface CreateFolderInput extends ProviderRequestContext {
  readonly writer: ResolvedWriter;
  readonly parentFolderId: string;
  readonly name: string;
  /** Pre-generated Drive file ID (files.generateIds) pinned to this create. */
  readonly generatedId: string;
}

/**
 * Upload initiation (spec §6.2): `generatedFileId` comes from files.generateIds
 * before any remote call and is embedded in the create so retries do not
 * duplicate files. `totalBytes` as bigint; 0n selects the metadata-only
 * create branch inside the adapter.
 */
export interface StartUploadInput extends ProviderRequestContext {
  readonly writer: ResolvedWriter;
  readonly parentFolderId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly totalBytes: bigint;
  readonly generatedFileId: string;
}

export type UploadStart =
  /** Resumable session initiated; `sessionUri` is a validated Google URI. */
  | {
      readonly kind: 'resumable';
      readonly sessionUri: string;
      readonly generatedFileId: string;
    }
  /** Zero-byte file created metadata-only; no remote session exists. */
  | { readonly kind: 'created-empty'; readonly file: DriveFileMeta };

/**
 * One resumable chunk PUT. `offset` is the confirmed position; the body must
 * produce exactly `chunkBytes` bytes — the transport enforces the length via
 * FixedLengthStream and never buffers it (spec §6.3). The provider converts
 * upstream 308/Range into `confirmedOffset` and 200/201 into `completed`.
 */
export interface PutChunkInput extends ProviderRequestContext {
  readonly writer: ResolvedWriter;
  readonly sessionUri: string;
  readonly offset: bigint;
  readonly chunkBytes: number;
  readonly totalBytes: bigint;
  readonly body: ReadableStream<Uint8Array>;
}

export interface ProbeUploadInput extends ProviderRequestContext {
  readonly writer: ResolvedWriter;
  readonly sessionUri: string;
  readonly totalBytes: bigint;
}

export type UploadProgressResult =
  | { readonly kind: 'incomplete'; readonly confirmedOffset: bigint }
  | { readonly kind: 'completed'; readonly file: DriveFileMeta };

export interface VerifyFileInput extends ProviderRequestContext {
  readonly writer: ResolvedWriter;
  readonly ref: DriveResourceRef;
}

export interface TrashFileInput extends ProviderRequestContext {
  readonly writer: ResolvedWriter;
  readonly ref: DriveResourceRef;
}

// SA read-side inputs

export interface ReadMetadataInput extends ProviderRequestContext {
  readonly identity: ReadIdentity;
  readonly ref: DriveResourceRef;
}

export interface GetRevisionInput extends ProviderRequestContext {
  readonly identity: ReadIdentity;
  readonly ref: DriveResourceRef;
  readonly revisionId: string;
}

/** Inclusive byte range for a single-range content request. */
export interface ByteRange {
  readonly start: bigint;
  readonly end: bigint;
}

export interface OpenContentInput extends ProviderRequestContext {
  readonly identity: ReadIdentity;
  readonly ref: DriveResourceRef;
  /** Optional single range; absent means the full representation. */
  readonly range?: ByteRange;
  /** Present for pinned-revision reads (spec §7.3); never falls back to head. */
  readonly revisionId?: string;
  /**
   * True when the admission metadata this open relies on came from the
   * metadata cache rather than a live SA files.get (wave-10 review M2): a
   * file-scoped denial may only prove the cached verdict stale, so the
   * 'file_limited' cooldown report is suppressed — the route re-verifies
   * live and answers exactly what the live path returns. Rate-limit
   * reports are unaffected.
   */
  readonly metaFromCache?: boolean;
}

export interface OpenThumbnailInput extends ProviderRequestContext {
  readonly identity: ReadIdentity;
  readonly ref: DriveResourceRef;
  /**
   * The thumbnailLink already returned by the admission metadata (wave-9
   * step 2c): a string skips the second files.get entirely; `null` means
   * "known absent" and fails not-found without an upstream call; `undefined`
   * preserves the legacy files.get fallback, which also re-proves
   * capabilities(canDownload) before trusting the link (wave-10 review M3).
   */
  readonly thumbnailLink?: string | null;
  /** Same semantics as OpenContentInput.metaFromCache. */
  readonly metaFromCache?: boolean;
}

/** Workspace export formats the read provider may request (spec §7.1). */
export const EXPORT_FORMATS = ['pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportDocumentInput extends ProviderRequestContext {
  readonly identity: ReadIdentity;
  readonly ref: DriveResourceRef;
  readonly format: ExportFormat;
  /** Same semantics as OpenContentInput.metaFromCache. */
  readonly metaFromCache?: boolean;
}

// ---------------------------------------------------------------------------
// Provider interfaces
// ---------------------------------------------------------------------------

/**
 * Operator OAuth catalog/write provider. Every method resolves the token for
 * exactly the pinned/declared writer; the same connection never substitutes
 * for another identity and nothing here can serve user content bytes
 * (spec §5.1, §7.1).
 */
export interface OAuthCatalogWriteProvider {
  listChildren(input: ListChildrenInput): Promise<CatalogPage>;
  search(input: SearchFilesInput): Promise<CatalogPage>;
  getMetadata(input: GetMetadataInput): Promise<DriveFileMeta>;
  generateId(input: GenerateIdInput): Promise<string>;
  createFolder(input: CreateFolderInput): Promise<DriveFileMeta>;
  startUpload(input: StartUploadInput): Promise<UploadStart>;
  putChunk(input: PutChunkInput): Promise<UploadProgressResult>;
  probeUpload(input: ProbeUploadInput): Promise<UploadProgressResult>;
  verifyFile(input: VerifyFileInput): Promise<DriveFileMeta>;
  trashFile(input: TrashFileInput): Promise<void>;
}

/**
 * Service-account content read provider (spec §5.1). Allowlisted read
 * operations only — the interface has no write methods and its transport
 * cannot express a Drive mutation at all.
 */
export interface ServiceAccountContentReadProvider {
  getReadMetadata(input: ReadMetadataInput): Promise<DriveFileMeta>;
  getRevision(input: GetRevisionInput): Promise<DriveRevisionMeta>;
  openContent(input: OpenContentInput): Promise<UpstreamContent>;
  openThumbnail(input: OpenThumbnailInput): Promise<UpstreamContent>;
  exportDocument(input: ExportDocumentInput): Promise<UpstreamContent>;
}
