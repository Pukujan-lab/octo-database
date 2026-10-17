-- Vault items record where their kind came from. Rows the owner saved through
-- the explicit form are 'explicit'; rows whose kind was inferred from the label
-- at bulk import or by the backfill are 'inferred'. The health pass never
-- probes inferred rows: a 404 on a backfilled base URL is not evidence the
-- key is dead, and probing would arm the stale→purge path against config rows.
ALTER TABLE octo.vault_items
    ADD COLUMN IF NOT EXISTS kind_source TEXT NOT NULL DEFAULT 'explicit'
    CHECK (kind_source IN ('explicit', 'inferred'));
