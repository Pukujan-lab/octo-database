-- Octo Schema: Slice 10 - Rebuildable graph projection (issue #12)
--
-- PostgreSQL remains canonical. The graph engine (FalkorDB) is an optional,
-- rebuildable read model projected from the epistemic ledger. This migration adds
-- only the projection bookkeeping: the watermark/health of a workspace's last
-- projection. Nothing here is a source of truth, so a lost graph is always
-- recoverable by rebuilding from octo.* rows.

-- One row per projected workspace: the graph schema version, the canonical
-- watermark the graph was built from, the projected counts, and the last outcome.
-- `source_watermark` is what makes staleness detectable -- a query compares it to
-- the workspace's current canonical watermark and warns rather than pretending the
-- graph is fresh. A workspace with no row here has never been projected.
CREATE TABLE IF NOT EXISTS octo.graph_projections (
    workspace_id UUID PRIMARY KEY REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    schema_version TEXT NOT NULL,
    source_watermark TIMESTAMPTZ NOT NULL,
    entity_count INTEGER NOT NULL DEFAULT 0,
    claim_count INTEGER NOT NULL DEFAULT 0,
    evidence_count INTEGER NOT NULL DEFAULT 0,
    relation_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'projected' CHECK (status IN ('projected', 'failed')),
    last_error TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE octo.graph_projections ENABLE ROW LEVEL SECURITY;

-- Members may read projection health; operators write it (the projector runs on
-- behalf of an operator's request).
CREATE POLICY graph_projections_select_member ON octo.graph_projections
    FOR SELECT USING (octo.is_workspace_member(workspace_id));
CREATE POLICY graph_projections_insert_operator ON octo.graph_projections
    FOR INSERT WITH CHECK (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'));
CREATE POLICY graph_projections_update_operator ON octo.graph_projections
    FOR UPDATE
    USING (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'))
    WITH CHECK (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'));

GRANT SELECT, INSERT, UPDATE, DELETE ON octo.graph_projections TO authenticated;
