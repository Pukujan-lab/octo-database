-- Octo Schema: workspace-registered analytics query specs
--
-- A spec is a single SELECT a workspace writes over one dataset version (exposed
-- to the SQL as the view `data`). Versions are immutable: changing the SQL is a
-- new version, so a result always names the exact statement that produced it.
-- Specs are addressed as `ws:<slug>@<version>`.

CREATE TABLE IF NOT EXISTS octo.analytics_specs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    slug TEXT NOT NULL,
    version INTEGER NOT NULL,
    sql TEXT NOT NULL,
    params JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_by UUID REFERENCES octo.principals(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (workspace_id, slug, version)
);

ALTER TABLE octo.analytics_specs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_scope_fence ON octo.analytics_specs;
CREATE POLICY tenant_scope_fence ON octo.analytics_specs
    AS RESTRICTIVE
    FOR ALL
    USING (octo.current_workspace_id() IS NULL OR workspace_id = octo.current_workspace_id())
    WITH CHECK (octo.current_workspace_id() IS NULL OR workspace_id = octo.current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON octo.analytics_specs TO octo_service;
