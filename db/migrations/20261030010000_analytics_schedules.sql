-- Octo Schema: scheduled analytics specs
--
-- A schedule runs one spec over a dataset's newest version every N minutes and
-- writes the result rows into a table in the workspace's own database (schema
-- `analytics`). A run is skipped when no new dataset version has landed since the
-- last one, so an idle dataset costs nothing.

CREATE TABLE IF NOT EXISTS octo.analytics_schedules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    spec TEXT NOT NULL,
    dataset TEXT NOT NULL,
    params JSONB NOT NULL DEFAULT '{}'::jsonb,
    every_minutes INTEGER NOT NULL CHECK (every_minutes BETWEEN 5 AND 10080),
    sink JSONB NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    last_dataset_version_id UUID,
    next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by UUID REFERENCES octo.principals(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analytics_schedules_due
    ON octo.analytics_schedules (next_run_at) WHERE enabled;

ALTER TABLE octo.analytics_schedules ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_scope_fence ON octo.analytics_schedules;
CREATE POLICY tenant_scope_fence ON octo.analytics_schedules
    AS RESTRICTIVE
    FOR ALL
    USING (octo.current_workspace_id() IS NULL OR workspace_id = octo.current_workspace_id())
    WITH CHECK (octo.current_workspace_id() IS NULL OR workspace_id = octo.current_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON octo.analytics_schedules TO octo_service;
