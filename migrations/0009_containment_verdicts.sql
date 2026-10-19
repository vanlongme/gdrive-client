-- Wave 9 (worker P): cross-isolate containment verdicts. A positive
-- ancestor-walk verdict — `folder_id` sits on a path to `root_folder_id`
-- inside `mount_id` — is shared across isolates for up to 60 s. Only
-- positive verdicts are stored; negatives remain isolate-local. App-driven
-- creates/trashes delete affected rows; expiry is indexed for pruning.
CREATE TABLE containment_verdicts (
    mount_id TEXT NOT NULL,
    root_folder_id TEXT NOT NULL,
    folder_id TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (mount_id, root_folder_id, folder_id)
);

CREATE INDEX idx_containment_verdicts_expires
    ON containment_verdicts (expires_at);
