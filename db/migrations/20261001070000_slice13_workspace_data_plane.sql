-- Octo Schema: Slice 13 - Workspace data plane
-- Adds the destructive-command confirmation secret, per-workspace retention policy,
-- and the one-account-wide-key-per-principal invariant.

-- 1. Confirmation secret for destructive commands. Hashed with the same helper as
-- API keys; NULL means unset, and destructive routes fail closed until it is set.
ALTER TABLE octo.principals
    ADD COLUMN IF NOT EXISTS confirm_secret_hash TEXT;

-- 2. Retention policy. NULL = never auto-archive; an integer = archive files older
-- than this many days. This is the entire retention model.
ALTER TABLE octo.workspaces
    ADD COLUMN IF NOT EXISTS retention_days INTEGER
        CHECK (retention_days IS NULL OR retention_days > 0);

-- 3. At most one account-wide key (workspace_id IS NULL) per principal.
CREATE UNIQUE INDEX IF NOT EXISTS uq_api_keys_account_wide
    ON octo.api_keys (principal_id)
    WHERE workspace_id IS NULL;

-- files.archive_state and the jobs idempotency constraint are unchanged: the
-- archive idempotency key is made transition-scoped in application code.
