-- Octo Schema: Slice 7 - DuckDB/Parquet analytics catalog
--
-- Postgres owns dataset/version/result METADATA only. The Parquet bytes live in
-- the object store (R2 in production, the explicit local backend in CI/dev).
-- No analytical rows are stored here.
--
-- Three tables:
--   octo.datasets          a logical dataset per workspace (slug is unique per workspace)
--   octo.dataset_versions  an immutable export: server-assigned version, schema,
--                          provenance, watermark, row count, ordered object keys
--   octo.analytics_results the derived result artifact for one analytics_query job
--
-- Every tenant table carries the Slice 14 RESTRICTIVE fence. DML is granted to
-- `octo_service` only: the request path never writes the catalog directly, and
-- the app pool is RLS-fenced. This mirrors the workspace_database_credentials
-- migration and the test that guards it (tests/test_slice21_schema.py).

CREATE TABLE IF NOT EXISTS octo.datasets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    name TEXT,
    created_by UUID REFERENCES octo.principals(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, slug)
);

CREATE TABLE IF NOT EXISTS octo.dataset_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    dataset_id UUID NOT NULL REFERENCES octo.datasets(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    format TEXT NOT NULL DEFAULT 'parquet',
    schema JSONB NOT NULL,
    provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    watermark TEXT,
    row_count BIGINT NOT NULL,
    object_keys TEXT[] NOT NULL,
    idempotency_key TEXT,
    created_by UUID REFERENCES octo.principals(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (dataset_id, version)
);

-- A repeated registration under the same key returns the original version
-- instead of creating a second one.
CREATE UNIQUE INDEX IF NOT EXISTS dataset_versions_idempotency_unique
    ON octo.dataset_versions (dataset_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS octo.analytics_results (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    dataset_version_id UUID NOT NULL REFERENCES octo.dataset_versions(id) ON DELETE CASCADE,
    job_id UUID NOT NULL REFERENCES octo.jobs(id) ON DELETE CASCADE,
    query_spec TEXT NOT NULL,
    object_key TEXT NOT NULL,
    row_count BIGINT NOT NULL,
    content_hash TEXT NOT NULL,
    engine_version TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (job_id)
);

-- Row-level security and the tenant fence -----------------------------------------

ALTER TABLE octo.datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE octo.dataset_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE octo.analytics_results ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_scope_fence ON octo.datasets;
CREATE POLICY tenant_scope_fence ON octo.datasets
    AS RESTRICTIVE
    FOR ALL
    USING (octo.current_workspace_id() IS NULL OR workspace_id = octo.current_workspace_id())
    WITH CHECK (octo.current_workspace_id() IS NULL OR workspace_id = octo.current_workspace_id());

DROP POLICY IF EXISTS tenant_scope_fence ON octo.dataset_versions;
CREATE POLICY tenant_scope_fence ON octo.dataset_versions
    AS RESTRICTIVE
    FOR ALL
    USING (octo.current_workspace_id() IS NULL OR workspace_id = octo.current_workspace_id())
    WITH CHECK (octo.current_workspace_id() IS NULL OR workspace_id = octo.current_workspace_id());

DROP POLICY IF EXISTS tenant_scope_fence ON octo.analytics_results;
CREATE POLICY tenant_scope_fence ON octo.analytics_results
    AS RESTRICTIVE
    FOR ALL
    USING (octo.current_workspace_id() IS NULL OR workspace_id = octo.current_workspace_id())
    WITH CHECK (octo.current_workspace_id() IS NULL OR workspace_id = octo.current_workspace_id());

-- The catalog is written and read by the trusted worker/route surface only.
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.datasets TO octo_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.dataset_versions TO octo_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.analytics_results TO octo_service;
