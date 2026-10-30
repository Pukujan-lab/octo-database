-- Each place that uses Octo gets its own key: a principal may hold several
-- account-wide keys, and minting a vault lease no longer retires the other live
-- leases for the same grant and item. Each key lives until it expires or is revoked.
DROP INDEX IF EXISTS octo.uq_api_keys_account_wide;
DROP INDEX IF EXISTS octo.idx_vault_leases_active;
CREATE INDEX IF NOT EXISTS idx_vault_leases_grant_item
    ON octo.vault_leases(parent_grant_id, item_id) WHERE revoked_at IS NULL;
