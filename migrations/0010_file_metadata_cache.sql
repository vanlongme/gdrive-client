-- Wave 10 (worker M): file metadata cache. A row holds the metadata facts
-- checkFileMeta, range planning and containment need for one file under one
-- mount, so a fresh eligible row can skip the SA files.get round trip on
-- content opens. Rows live at most 60 s (expires_at, enforced at read time).
-- reader_can_download is the reader-side download verdict: only rows where
-- it is 1 may ever substitute for the live SA metadata read; rows written
-- from a live SA read carry the SA's own canDownload verdict, rows written
-- from OAuth listings/search carry the restriction-field verdict
-- (copyRequiresWriterPermission / downloadRestrictions) where ANY missing
-- verdict field means 0. No resource keys, thumbnail links or credentials
-- are ever stored; files needing a resource key, shortcuts and folders are
-- never cached. App-made mutations delete rows by file_id or by
-- (mount_id, parent_id) and record a short-lived tombstone per file_id so
-- a fill whose upstream fetch predates the invalidation cannot resurrect
-- the row; expiry is indexed so fills can prune a bounded number of dead
-- rows, and file_id is indexed so invalidation deletes stay cheap.
CREATE TABLE file_metadata_cache (
    mount_id TEXT NOT NULL,
    file_id TEXT NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size TEXT,
    md5 TEXT,
    modified_time TEXT,
    trashed INTEGER NOT NULL DEFAULT 0,
    drive_id TEXT,
    parent_id TEXT,
    reader_can_download INTEGER NOT NULL DEFAULT 0,
    head_revision_id TEXT,
    source TEXT NOT NULL,
    cached_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (mount_id, file_id)
);

CREATE INDEX idx_file_metadata_cache_expires
    ON file_metadata_cache (expires_at);

-- invalidateFile deletes across mounts by file_id alone; the PK's leading
-- mount_id cannot serve that probe.
CREATE INDEX idx_file_metadata_cache_file
    ON file_metadata_cache (file_id);

-- Invalidation tombstones (review L2): a listing/search fill whose upstream
-- fetch started before the file's latest invalidation must not resurrect a
-- stale row. invalidated_at >= the fill's fetched_at skips the row;
-- tombstones live at most as long as a cache row (60 s) and are pruned on
-- the same bounded cadence.
CREATE TABLE file_metadata_tombstones (
    file_id TEXT NOT NULL PRIMARY KEY,
    invalidated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX idx_file_metadata_tombstones_expires
    ON file_metadata_tombstones (expires_at);
