-- Octo Schema: Slice 5 - R2-to-Google-Drive archive lifecycle
-- Archival is a controlled state transition, not a blind copy/delete script.
-- Canonical lifecycle state lives here; R2 and Drive hold bytes.

ALTER TABLE octo.files
    ADD COLUMN IF NOT EXISTS archive_state TEXT NOT NULL DEFAULT 'active_r2'
        CHECK (archive_state IN (
            'active_r2',
            'archiving',
            'archived_drive',
            'restoring',
            'reconciliation_required'
        ));

ALTER TABLE octo.files
    ADD COLUMN IF NOT EXISTS archive_provider TEXT,
    ADD COLUMN IF NOT EXISTS archive_locator TEXT,
    -- SHA-256 of the bytes as archived, so a restore can prove the cold copy is
    -- the same object that was archived before trusting it back into R2.
    ADD COLUMN IF NOT EXISTS archive_hash TEXT,
    ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ;

-- Reconciliation and restore scan by lifecycle state, not by file name.
CREATE INDEX IF NOT EXISTS idx_files_archive_state ON octo.files(archive_state);

-- Note: `status` is intentionally left alone. An archived file is still a live
-- logical file, so it keeps `status = 'active'` and the gallery continues to list
-- it; the bytes are simply restored on demand.
--
-- No new RLS policy or grant is required: the existing files_update_owner_admin
-- policy already covers these columns for owner/admin callers, and the worker
-- transitions state as the trusted server role.
