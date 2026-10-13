-- Octo Schema: Ops events - structured operational failure capture (issue #140, slice O1)
--
-- A queryable record of failures, written from the two places the server already
-- catches them: the outer 5xx handler and the worker's fail/exception path.
-- `octo.activity` is the human-readable projection of successful actions and stays
-- as-is; this table is the structured complement for diagnosis, not a second
-- observation system. 4xx refusals are normal product behavior and are not
-- captured here.
--
-- "Deterministic states" is not a new state machine: the job state machine remains
-- octo.jobs' existing CHECK enum and transition functions. This table is the
-- evidence those states and failures leave behind.

CREATE TABLE IF NOT EXISTS octo.ops_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Nullable so a platform-level error (auth failure, pre-workspace 500) can be
    -- recorded. Workspace-scoped rows cascade with the workspace; null-workspace
    -- rows are readable only by the platform owner.
    workspace_id UUID REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    source TEXT NOT NULL CHECK (source IN ('api', 'worker')),
    event_type TEXT NOT NULL,
    error_code TEXT,
    severity TEXT NOT NULL DEFAULT 'error' CHECK (severity IN ('warning', 'error', 'critical')),
    -- Structured context only. Never a credential or raw token.
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    job_id UUID REFERENCES octo.jobs(id) ON DELETE SET NULL,
    route TEXT,
    job_type TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_events_workspace_created
    ON octo.ops_events(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_events_error_code
    ON octo.ops_events(error_code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_events_created_at
    ON octo.ops_events(created_at DESC);

ALTER TABLE octo.ops_events ENABLE ROW LEVEL SECURITY;

-- Members may read their workspace's events. Platform-level events (null
-- workspace) are visible only to the platform owner.
CREATE POLICY ops_events_select_member ON octo.ops_events
    FOR SELECT
    USING (
        (workspace_id IS NOT NULL AND octo.is_workspace_member(workspace_id) = true)
        OR (workspace_id IS NULL AND octo.is_platform_owner() = true)
    );

-- Same RESTRICTIVE tenant fence as the other tenant tables (slice 14): a
-- workspace-scoped key can only see rows for its own workspace, and never the
-- null-workspace platform rows.
CREATE POLICY tenant_scope_fence ON octo.ops_events
    AS RESTRICTIVE
    FOR ALL
    USING (octo.current_workspace_id() IS NULL OR workspace_id = octo.current_workspace_id())
    WITH CHECK (octo.current_workspace_id() IS NULL OR workspace_id = octo.current_workspace_id());

-- Writes run through the trusted server path (service role / server code), which
-- authorizes the caller before recording. DML only: TRUNCATE and REFERENCES are not
-- subject to row security.
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.ops_events TO authenticated;
