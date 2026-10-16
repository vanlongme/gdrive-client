/**
 * Durable media-package index (architecture §8.2, plan T13; wave-4 D).
 *
 * A package is the canonical-path -> Drive-file mapping for one HLS entry
 * playlist. The scan is durable and bounded per advance call:
 *
 *   - media_package_resources rows double as the work queue: a row with
 *     file_id = '' is a reference waiting to be resolved by Drive-folder
 *     name (OAuth catalog only); a resolved 'playlist' row whose file_id
 *     has no version entry in media_packages.dependency_versions is a
 *     playlist waiting to be fetched (SA bytes) and parsed.
 *   - media_packages.scan_cursor carries the small scan state (phase,
 *     package root folder, pending playlist depths); every mutation batch
 *     is guarded by scan_cursor_version + index_generation + state so a
 *     stale or concurrent advance can never mix generations.
 *   - Publication is a single guarded UPDATE: it only fires when no
 *     unresolved row and no unparsed playlist remains, then flips
 *     ready_generation atomically.
 *   - Dependency versions are recorded for every parsed playlist; a ready
 *     package re-verifies them on advance (bounded) and any mismatch — or
 *     a version change observed while serving a resource — restarts a
 *     fresh generation instead of mutating a published one.
 */

import type { MountRecord } from '../drive/mounts';
import type { MountAccess } from '../auth/grants';
import type {
  CatalogEntry,
  OAuthCatalogWriteProvider,
  ResolvedWriter,
  ServiceAccountContentReadProvider,
} from '../drive/types';
import { DriveError } from '../drive/errors';
import { ApiRequestError } from '../drive/mounts';
import { FOLDER_MIME_TYPE, SHORTCUT_MIME_TYPE } from '../drive/providers/common';
import { resolveResource } from '../drive/shortcuts';
import {
  openWithFailover,
  verifiedFileForRead,
} from '../transfers/content-access';
import {
  HLS_MAX_PLAYLIST_DEPTH,
  HLS_MAX_PLAYLIST_BYTES,
  HLS_MAX_REFERENCES,
  HlsPlaylistError,
  parseHlsPlaylist,
} from './hls-parser';

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Work units per advance call: one unit = one playlist parse or one ref resolution. */
export const HLS_ADVANCE_WORK_BUDGET = 16;
/** Folder-listing pages per single name lookup during path resolution. */
export const HLS_MAX_FOLDER_PAGES = 20;
/** Cap on the serialized scan cursor; hostile graphs fail 'oversize'. */
export const HLS_MAX_CURSOR_BYTES = 768 * 1024;

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type MediaPackageState = 'preparing' | 'ready' | 'failed';
export type MediaResourceKind =
  | 'playlist'
  | 'segment'
  | 'init'
  | 'audio'
  | 'subtitle'
  | 'resource';

export interface MediaPackageRow {
  readonly id: string;
  readonly mountId: string;
  readonly entryFileId: string;
  readonly createdBy: string;
  readonly state: MediaPackageState;
  readonly indexGeneration: number;
  readonly readyGeneration: number | null;
  readonly scanCursor: string | null;
  readonly scanCursorVersion: number;
  readonly dependencyVersions: string;
  readonly strictSnapshot: boolean;
  readonly failureReason: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface MediaPackageResourceRow {
  readonly packageId: string;
  readonly indexGeneration: number;
  readonly resourceId: string;
  readonly path: string;
  readonly fileId: string;
  readonly revisionId: string | null;
  readonly kind: MediaResourceKind;
  readonly byteLength: string | null;
  readonly createdAt: number;
}

interface PackageSqlRow {
  id: string;
  mount_id: string;
  entry_file_id: string;
  created_by: string;
  state: string;
  index_generation: number;
  ready_generation: number | null;
  scan_cursor: string | null;
  scan_cursor_version: number;
  dependency_versions: string;
  strict_snapshot: number;
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
}

function toPackageRow(r: PackageSqlRow): MediaPackageRow {
  return {
    id: r.id,
    mountId: r.mount_id,
    entryFileId: r.entry_file_id,
    createdBy: r.created_by,
    state: r.state as MediaPackageState,
    indexGeneration: r.index_generation,
    readyGeneration: r.ready_generation,
    scanCursor: r.scan_cursor,
    scanCursorVersion: r.scan_cursor_version,
    dependencyVersions: r.dependency_versions,
    strictSnapshot: r.strict_snapshot === 1,
    failureReason: r.failure_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

const PACKAGE_COLUMNS =
  'id, mount_id, entry_file_id, created_by, state, index_generation, ' +
  'ready_generation, scan_cursor, scan_cursor_version, dependency_versions, ' +
  'strict_snapshot, failure_reason, created_at, updated_at';

export async function getMediaPackage(
  db: D1Database,
  packageId: string,
): Promise<MediaPackageRow | null> {
  const row = await db
    .prepare(`SELECT ${PACKAGE_COLUMNS} FROM media_packages WHERE id = ?`)
    .bind(packageId)
    .first<PackageSqlRow>();
  return row === null ? null : toPackageRow(row);
}

export async function findMediaPackageByEntry(
  db: D1Database,
  mountId: string,
  entryFileId: string,
): Promise<MediaPackageRow | null> {
  const row = await db
    .prepare(
      `SELECT ${PACKAGE_COLUMNS} FROM media_packages WHERE mount_id = ? AND entry_file_id = ?`,
    )
    .bind(mountId, entryFileId)
    .first<PackageSqlRow>();
  return row === null ? null : toPackageRow(row);
}

interface ResourceSqlRow {
  package_id: string;
  index_generation: number;
  resource_id: string;
  path: string;
  file_id: string;
  revision_id: string | null;
  kind: string;
  byte_length: string | null;
  created_at: number;
}

function toResourceRow(r: ResourceSqlRow): MediaPackageResourceRow {
  return {
    packageId: r.package_id,
    indexGeneration: r.index_generation,
    resourceId: r.resource_id,
    path: r.path,
    fileId: r.file_id,
    revisionId: r.revision_id,
    kind: r.kind as MediaResourceKind,
    byteLength: r.byte_length,
    createdAt: r.created_at,
  };
}

export async function getPackageResource(
  db: D1Database,
  packageId: string,
  generation: number,
  resourceId: string,
): Promise<MediaPackageResourceRow | null> {
  const row = await db
    .prepare(
      'SELECT package_id, index_generation, resource_id, path, file_id, ' +
        'revision_id, kind, byte_length, created_at ' +
        'FROM media_package_resources ' +
        'WHERE package_id = ? AND index_generation = ? AND resource_id = ?',
    )
    .bind(packageId, generation, resourceId)
    .first<ResourceSqlRow>();
  return row === null ? null : toResourceRow(row);
}

/** path -> resource map for one generation (URI rewrite table). */
export async function listGenerationResources(
  db: D1Database,
  packageId: string,
  generation: number,
): Promise<MediaPackageResourceRow[]> {
  const rows = await db
    .prepare(
      'SELECT package_id, index_generation, resource_id, path, file_id, ' +
        'revision_id, kind, byte_length, created_at ' +
        'FROM media_package_resources ' +
        'WHERE package_id = ? AND index_generation = ? ORDER BY path',
    )
    .bind(packageId, generation)
    .all<ResourceSqlRow>();
  return (rows.results ?? []).map(toResourceRow);
}

// ---------------------------------------------------------------------------
// Errors surfaced as package failures. These are permanent for the current
// generation: the package row transitions to 'failed' with a bounded reason.
// ---------------------------------------------------------------------------

export class PackageIndexError extends Error {
  readonly code:
    | 'ambiguous'
    | 'not-found'
    | 'scope'
    | 'oversize'
    | 'cycle'
    | 'internal';

  constructor(code: PackageIndexError['code'], message: string) {
    super(`hls-index:${code}:${message}`);
    this.name = 'PackageIndexError';
    this.code = code;
  }
}

export function isPackageIndexError(err: unknown): err is PackageIndexError {
  return err instanceof PackageIndexError;
}

/**
 * A DriveError attributed to a specific provider so the route layer can
 * keep the public error taxonomy provider-accurate (SA pool failures are
 * never reported as OAuth catalog failures and vice versa).
 */
export class PackageProviderError extends Error {
  readonly provider: 'google_oauth' | 'service_account';
  readonly driveError: DriveError;
  constructor(provider: 'google_oauth' | 'service_account', err: DriveError) {
    super(err.message, { cause: err });
    this.name = 'PackageProviderError';
    this.provider = provider;
    this.driveError = err;
  }
}

/** DriveError reasons that are permanent for the current generation. */
const PERMANENT_DRIVE_REASONS = new Set([
  'not-found',
  'gone',
  'permission-denied',
  'download-restricted',
]);

function permanentIndexError(
  reason: string,
  context: string,
): PackageIndexError | null {
  if (reason === 'not-found' || reason === 'gone') {
    return new PackageIndexError('not-found', `${context} is gone upstream`);
  }
  if (reason === 'permission-denied' || reason === 'download-restricted') {
    return new PackageIndexError('scope', `${context} is not readable`);
  }
  return null;
}

/**
 * Classify an error thrown by an upstream read during indexing: permanent
 * reasons become PackageIndexError (the generation fails), transient SA
 * failures are rethrown attributed to the service-account provider.
 */
function classifyIndexReadError(err: unknown, context: string): never {
  if (err instanceof ApiRequestError) {
    // checkFileMeta scope verdicts are permanent for the generation.
    throw new PackageIndexError('scope', `${context} is outside the mount scope`);
  }
  if (err instanceof DriveError) {
    const permanent = permanentIndexError(err.reason, context);
    if (permanent !== null) throw permanent;
    throw new PackageProviderError('service_account', err);
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Scan cursor. The heavy work queues live in media_package_resources rows;
// the cursor only carries what cannot be derived from rows: the package root
// folder and the graph depth of pending playlist references.
// ---------------------------------------------------------------------------

interface ScanCursorScan {
  readonly v: 1;
  readonly phase: 'scan';
  /** Drive folder id that canonical package paths resolve against. */
  readonly root: string;
  /** Canonical path -> graph depth for playlist refs not yet resolved. */
  readonly pd: Record<string, number>;
}

interface ScanCursorVerify {
  readonly v: 1;
  readonly phase: 'verify';
  /** Dependency fileIds already verified this pass. */
  readonly done: string[];
}

type ScanCursor = ScanCursorScan | ScanCursorVerify;

function parseCursor(raw: string | null): ScanCursor {
  if (raw === null) {
    throw new PackageIndexError('internal', 'missing scan cursor');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PackageIndexError('internal', 'corrupt scan cursor');
  }
  const c = parsed as {
    v?: unknown;
    phase?: unknown;
    root?: unknown;
    pd?: unknown;
    done?: unknown;
  };
  if (typeof c !== 'object' || c === null || c.v !== 1) {
    throw new PackageIndexError('internal', 'unsupported scan cursor');
  }
  if (
    c.phase === 'scan' &&
    typeof c.root === 'string' &&
    typeof c.pd === 'object' &&
    c.pd !== null
  ) {
    return { v: 1, phase: 'scan', root: c.root, pd: { ...(c.pd as Record<string, number>) } };
  }
  if (c.phase === 'verify' && Array.isArray(c.done)) {
    return { v: 1, phase: 'verify', done: c.done.filter((d): d is string => typeof d === 'string') };
  }
  throw new PackageIndexError('internal', 'malformed scan cursor');
}

/** dependency_versions JSON: fileId -> {d: graph depth, v?: version marker}. */
interface DependencyEntry {
  readonly d: number;
  readonly v?: string;
}
type DependencyMap = Record<string, DependencyEntry>;

function parseDependencies(raw: string): DependencyMap {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const out: DependencyMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue;
      const v = value as { d?: unknown; v?: unknown };
      if (typeof v.d !== 'number' || !Number.isInteger(v.d)) continue;
      out[key] = {
        d: v.d,
        ...(typeof v.v === 'string' ? { v: v.v } : {}),
      };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Version marker for change detection (best-effort for mutable files,
 * spec §8.2). A real head revision id outranks a modified-time fallback;
 * '' means no version was observable — later reads can only compare when
 * both sides expose a marker.
 */
export function hlsVersionMarker(meta: {
  headRevisionId?: string;
  modifiedTime?: string;
}): string {
  if (meta.headRevisionId !== undefined && meta.headRevisionId !== '') {
    return `rev:${meta.headRevisionId}`;
  }
  if (meta.modifiedTime !== undefined && meta.modifiedTime !== '') {
    return `mtime:${meta.modifiedTime}`;
  }
  return '';
}

// ---------------------------------------------------------------------------
// Package creation
// ---------------------------------------------------------------------------

export interface CreatePackageInput {
  readonly mountId: string;
  /** Resolved (post-shortcut) entry playlist file id. */
  readonly entryFileId: string;
  /** Entry file name — canonical path of the entry playlist resource. */
  readonly entryName: string;
  /** Folder that contains the entry playlist (canonical root). */
  readonly rootFolderId: string;
  readonly createdBy: string;
  readonly now: number;
}

/**
 * Insert a new package seeded with its entry playlist row (resource 'r1').
 * Returns null when the (mount, entry) uniqueness raced an existing row —
 * the caller re-reads it and answers idempotently.
 */
export async function insertMediaPackage(
  db: D1Database,
  input: CreatePackageInput,
): Promise<MediaPackageRow | null> {
  const id = crypto.randomUUID();
  const cursor: ScanCursorScan = { v: 1, phase: 'scan', root: input.rootFolderId, pd: {} };
  const deps: DependencyMap = { [input.entryFileId]: { d: 1 } };
  const results = await db.batch([
    db
      .prepare(
        'INSERT OR IGNORE INTO media_packages ' +
          '(id, mount_id, entry_file_id, created_by, state, index_generation, ' +
          'ready_generation, scan_cursor, scan_cursor_version, dependency_versions, ' +
          'strict_snapshot, failure_reason, created_at, updated_at) ' +
          "VALUES (?, ?, ?, ?, 'preparing', 1, NULL, ?, 1, ?, 0, NULL, ?, ?)",
      )
      .bind(
        id,
        input.mountId,
        input.entryFileId,
        input.createdBy,
        JSON.stringify(cursor),
        JSON.stringify(deps),
        input.now,
        input.now,
      ),
    db
      .prepare(
        'INSERT INTO media_package_resources ' +
          '(package_id, index_generation, resource_id, path, file_id, ' +
          'revision_id, kind, byte_length, created_at) ' +
          'SELECT ?, ?, ?, ?, ?, NULL, ?, NULL, ? ' +
          'WHERE EXISTS (SELECT 1 FROM media_packages WHERE id = ?)',
      )
      .bind(id, 1, 'r1', input.entryName, input.entryFileId, 'playlist', input.now, id),
  ]);
  const inserted = results[0]?.meta.changes ?? 0;
  if (inserted === 0) return null;
  return getMediaPackage(db, id);
}

// ---------------------------------------------------------------------------
// Name resolution: canonical package path -> Drive file id via OAuth
// catalog children listings (never a name-bearing content read, never the
// SA provider — catalog identity decides catalog scope, spec §8.2).
// ---------------------------------------------------------------------------

interface ResolveContext {
  readonly db: D1Database;
  readonly oauth: OAuthCatalogWriteProvider;
  readonly mount: MountRecord;
  readonly access: MountAccess;
  readonly writer: ResolvedWriter;
  readonly signal?: AbortSignal;
  /** Per-call folder listing cache (bounded by folder count). */
  readonly children: Map<string, readonly CatalogEntry[]>;
}

async function listFolderChildren(
  ctx: ResolveContext,
  folderId: string,
): Promise<readonly CatalogEntry[]> {
  const cached = ctx.children.get(folderId);
  if (cached !== undefined) return cached;
  const all: CatalogEntry[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < HLS_MAX_FOLDER_PAGES; page++) {
    const result = await ctx.oauth.listChildren({
      writer: ctx.writer,
      driveId: ctx.mount.driveId,
      parentFolderId: folderId,
      ...(pageToken === undefined ? {} : { pageToken }),
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    all.push(...result.entries);
    if (result.nextPageToken === undefined) break;
    pageToken = result.nextPageToken;
  }
  if (ctx.children.size < 4096) {
    ctx.children.set(folderId, all);
  }
  return all;
}

export interface ResolvedPackagePath {
  readonly fileId: string;
  /** Version marker from catalog metadata (mtime-based). */
  readonly marker: string;
  readonly byteLength: string | null;
}

/**
 * Resolve a canonical package path to a Drive file. Intermediate segments
 * must resolve to folders; the leaf to a file. Every candidate that is a
 * shortcut hops through resolveResource (bounded, mount-scoped). Two
 * viable candidates for the same segment are an ambiguity error — never a
 * first-match pick.
 */
async function resolvePackagePath(
  ctx: ResolveContext,
  rootFolderId: string,
  path: string,
): Promise<ResolvedPackagePath> {
  const segments = path.split('/');
  let folderId = rootFolderId;
  for (let i = 0; i < segments.length; i++) {
    const name = segments[i] ?? '';
    const leaf = i === segments.length - 1;
    const children = await listFolderChildren(ctx, folderId);
    const matches = children.filter((e) => e.name === name);
    if (matches.length === 0) {
      throw new PackageIndexError('not-found', `no entry named '${name.slice(0, 80)}'`);
    }
    const viable: Array<{
      id: string;
      kind: 'file' | 'folder';
      entry: CatalogEntry;
      /** For shortcut hops: the resolved target's metadata (marker source). */
      meta?: { headRevisionId?: string; modifiedTime?: string; size?: string };
    }> = [];
    for (const match of matches) {
      if (match.kind === 'folder') {
        if (!leaf) viable.push({ id: match.id, kind: 'folder', entry: match });
        continue;
      }
      if (match.kind === 'shortcut') {
        const resolved = await resolveResource(
          {
            access: ctx.access,
            mount: ctx.mount,
            writer: ctx.writer,
            provider: ctx.oauth,
            ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
          },
          {
            id: match.id,
            ...(match.resourceKey === undefined ? {} : { resourceKey: match.resourceKey }),
          },
        );
        const targetKind =
          resolved.meta.mimeType === FOLDER_MIME_TYPE
            ? 'folder'
            : resolved.meta.mimeType === SHORTCUT_MIME_TYPE
              ? 'file' // resolveResource already hopped; this is defensive
              : 'file';
        if ((leaf && targetKind === 'file') || (!leaf && targetKind === 'folder')) {
          viable.push({ id: resolved.meta.id, kind: targetKind, entry: match, meta: resolved.meta });
        }
        continue;
      }
      if (leaf) viable.push({ id: match.id, kind: 'file', entry: match });
    }
    if (viable.length === 0) {
      throw new PackageIndexError(
        'not-found',
        `no ${leaf ? 'file' : 'folder'} named '${name.slice(0, 80)}'`,
      );
    }
    const distinct = new Set(viable.map((v) => v.id));
    if (distinct.size > 1) {
      throw new PackageIndexError('ambiguous', `duplicate name '${name.slice(0, 80)}'`);
    }
    const chosen = viable[0];
    if (chosen === undefined) {
      throw new PackageIndexError('internal', 'resolution produced no candidate');
    }
    if (!leaf) {
      folderId = chosen.id;
      continue;
    }
    // Shortcut hops take the marker from the TARGET's metadata — the
    // shortcut's own mtime never tracks target content (W4-R2 finding 5).
    return {
      fileId: chosen.id,
      marker:
        chosen.meta !== undefined
          ? hlsVersionMarker(chosen.meta)
          : hlsVersionMarker({ modifiedTime: chosen.entry.modifiedTime }),
      byteLength: chosen.meta?.size ?? chosen.entry.size,
    };
  }
  throw new PackageIndexError('internal', 'path resolution fell through');
}

// ---------------------------------------------------------------------------
// Playlist fetch through the SA read pool (every byte is SA, spec §8.2).
// ---------------------------------------------------------------------------

async function readPlaylistText(
  env: Env,
  ctx: ResolveContext,
  provider: ServiceAccountContentReadProvider,
  fileId: string,
): Promise<{ text: string; marker: string }> {
  const verified = await verifiedFileForRead(
    provider,
    env,
    ctx.mount,
    fileId,
    ctx.signal,
  ).catch((err: unknown) => classifyIndexReadError(err, 'playlist'));
  const declared = verified.meta.size;
  if (declared !== undefined && BigInt(declared) > BigInt(HLS_MAX_PLAYLIST_BYTES)) {
    throw new HlsPlaylistError('oversize', 'playlist exceeds 1 MiB');
  }
  const upstream = await openWithFailover(
    provider,
    ctx.mount,
    fileId,
    verified,
    ctx.signal,
    (identity, ref) =>
      provider.openContent({ identity, ref, ...(ctx.signal === undefined ? {} : { signal: ctx.signal }) }),
  ).catch((err: unknown) => classifyIndexReadError(err, 'playlist'));
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > HLS_MAX_PLAYLIST_BYTES) {
        throw new HlsPlaylistError('oversize', 'playlist exceeds 1 MiB');
      }
      chunks.push(value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* stream already finished or broken */
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(merged);
  } catch {
    throw new HlsPlaylistError('invalid', 'playlist is not valid UTF-8');
  }
  return { text, marker: hlsVersionMarker(verified.meta) };
}

// ---------------------------------------------------------------------------
// Advance: bounded work per call, every commit guarded by CAS.
// ---------------------------------------------------------------------------

export interface PackageIndexDeps {
  readonly env: Env;
  readonly oauthProvider: OAuthCatalogWriteProvider;
  readonly readProvider: ServiceAccountContentReadProvider;
  readonly writer: ResolvedWriter;
  readonly mount: MountRecord;
  readonly access: MountAccess;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
  readonly workBudget?: number;
}

export interface AdvanceOutcome {
  /** Fresh row state after this call. */
  readonly pkg: MediaPackageRow;
  /** Resources processed this call (parsed playlists + resolved refs). */
  readonly processedResources: number;
  /** Indexing finished and a ready generation is published. */
  readonly complete: boolean;
  /** True when a concurrent advance won the CAS; nothing was lost. */
  readonly stale: boolean;
}

const GUARD_PACKAGE =
  'EXISTS (SELECT 1 FROM media_packages WHERE id = ? AND ' +
  'scan_cursor_version = ? AND index_generation = ? AND state = ?)';

function resourceInsertStatement(
  db: D1Database,
  pkg: MediaPackageRow,
  resourceId: string,
  path: string,
  kind: MediaResourceKind,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      'INSERT OR IGNORE INTO media_package_resources ' +
        '(package_id, index_generation, resource_id, path, file_id, ' +
        'revision_id, kind, byte_length, created_at) ' +
        `SELECT ?, ?, ?, ?, '', NULL, ?, NULL, ? WHERE ${GUARD_PACKAGE}`,
    )
    .bind(
      pkg.id,
      pkg.indexGeneration,
      resourceId,
      path,
      kind,
      now,
      pkg.id,
      pkg.scanCursorVersion,
      pkg.indexGeneration,
      'preparing',
    );
}

function resourceResolveStatement(
  db: D1Database,
  pkg: MediaPackageRow,
  resourceId: string,
  fileId: string,
  marker: string,
  byteLength: string | null,
): D1PreparedStatement {
  return db
    .prepare(
      'UPDATE media_package_resources SET file_id = ?, revision_id = ?, ' +
        'byte_length = ? WHERE package_id = ? AND index_generation = ? AND ' +
        `resource_id = ? AND ${GUARD_PACKAGE}`,
    )
    .bind(
      fileId,
      marker === '' ? null : marker,
      byteLength,
      pkg.id,
      pkg.indexGeneration,
      resourceId,
      pkg.id,
      pkg.scanCursorVersion,
      pkg.indexGeneration,
      'preparing',
    );
}

function cursorCommitStatement(
  db: D1Database,
  pkg: MediaPackageRow,
  cursor: ScanCursor,
  deps: DependencyMap,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      'UPDATE media_packages SET scan_cursor = ?, scan_cursor_version = ?, ' +
        'dependency_versions = ?, updated_at = ? ' +
        'WHERE id = ? AND scan_cursor_version = ? AND index_generation = ? ' +
        "AND state = 'preparing'",
    )
    .bind(
      JSON.stringify(cursor),
      pkg.scanCursorVersion + 1,
      JSON.stringify(deps),
      now,
      pkg.id,
      pkg.scanCursorVersion,
      pkg.indexGeneration,
    );
}

function publishStatement(
  db: D1Database,
  pkg: MediaPackageRow,
  deps: DependencyMap,
  now: number,
): D1PreparedStatement {
  // Publication is atomic and conditional: it fires only while we still
  // hold the cursor version AND no unresolved row or unparsed playlist
  // exists in this generation. A concurrent writer's batch would either
  // land before (this guard fails -> we are stale) or after (their
  // version-V guards no-op) — never between our checks.
  return db
    .prepare(
      'UPDATE media_packages SET state = \'ready\', ready_generation = index_generation, ' +
        'scan_cursor = NULL, scan_cursor_version = ?, dependency_versions = ?, ' +
        'failure_reason = NULL, updated_at = ? ' +
        'WHERE id = ? AND scan_cursor_version = ? AND index_generation = ? ' +
        "AND state = 'preparing' " +
        'AND NOT EXISTS (SELECT 1 FROM media_package_resources r ' +
        'WHERE r.package_id = media_packages.id AND r.index_generation = media_packages.index_generation ' +
        "AND r.file_id = '') " +
        'AND NOT EXISTS (SELECT 1 FROM media_package_resources r ' +
        'WHERE r.package_id = media_packages.id AND r.index_generation = media_packages.index_generation ' +
        "AND r.kind = 'playlist' AND r.file_id <> '' " +
        'AND json_extract(media_packages.dependency_versions, ' +
        `'$."' || r.file_id || '".v') IS NULL)`,
    )
    .bind(
      pkg.scanCursorVersion + 1,
      JSON.stringify(deps),
      now,
      pkg.id,
      pkg.scanCursorVersion,
      pkg.indexGeneration,
    );
}

/**
 * The stable code persisted to media_packages.failure_reason — never
 * upstream-controlled text (W6-F finding 3): Drive filenames, playlist
 * detail and Google error messages stay out of the client DTO. Shape is
 * `hls:<reason>` / `hls-index:<code>` so clients can key on it; anything
 * unrecognized collapses to the internal code.
 */
export function packageFailureReason(err: unknown): string {
  if (err instanceof HlsPlaylistError) return `hls:${err.reason}`;
  if (err instanceof PackageIndexError) return `hls-index:${err.code}`;
  return 'hls-index:internal';
}

function failStatement(
  db: D1Database,
  pkg: MediaPackageRow,
  reason: string,
  now: number,
): D1PreparedStatement {
  return db
    .prepare(
      "UPDATE media_packages SET state = 'failed', failure_reason = ?, " +
        'scan_cursor_version = ?, updated_at = ? ' +
        'WHERE id = ? AND scan_cursor_version = ? AND index_generation = ? ' +
        "AND state = 'preparing'",
    )
    .bind(
      reason.slice(0, 300),
      pkg.scanCursorVersion + 1,
      now,
      pkg.id,
      pkg.scanCursorVersion,
      pkg.indexGeneration,
    );
}

interface PendingPlaylistRow {
  resource_id: string;
  file_id: string;
  path: string;
}

interface PendingRefRow {
  resource_id: string;
  path: string;
  kind: string;
}

async function nextPendingPlaylist(
  db: D1Database,
  pkg: MediaPackageRow,
  deps: DependencyMap,
): Promise<PendingPlaylistRow | null> {
  // Playlist rows are bounded by the generation's reference bound; the
  // pending filter is the dependency map, not the row order, so no pending
  // row can hide behind a page limit.
  const rows = await db
    .prepare(
      'SELECT resource_id, file_id, path FROM media_package_resources ' +
        'WHERE package_id = ? AND index_generation = ? ' +
        "AND kind = 'playlist' AND file_id <> '' ORDER BY rowid",
    )
    .bind(pkg.id, pkg.indexGeneration)
    .all<PendingPlaylistRow>();
  for (const row of rows.results ?? []) {
    if (deps[row.file_id]?.v === undefined) return row;
  }
  return null;
}

async function nextPendingRef(
  db: D1Database,
  pkg: MediaPackageRow,
): Promise<PendingRefRow | null> {
  const row = await db
    .prepare(
      'SELECT resource_id, path, kind FROM media_package_resources ' +
        'WHERE package_id = ? AND index_generation = ? ' +
        "AND file_id = '' ORDER BY resource_id LIMIT 1",
    )
    .bind(pkg.id, pkg.indexGeneration)
    .first<PendingRefRow>();
  return row ?? null;
}

/**
 * Next resource id sequence. Deduped inserts consume no id, so the counter
 * is derived from the maximum numeric suffix — never COUNT(*), which
 * desyncs after an ignored insert and silently dropped rows (W4-R2 #1).
 */
async function nextResourceSeq(db: D1Database, pkg: MediaPackageRow): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(MAX(CAST(SUBSTR(resource_id, 2) AS INTEGER)), 0) + 1 AS n " +
        'FROM media_package_resources WHERE package_id = ? AND index_generation = ?',
    )
    .bind(pkg.id, pkg.indexGeneration)
    .first<{ n: number }>();
  return row?.n ?? 1;
}

function dirOf(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

/**
 * One bounded advance call on a 'preparing' package. Each work unit commits
 * atomically with the cursor CAS; on any CAS loss the call reports stale
 * and the caller re-reads state. Throws HlsPlaylistError/PackageIndexError
 * for permanent generation failures (the caller marks the row failed) and
 * DriveError/ApiRequestError for upstream/admission failures (retryable).
 */
async function scanOnce(
  db: D1Database,
  pkg: MediaPackageRow,
  deps: PackageIndexDeps,
  cursor: ScanCursorScan,
  depMap: DependencyMap,
  now: number,
): Promise<'progress' | 'done' | 'stale'> {
  const resolveCtx: ResolveContext = {
    db,
    oauth: deps.oauthProvider,
    mount: deps.mount,
    access: deps.access,
    writer: deps.writer,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    children: new Map(),
  };

  // Work unit 1: parse a resolved playlist that is not yet a dependency.
  const pendingPlaylist = await nextPendingPlaylist(db, pkg, depMap);
  if (pendingPlaylist !== null) {
    const fileId = pendingPlaylist.file_id;
    const entry = depMap[fileId];
    if (entry === undefined) {
      throw new PackageIndexError('internal', 'playlist row lacks dependency entry');
    }
    const { text, marker } = await readPlaylistText(deps.env, resolveCtx, deps.readProvider, fileId);
    const parentSegs = dirOf(pendingPlaylist.path).split('/').filter((s) => s !== '');
    const parsed = parseHlsPlaylist(text, parentSegs);
    const statements: D1PreparedStatement[] = [];
    let seq = await nextResourceSeq(db, pkg);
    const totalRefs = await resourceCount(db, pkg);
    if (totalRefs + parsed.references.length > HLS_MAX_REFERENCES) {
      throw new HlsPlaylistError(
        'oversize',
        `package exceeds ${HLS_MAX_REFERENCES} references`,
      );
    }
    // path -> existing row for this generation. Dedupe only same kind:
    // a path claimed by both a playlist ref and a byte-resource ref is a
    // kind conflict — silent OR IGNORE would publish an incomplete graph
    // (W4-R2 #2). Same-path/same-kind refs dedupe without consuming an id.
    const pathRows = await db
      .prepare(
        'SELECT path, kind, file_id FROM media_package_resources ' +
          'WHERE package_id = ? AND index_generation = ?',
      )
      .bind(pkg.id, pkg.indexGeneration)
      .all<{ path: string; kind: string; file_id: string }>();
    const pathMap = new Map<string, { kind: string; fileId: string }>();
    for (const r of pathRows.results ?? []) {
      pathMap.set(r.path, { kind: r.kind, fileId: r.file_id });
    }
    for (const ref of parsed.references) {
      const childPath = ref.segments.join('/');
      const kind: MediaResourceKind =
        ref.kind === 'playlist' ? 'playlist' : ref.kind === 'init' ? 'init' : 'segment';
      const prior = pathMap.get(childPath);
      if (prior !== undefined) {
        if (prior.kind !== kind) {
          throw new PackageIndexError(
            'ambiguous',
            `path '${childPath.slice(0, 80)}' is referenced with conflicting kinds`,
          );
        }
        if (kind === 'playlist' && prior.fileId !== '') {
          const dep = depMap[prior.fileId];
          if (dep !== undefined && (dep.v !== undefined || prior.fileId === fileId)) {
            throw new PackageIndexError(
              'cycle',
              'playlist graph revisits a parsed playlist',
            );
          }
        }
        continue;
      }
      if (ref.kind === 'playlist') {
        const depth = entry.d + 1;
        if (depth > HLS_MAX_PLAYLIST_DEPTH) {
          throw new HlsPlaylistError('oversize', `playlist depth exceeds ${HLS_MAX_PLAYLIST_DEPTH}`);
        }
        cursor.pd[childPath] = depth;
      }
      statements.push(
        resourceInsertStatement(db, pkg, `r${seq}`, childPath, kind, now),
      );
      pathMap.set(childPath, { kind, fileId: '' });
      seq += 1;
    }
    if (JSON.stringify(cursor).length > HLS_MAX_CURSOR_BYTES) {
      throw new HlsPlaylistError('oversize', 'scan cursor exceeds its bound');
    }
    depMap[fileId] = { d: entry.d, v: marker };
    // The playlist row's stored marker upgrades to the SA-side version at
    // parse time (resolve only observed catalog metadata).
    statements.push(
      db
        .prepare(
          'UPDATE media_package_resources SET revision_id = ? ' +
            'WHERE package_id = ? AND index_generation = ? AND resource_id = ? ' +
            `AND ${GUARD_PACKAGE}`,
        )
        .bind(
          marker === '' ? null : marker,
          pkg.id,
          pkg.indexGeneration,
          pendingPlaylist.resource_id,
          pkg.id,
          pkg.scanCursorVersion,
          pkg.indexGeneration,
          'preparing',
        ),
    );
    statements.push(cursorCommitStatement(db, pkg, cursor, depMap, now));
    const results = await db.batch(statements);
    if ((results.at(-1)?.meta.changes ?? 0) === 0) return 'stale';
    return 'progress';
  }

  // Work unit 2: resolve a pending reference path to a Drive file.
  const pendingRef = await nextPendingRef(db, pkg);
  if (pendingRef !== null) {
    const resolved = await resolvePackagePath(resolveCtx, cursor.root, pendingRef.path)
      .catch((err: unknown) => {
        if (err instanceof DriveError) {
          const permanent = permanentIndexError(err.reason, 'playlist reference');
          if (permanent !== null) throw permanent;
        }
        throw err;
      });
    // fileId -> kind must be consistent across the generation: one file
    // serving as both playlist and byte resource is an error (W4-R2 #2).
    const kindRows = await db
      .prepare(
        'SELECT DISTINCT kind FROM media_package_resources ' +
          'WHERE package_id = ? AND index_generation = ? AND file_id = ?',
      )
      .bind(pkg.id, pkg.indexGeneration, resolved.fileId)
      .all<{ kind: string }>();
    for (const r of kindRows.results ?? []) {
      if (r.kind !== pendingRef.kind) {
        throw new PackageIndexError(
          'ambiguous',
          `file is referenced with conflicting kinds ('${r.kind}' vs '${pendingRef.kind}')`,
        );
      }
    }
    if (pendingRef.kind === 'playlist') {
      const existing = depMap[resolved.fileId];
      if (existing?.v !== undefined) {
        throw new PackageIndexError(
          'cycle',
          `playlist graph revisits a parsed playlist`,
        );
      }
      if (existing !== undefined) {
        // Same playlist file reachable at a second canonical path: its
        // children are only indexed under one parent dir, so serving the
        // alias would 409 forever — reject deterministically (W4-R2 #3).
        throw new PackageIndexError(
          'ambiguous',
          'playlist file is reachable at two canonical paths',
        );
      }
      const depth = cursor.pd[pendingRef.path];
      if (depth === undefined) {
        throw new PackageIndexError('internal', 'playlist reference lost its depth entry');
      }
      delete cursor.pd[pendingRef.path];
      depMap[resolved.fileId] = { d: depth };
    }
    const results = await db.batch([
      resourceResolveStatement(
        db,
        pkg,
        pendingRef.resource_id,
        resolved.fileId,
        resolved.marker,
        resolved.byteLength,
      ),
      cursorCommitStatement(db, pkg, cursor, depMap, now),
    ]);
    if ((results.at(-1)?.meta.changes ?? 0) === 0) return 'stale';
    return 'progress';
  }

  // No pending work: atomically publish this generation and drop rows of
  // superseded generations — they are unreachable once ready_generation
  // flips (W4-R2 #11). Strictly older generations only, so a stale publish
  // that loses the CAS still cannot delete live rows.
  const results = await db.batch([
    publishStatement(db, pkg, depMap, now),
    db
      .prepare(
        'DELETE FROM media_package_resources ' +
          'WHERE package_id = ? AND index_generation < ?',
      )
      .bind(pkg.id, pkg.indexGeneration),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0) return 'stale';
  return 'done';
}

async function resourceCount(db: D1Database, pkg: MediaPackageRow): Promise<number> {
  const row = await db
    .prepare(
      'SELECT COUNT(*) AS n FROM media_package_resources ' +
        'WHERE package_id = ? AND index_generation = ?',
    )
    .bind(pkg.id, pkg.indexGeneration)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ---------------------------------------------------------------------------
// Ready-generation verification and generation restart
// ---------------------------------------------------------------------------

/**
 * Re-derive the entry context (name + containing folder) for a fresh
 * generation. The entry file may have moved or been renamed since the last
 * generation; the canonical root always follows its current parent.
 */
async function freshEntryContext(
  deps: PackageIndexDeps,
  entryFileId: string,
): Promise<{ name: string; rootFolderId: string }> {
  const meta = await deps.oauthProvider.getMetadata({
    writer: deps.writer,
    ref: { id: entryFileId },
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  }).catch((err: unknown) => {
    if (err instanceof DriveError) {
      const permanent = permanentIndexError(err.reason, 'entry playlist');
      if (permanent !== null) throw permanent;
    }
    throw err;
  });
  if (meta.trashed === true || meta.driveId !== deps.mount.driveId) {
    throw new PackageIndexError('scope', 'entry file is outside the mount or trashed');
  }
  const parents = meta.parents ?? [];
  if (parents.length !== 1) {
    throw new PackageIndexError('ambiguous', 'entry file does not have exactly one parent folder');
  }
  const root = parents[0];
  if (root === undefined) {
    throw new PackageIndexError('ambiguous', 'entry file does not have exactly one parent folder');
  }
  return { name: meta.name, rootFolderId: root };
}

/**
 * Restart indexing at a new generation: reset deps/cursor and seed the
 * entry playlist row for indexGeneration+1. Used for failed retries and
 * after dependency invalidation — a published generation is never mutated.
 */
async function restartGeneration(
  db: D1Database,
  pkg: MediaPackageRow,
  deps: PackageIndexDeps,
  fromState: MediaPackageState,
  now: number,
): Promise<boolean> {
  const entry = await freshEntryContext(deps, pkg.entryFileId);
  const nextGeneration = pkg.indexGeneration + 1;
  const cursor: ScanCursorScan = { v: 1, phase: 'scan', root: entry.rootFolderId, pd: {} };
  const depMap: DependencyMap = { [pkg.entryFileId]: { d: 1 } };
  const results = await db.batch([
    // Seeded BEFORE the claim so both guard on the same cursor version.
    db
      .prepare(
        'INSERT INTO media_package_resources ' +
          '(package_id, index_generation, resource_id, path, file_id, ' +
          'revision_id, kind, byte_length, created_at) ' +
          `SELECT ?, ?, 'r1', ?, ?, NULL, 'playlist', NULL, ? WHERE ${GUARD_PACKAGE}`,
      )
      .bind(
        pkg.id,
        nextGeneration,
        entry.name,
        pkg.entryFileId,
        now,
        pkg.id,
        pkg.scanCursorVersion,
        pkg.indexGeneration,
        fromState,
      ),
    db
      .prepare(
        "UPDATE media_packages SET state = 'preparing', index_generation = ?, " +
          'scan_cursor = ?, scan_cursor_version = ?, dependency_versions = ?, ' +
          'failure_reason = NULL, updated_at = ? ' +
          'WHERE id = ? AND scan_cursor_version = ? AND index_generation = ? ' +
          'AND state = ?',
      )
      .bind(
        nextGeneration,
        JSON.stringify(cursor),
        pkg.scanCursorVersion + 1,
        JSON.stringify(depMap),
        now,
        pkg.id,
        pkg.scanCursorVersion,
        pkg.indexGeneration,
        fromState,
      ),
  ]);
  return (results.at(-1)?.meta.changes ?? 0) > 0;
}

/**
 * Bounded verification of a published generation's playlist dependencies.
 * Progress (verified fileIds) persists in the scan cursor. A mismatch
 * invalidates the generation: restartGeneration flips to a fresh scan.
 */
async function verifyOnce(
  db: D1Database,
  pkg: MediaPackageRow,
  deps: PackageIndexDeps,
  cursor: ScanCursorVerify,
  depMap: DependencyMap,
  budget: number,
  now: number,
): Promise<AdvanceOutcome> {
  const doneSet = new Set(cursor.done);
  const pending = Object.keys(depMap).filter((f) => !doneSet.has(f)).sort();
  const check = pending.slice(0, budget);
  for (const fileId of check) {
    let depChanged = false;
    try {
      const meta = await deps.oauthProvider.getMetadata({
        writer: deps.writer,
        ref: { id: fileId },
        ...(deps.signal === undefined ? {} : { signal: deps.signal }),
      });
      const expected = depMap[fileId]?.v ?? '';
      const current = hlsVersionMarker(meta);
      depChanged = expected !== '' && current !== '' && current !== expected;
    } catch (err) {
      // A permanently-gone dependency invalidates the generation the same
      // way a version mismatch does — re-index decides the outcome
      // (W4-R2 #6: no permanent verify wedge).
      if (err instanceof DriveError && PERMANENT_DRIVE_REASONS.has(err.reason)) {
        depChanged = true;
      } else {
        throw err;
      }
    }
    if (depChanged) {
      // Dependency changed or gone: invalidate by starting a fresh
      // generation. A failing restart (e.g. the entry itself vanished)
      // propagates and is handled by the caller.
      const restarted = await restartGeneration(db, pkg, deps, 'ready', now);
      const fresh = await getMediaPackage(db, pkg.id);
      if (fresh === null) {
        throw new PackageIndexError('internal', 'package row vanished');
      }
      return {
        pkg: fresh,
        processedResources: check.indexOf(fileId),
        complete: false,
        stale: !restarted,
      };
    }
    doneSet.add(fileId);
  }
  const finished = pending.length <= check.length;
  const nextCursor: ScanCursorVerify = {
    v: 1,
    phase: 'verify',
    done: [...doneSet],
  };
  const results = await db.batch([
    db
      .prepare(
        'UPDATE media_packages SET scan_cursor = ?, scan_cursor_version = ?, ' +
          'updated_at = ? WHERE id = ? AND scan_cursor_version = ? ' +
          "AND index_generation = ? AND state = 'ready'",
      )
      .bind(
        finished ? null : JSON.stringify(nextCursor),
        pkg.scanCursorVersion + 1,
        now,
        pkg.id,
        pkg.scanCursorVersion,
        pkg.indexGeneration,
      ),
  ]);
  const committed = (results[0]?.meta.changes ?? 0) > 0;
  const fresh = await getMediaPackage(db, pkg.id);
  if (fresh === null) {
    throw new PackageIndexError('internal', 'package row vanished');
  }
  return {
    pkg: fresh,
    processedResources: check.length,
    complete: finished,
    stale: !committed,
  };
}

/**
 * Advance a package: continue the current scan, verify a ready generation,
 * or restart from failed. `stale` outcomes mean a concurrent advance
 * committed first — the response reflects the winning state.
 */
export async function advancePackageIndex(
  db: D1Database,
  pkg: MediaPackageRow,
  deps: PackageIndexDeps,
): Promise<AdvanceOutcome> {
  const now = (deps.now ?? Date.now)();
  const budget = Math.max(1, Math.min(64, deps.workBudget ?? HLS_ADVANCE_WORK_BUDGET));

  if (pkg.state === 'ready') {
    let cursor: ScanCursorVerify;
    if (pkg.scanCursor !== null) {
      const parsed = parseCursor(pkg.scanCursor);
      cursor = parsed.phase === 'verify' ? parsed : { v: 1, phase: 'verify', done: [] };
    } else {
      cursor = { v: 1, phase: 'verify', done: [] };
    }
    const depMap = parseDependencies(pkg.dependencyVersions);
    if (Object.keys(depMap).length === 0) {
      // Nothing to verify (should not happen for a real generation) —
      // report complete without touching state.
      return { pkg, processedResources: 0, complete: true, stale: false };
    }
    return verifyOnce(db, pkg, deps, cursor, depMap, budget, now);
  }

  if (pkg.state === 'failed' || (pkg.state === 'preparing' && pkg.scanCursor === null)) {
    // 'failed' retries from scratch; 'preparing' with a NULL cursor is a
    // stale-marked ready package — either way a fresh generation is seeded.
    let restarted: boolean;
    try {
      restarted = await restartGeneration(
        db,
        pkg,
        deps,
        pkg.state === 'failed' ? 'failed' : 'preparing',
        now,
      );
    } catch (err) {
      // A permanently unresolvable entry ends the package: mark it failed
      // under the same CAS instead of leaving it retryable forever.
      if (
        (err instanceof PackageIndexError || err instanceof HlsPlaylistError) &&
        pkg.state === 'preparing'
      ) {
        await db.batch([failStatement(db, pkg, packageFailureReason(err), now)]);
      }
      throw err;
    }
    const fresh = await getMediaPackage(db, pkg.id);
    if (fresh === null) {
      throw new PackageIndexError('internal', 'package row vanished');
    }
    return { pkg: fresh, processedResources: 0, complete: false, stale: !restarted };
  }

  const cursor = parseCursor(pkg.scanCursor);
  if (cursor.phase !== 'scan') {
    throw new PackageIndexError('internal', 'preparing package without scan cursor');
  }
  const depMap = parseDependencies(pkg.dependencyVersions);
  let current = pkg;
  let processed = 0;
  while (processed < budget) {
    let outcome: 'progress' | 'done' | 'stale';
    try {
      outcome = await scanOnce(db, current, deps, cursor, depMap, now);
    } catch (err) {
      if (err instanceof HlsPlaylistError || err instanceof PackageIndexError) {
        // Permanent failure for this generation: record it under the same
        // CAS so a concurrent advance cannot resurrect the scan. The reason
        // is a stable code — never the upstream-shaped message text.
        await db.batch([failStatement(db, current, packageFailureReason(err), now)]);
      }
      throw err;
    }
    if (outcome === 'stale') {
      const fresh = await getMediaPackage(db, current.id);
      if (fresh === null) {
        throw new PackageIndexError('internal', 'package row vanished');
      }
      return { pkg: fresh, processedResources: processed, complete: fresh.state === 'ready', stale: true };
    }
    processed += 1;
    const fresh = await getMediaPackage(db, current.id);
    if (fresh === null) {
      throw new PackageIndexError('internal', 'package row vanished');
    }
    current = fresh;
    if (outcome === 'done') {
      return { pkg: current, processedResources: processed, complete: true, stale: false };
    }
  }
  return { pkg: current, processedResources: processed, complete: false, stale: false };
}

// ---------------------------------------------------------------------------
// Serving helpers shared with the resource route.
// ---------------------------------------------------------------------------

/**
 * Persisted version marker for a resource row (stored in revision_id as
 * `rev:<id>` / `mtime:<iso>`) compared against fresh SA metadata. '' or
 * null means unverifiable — best-effort detection only stops on an actual
 * mismatch (spec §8.2).
 */
export function resourceVersionMatches(
  stored: string | null,
  current: { headRevisionId?: string; modifiedTime?: string },
): boolean {
  if (stored === null || stored === '') return true;
  // Compare inside the marker's own space: 'rev:' markers (recorded from
  // SA-side metadata at playlist parse) check headRevisionId; 'mtime:'
  // markers (recorded from catalog resolution) check modifiedTime.
  if (stored.startsWith('rev:')) {
    return (
      current.headRevisionId !== undefined &&
      `rev:${current.headRevisionId}` === stored
    );
  }
  if (stored.startsWith('mtime:')) {
    return (
      current.modifiedTime !== undefined &&
      `mtime:${current.modifiedTime}` === stored
    );
  }
  return false;
}

/**
 * A dependency/resource mismatch invalidates the ready state: the package
 * goes back to 'preparing' under a fresh cursor so the next advance
 * re-indexes. Guarded on the exact published generation.
 */
export async function markPackageStale(
  db: D1Database,
  pkg: MediaPackageRow,
  now: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE media_packages SET state = 'preparing', " +
        'scan_cursor_version = scan_cursor_version + 1, ' +
        'scan_cursor = NULL, updated_at = ? ' +
        'WHERE id = ? AND state = \'ready\' AND ready_generation = ?',
    )
    .bind(now, pkg.id, pkg.readyGeneration ?? -1)
    .run();
}
