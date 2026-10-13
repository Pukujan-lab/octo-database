-- Public website files (issue #175).
-- A published file is a copy in a separate public bucket. These columns record
-- that copy. They do not change the private bucket, file status, or archive state.
-- No new policy or grant: existing file policies already cover the columns, and
-- the server writes them on the service connection after its own role check.

ALTER TABLE octo.files
    ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS public_key TEXT;
