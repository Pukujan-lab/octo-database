-- Octo Schema: Provisioned Postgres per workspace (productization Slice 20)
--
-- A workspace can own one real PostgreSQL database, created in this cluster and
-- connectable by the client with an ordinary Postgres client. This table is the
-- canonical catalog of those databases; the databases and roles themselves are
-- canonical in the Postgres cluster.
--
-- The client's password is NEVER stored here. It exists only in the connection
-- string returned once by POST /api/workspaces/:id/database.
--
-- Isolation is the database boundary plus a scoped role, NOT the slice14 fence:
-- a provisioned database carries no `octo.*` policies and none are added. What
-- this table does carry is the same RESTRICTIVE tenant fence as every other
-- tenant table, so the control-plane row itself is scoped like all the rest.
--
-- The fence is added here, in the same migration that creates the table: the
-- slice14 fence list is a hardcoded array and does not cover tables created
-- later, so a new tenant table that omits this would be unfenced.

CREATE TABLE IF NOT EXISTS octo.workspace_databases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Exactly one provisioned database per workspace.
    workspace_id UUID NOT NULL UNIQUE REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    -- Server-generated identifiers, unique across the cluster. Quoted when used
    -- as DDL identifiers; never accepted from a request body.
    db_name TEXT NOT NULL UNIQUE,
    role_name TEXT NOT NULL UNIQUE,
    -- Only `active` exists in this slice; no other lifecycle state is modelled.
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active')),
    created_by UUID NOT NULL REFERENCES octo.principals(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_databases_workspace_id
    ON octo.workspace_databases(workspace_id);

ALTER TABLE octo.workspace_databases ENABLE ROW LEVEL SECURITY;

-- Members may see and create the catalog row for their own workspace. The route
-- additionally requires membership before provisioning, so this policy is the
-- engine-level backstop rather than the authority.
CREATE POLICY workspace_databases_select_member ON octo.workspace_databases
    FOR SELECT
    USING (octo.is_workspace_member(workspace_id) = true OR created_by = octo.current_principal_id());

CREATE POLICY workspace_databases_insert_member ON octo.workspace_databases
    FOR INSERT
    WITH CHECK (octo.is_workspace_member(workspace_id) = true OR created_by = octo.current_principal_id());

-- Same RESTRICTIVE tenant fence as the other tenant tables (slice 14): a
-- workspace-scoped key can only touch its own workspace's row.
CREATE POLICY tenant_scope_fence ON octo.workspace_databases
    AS RESTRICTIVE
    FOR ALL
    USING (octo.current_workspace_id() IS NULL OR workspace_id = octo.current_workspace_id())
    WITH CHECK (octo.current_workspace_id() IS NULL OR workspace_id = octo.current_workspace_id());

-- DML only: TRUNCATE and REFERENCES are not subject to row security.
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.workspace_databases TO authenticated;
