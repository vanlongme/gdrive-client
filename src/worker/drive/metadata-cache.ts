/**
 * File metadata cache (wave 10, worker M; migration 0010). A fresh, eligible
 * row lets a content open skip the SA `files.get` round trip: the cached
 * metadata feeds checkFileMeta, range planning and the My Drive containment
 * walk exactly as a live SA metadata read would.
 *
 * Eligibility is deliberately narrow:
 *   - TTL is 60 s, enforced at read time (expires_at > now); fills prune a
 *     bounded number of expired rows.
 *   - Only rows with reader_can_download = 1 may substitute for the live
 *     call. OAuth listing/search rows store the restriction-field verdict
 *     where ANY missing verdict field means false (both
 *     copyRequiresWriterPermission and downloadRestrictions must be
 *     present and clear); sa_meta rows store the SA's own
 *     capabilities.canDownload verdict. For HEAD requests — which never
 *     open media — only sa_meta rows may hit.
 *   - Files needing a resource key, shortcuts and folders are never
 *     cached; they always take the live path.
 *   - A D1 read/write failure degrades to a miss — the cache never fails a
 *     request.
 *
 * The SA media call remains the final authority: when it fails with a
 * denial class (permission-denied, not-found, gone, download-restricted)
 * the caller invalidates the row and surfaces the same error the live
 * path would — there is never a fallback to another provider.
 *
 * Invalidation tombstones (file_metadata_tombstones): every file-level
 * invalidation records invalidated_at for the file id, and a fill skips
 * any row whose upstream fetch started before the latest invalidation —
 * a listing that raced a trash/delete can never resurrect the stale row.
 * Tombstones share the 60 s bound and are pruned on the same cadence.
 */

import { DriveError } from './errors';
import type { MountRecord } from './mounts';
import { FOLDER_MIME_TYPE, SHORTCUT_MIME_TYPE } from './providers/common';
import type { CatalogEntry, DriveFileMeta } from './types';

export const FILE_META_CACHE_TTL_MS = 60_000;
/**
 * Per-fill write cap (one listing page fills at most this many rows).
 * Bound against D1's per-invocation query limit under the strict reading:
 * Workers Free allows 50 queries per invocation and every statement in a
 * db.batch counts individually. A catalog route spends ~10 queries on
 * auth/mount/writer/verdict reads, so the fill batch — fillMax inserts +
 * 1 prune — keeps the whole request comfortably under 50. The archive
 * pre-walk no longer fills (public routes never write), so one request
 * issues at most one fill batch.
 */
export const FILE_META_FILL_MAX = 40;
/**
 * Bounded opportunistic prune on each fill/invalidate batch. Never smaller
 * than a fill (review M4): a page of fresh rows must not be outnumbered by
 * the dead rows it leaves behind.
 */
export const FILE_META_PRUNE_MAX = FILE_META_FILL_MAX;
/** Tombstones live as long as the rows they guard (review L2). */
export const FILE_META_TOMBSTONE_TTL_MS = FILE_META_CACHE_TTL_MS;
/** Bounded tombstone prune appended to invalidation batches. */
export const FILE_META_TOMBSTONE_PRUNE_MAX = 100;

export type FileMetaCacheSource = 'oauth_list' | 'sa_meta';

/** One cache row, shaped for upsert. */
export interface FileMetaCacheRow {
  readonly mountId: string;
  readonly fileId: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size?: string;
  readonly md5?: string;
  readonly modifiedTime?: string;
  readonly trashed: boolean;
  readonly driveId?: string;
  readonly parentId?: string;
  readonly readerCanDownload: boolean;
  readonly headRevisionId?: string;
  readonly source: FileMetaCacheSource;
  readonly expiresAt: number;
  /**
   * When the upstream fetch that produced this row STARTED (ms). A fill
   * skips the row when a tombstone was recorded at or after this time —
   * the data may predate the mutation the invalidation stands for.
   */
  readonly fetchedAt: number;
}

/**
 * The reader-side download verdict for an OAuth listing entry. The owner's
 * OAuth view and the SA reader's view differ exactly here: "viewers cannot
 * download" (copyRequiresWriterPermission) and item/effective download
 * restrictions bind a reader that the owner does not feel. A row is
 * downloadable only when EVERY verdict field is present and clear — any
 * missing verdict field means false, since an unverifiable restriction
 * state is never treated as downloadable (review M2).
 */
export function readerVerdictFromEntry(entry: CatalogEntry): boolean {
  const dr = entry.downloadRestrictions;
  return (
    entry.copyRequiresWriterPermission === false &&
    dr?.restrictedForReaders === false &&
    // Writers-restricted implies readers-restricted upstream.
    dr?.restrictedForWriters === false
  );
}

/** Rows from a catalog listing/search page; undefined rows are skipped. */
export function rowsFromCatalogEntries(
  mountId: string,
  entries: readonly CatalogEntry[],
  now: number,
  fetchedAt: number = now,
  ttlMs: number = FILE_META_CACHE_TTL_MS,
): FileMetaCacheRow[] {
  const rows: FileMetaCacheRow[] = [];
  for (const entry of entries.slice(0, FILE_META_FILL_MAX)) {
    const row = rowFromCatalogEntry(mountId, entry, now, fetchedAt, ttlMs);
    if (row !== undefined) rows.push(row);
  }
  return rows;
}

export function rowFromCatalogEntry(
  mountId: string,
  entry: CatalogEntry,
  now: number,
  fetchedAt: number = now,
  ttlMs: number = FILE_META_CACHE_TTL_MS,
): FileMetaCacheRow | undefined {
  // Only plain files: folders use containment_verdicts, shortcuts are
  // never content-addressable, and resource-keyed refs always go live.
  if (entry.kind !== 'file' || entry.resourceKey !== undefined) {
    return undefined;
  }
  return {
    mountId,
    fileId: entry.id,
    name: entry.name,
    mimeType: entry.mimeType,
    ...(entry.size === undefined ? {} : { size: entry.size }),
    ...(entry.md5Checksum === undefined ? {} : { md5: entry.md5Checksum }),
    ...(entry.modifiedTime === undefined
      ? {}
      : { modifiedTime: entry.modifiedTime }),
    trashed: entry.trashed === true,
    ...(entry.driveId === undefined ? {} : { driveId: entry.driveId }),
    ...(entry.parents?.[0] === undefined
      ? {}
      : { parentId: entry.parents[0] }),
    readerCanDownload: readerVerdictFromEntry(entry),
    ...(entry.headRevisionId === undefined
      ? {}
      : { headRevisionId: entry.headRevisionId }),
    source: 'oauth_list',
    expiresAt: now + ttlMs,
    fetchedAt,
  };
}

/**
 * Row from a live SA metadata read. Only the SA's own canDownload verdict
 * can affirm reader downloadability; a missing flag is never treated as
 * downloadable.
 */
export function rowFromDriveMeta(
  mountId: string,
  meta: DriveFileMeta,
  now: number,
  fetchedAt: number = now,
  ttlMs: number = FILE_META_CACHE_TTL_MS,
): FileMetaCacheRow | undefined {
  if (
    meta.id === '' ||
    meta.resourceKey !== undefined ||
    meta.mimeType === SHORTCUT_MIME_TYPE ||
    meta.mimeType === FOLDER_MIME_TYPE
  ) {
    return undefined;
  }
  return {
    mountId,
    fileId: meta.id,
    name: meta.name,
    mimeType: meta.mimeType,
    ...(meta.size === undefined ? {} : { size: meta.size }),
    ...(meta.md5Checksum === undefined ? {} : { md5: meta.md5Checksum }),
    ...(meta.modifiedTime === undefined
      ? {}
      : { modifiedTime: meta.modifiedTime }),
    trashed: meta.trashed === true,
    ...(meta.driveId === undefined ? {} : { driveId: meta.driveId }),
    ...(meta.parents?.[0] === undefined
      ? {}
      : { parentId: meta.parents[0] }),
    readerCanDownload: meta.capabilities?.canDownload === true,
    ...(meta.headRevisionId === undefined
      ? {}
      : { headRevisionId: meta.headRevisionId }),
    source: 'sa_meta',
    expiresAt: now + ttlMs,
    fetchedAt,
  };
}

interface StoredRow {
  name: string;
  mime_type: string;
  size: string | null;
  md5: string | null;
  modified_time: string | null;
  trashed: number;
  drive_id: string | null;
  parent_id: string | null;
  head_revision_id: string | null;
}

/**
 * Rebuild the DriveFileMeta a live SA read would have produced. The row
 * was already proven fresh and reader-eligible, so the synthesized
 * capabilities affirm canDownload — checkFileMeta needs `=== true`, and
 * the media call remains the final authority on the real verdict.
 * thumbnailLink is deliberately absent (never stored): callers that need
 * it must take the provider's legacy files.get branch on `fromCache`.
 */
export function cachedMetaToDriveFileMeta(
  fileId: string,
  row: StoredRow,
): DriveFileMeta {
  return {
    id: fileId,
    name: row.name,
    mimeType: row.mime_type,
    ...(row.size === null ? {} : { size: row.size }),
    ...(row.modified_time === null
      ? {}
      : { modifiedTime: row.modified_time }),
    trashed: row.trashed === 1,
    ...(row.parent_id === null ? {} : { parents: [row.parent_id] }),
    ...(row.drive_id === null ? {} : { driveId: row.drive_id }),
    ...(row.head_revision_id === null
      ? {}
      : { headRevisionId: row.head_revision_id }),
    ...(row.md5 === null ? {} : { md5Checksum: row.md5 }),
    hasThumbnail: false,
    capabilities: { canDownload: true },
  };
}

export interface FileMetadataCacheStore {
  /**
   * A fresh, reader-eligible row — anything else (missing, expired,
   * reader_can_download = 0, D1 error) is a miss. `source` restricts the
   * hit to rows written by that source (HEAD requires 'sa_meta': no media
   * call will ever re-prove an OAuth-inferred verdict).
   */
  get(
    mount: Pick<MountRecord, 'id' | 'driveId'>,
    fileId: string,
    source?: FileMetaCacheSource,
  ): Promise<StoredRow | undefined>;
  /**
   * Upsert rows in one batch plus a bounded expired-row prune. A row whose
   * fetch started before the file's latest invalidation tombstone is
   * skipped instead of resurrecting stale data.
   */
  put(rows: readonly FileMetaCacheRow[]): Promise<void>;
  /** Drop the file's rows across every mount (content changed/gone). */
  invalidateFile(fileId: string): Promise<void>;
  /** Drop the direct children of one folder (folder mutation). */
  invalidateFolderChildren(mountId: string, folderId: string): Promise<void>;
}

export function createFileMetadataCache(
  db: D1Database,
  options: { ttlMs?: number; now?: () => number } = {},
): FileMetadataCacheStore {
  const now = options.now ?? Date.now;
  const prune = () =>
    db
      .prepare(
        'DELETE FROM file_metadata_cache WHERE rowid IN ' +
          '(SELECT rowid FROM file_metadata_cache WHERE expires_at <= ? LIMIT ?)',
      )
      .bind(now(), FILE_META_PRUNE_MAX);
  const pruneTombstones = () =>
    db
      .prepare(
        'DELETE FROM file_metadata_tombstones WHERE rowid IN ' +
          '(SELECT rowid FROM file_metadata_tombstones WHERE expires_at <= ? LIMIT ?)',
      )
      .bind(now(), FILE_META_TOMBSTONE_PRUNE_MAX);
  const tombstone = (fileId: string, at: number) =>
    db
      .prepare(
        'INSERT INTO file_metadata_tombstones (file_id, invalidated_at, expires_at) ' +
          'VALUES (?, ?, ?) ' +
          'ON CONFLICT(file_id) DO UPDATE SET ' +
          'invalidated_at = MAX(file_metadata_tombstones.invalidated_at, excluded.invalidated_at), ' +
          'expires_at = MAX(file_metadata_tombstones.expires_at, excluded.expires_at)',
      )
      .bind(fileId, at, at + FILE_META_TOMBSTONE_TTL_MS);
  return {
    async get(mount, fileId, source) {
      try {
        const row = await db
          .prepare(
            'SELECT name, mime_type, size, md5, modified_time, trashed, ' +
              'drive_id, parent_id, head_revision_id FROM file_metadata_cache ' +
              'WHERE mount_id = ? AND file_id = ? AND expires_at > ? ' +
              'AND reader_can_download = 1' +
              (source === undefined ? '' : ' AND source = ?'),
          )
          .bind(
            mount.id,
            fileId,
            now(),
            ...(source === undefined ? [] : [source]),
          )
          .first<StoredRow>();
        return row ?? undefined;
      } catch {
        // A lookup failure (D1 down, migration 0010 unapplied) degrades to
        // a miss: the live SA path decides, never the cache.
        return undefined;
      }
    },
    async put(rows) {
      if (rows.length === 0) return;
      const expiry = now();
      try {
        // Each insert is tombstone-guarded: a fetch that started before the
        // file's latest invalidation is stale evidence and never resurrects
        // the row. The check lives inside the statement so the whole fill
        // stays one batch — ordering cannot leak between the tombstone
        // write and the row write.
        const statements = rows.map((row) =>
          db
            .prepare(
              'INSERT OR REPLACE INTO file_metadata_cache (mount_id, ' +
                'file_id, name, mime_type, size, md5, modified_time, ' +
                'trashed, drive_id, parent_id, reader_can_download, ' +
                'head_revision_id, source, cached_at, expires_at) ' +
                'SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? ' +
                'WHERE NOT EXISTS (' +
                'SELECT 1 FROM file_metadata_tombstones t ' +
                'WHERE t.file_id = ? AND t.invalidated_at >= ? AND t.expires_at > ?' +
                ')',
            )
            .bind(
              row.mountId,
              row.fileId,
              row.name,
              row.mimeType,
              row.size ?? null,
              row.md5 ?? null,
              row.modifiedTime ?? null,
              row.trashed ? 1 : 0,
              row.driveId ?? null,
              row.parentId ?? null,
              row.readerCanDownload ? 1 : 0,
              row.headRevisionId ?? null,
              row.source,
              expiry,
              row.expiresAt,
              row.fileId,
              row.fetchedAt,
              expiry,
            ),
        );
        statements.push(prune());
        await db.batch(statements);
      } catch {
        // Cache writes are best-effort; the live path never depends on them.
      }
    },
    async invalidateFile(fileId) {
      try {
        const at = now();
        await db.batch([
          tombstone(fileId, at),
          db
            .prepare('DELETE FROM file_metadata_cache WHERE file_id = ?')
            .bind(fileId),
          pruneTombstones(),
        ]);
      } catch {
        // Invalidation is best-effort; the TTL bounds any missed delete.
      }
    },
    async invalidateFolderChildren(mountId, folderId) {
      try {
        const at = now();
        await db.batch([
          // Tombstone the same rows the delete removes: tombstones are
          // written first so the batch still records the file ids.
          // Known limitation (nothing calls this today): only children
          // already cached are tombstoned — an in-flight fill for a child
          // not yet written has no file_id here and could still land.
          // The 60 s TTL bounds it; a folder-scoped tombstone column would
          // close it if a caller ever needs that guarantee.
          db
            .prepare(
              'INSERT INTO file_metadata_tombstones (file_id, invalidated_at, expires_at) ' +
                'SELECT file_id, ?, ? FROM file_metadata_cache ' +
                'WHERE mount_id = ? AND parent_id = ? ' +
                'ON CONFLICT(file_id) DO UPDATE SET ' +
                'invalidated_at = MAX(file_metadata_tombstones.invalidated_at, excluded.invalidated_at), ' +
                'expires_at = MAX(file_metadata_tombstones.expires_at, excluded.expires_at)',
            )
            .bind(at, at + FILE_META_TOMBSTONE_TTL_MS, mountId, folderId),
          db
            .prepare(
              'DELETE FROM file_metadata_cache WHERE mount_id = ? AND parent_id = ?',
            )
            .bind(mountId, folderId),
          prune(),
          pruneTombstones(),
        ]);
      } catch {
        // Same posture as invalidateFile.
      }
    },
  };
}

/**
 * Media-open DriveError classes for which the SA media call is the final
 * authority (design §3): a cached row that led to one of these is stale —
 * it is invalidated and the request surfaces the same error the live path
 * would produce. Anything else (rate limits, transport, upstream 5xx)
 * says nothing about the row.
 */
export const MEDIA_AUTHORITY_REASONS = new Set([
  'permission-denied',
  'not-found',
  'gone',
  'download-restricted',
]);

/** True when a media-open failure proves the cached row stale. */
export function isMediaAuthorityFailure(err: unknown): boolean {
  return (
    err instanceof DriveError &&
    (MEDIA_AUTHORITY_REASONS as ReadonlySet<string>).has(err.reason)
  );
}
