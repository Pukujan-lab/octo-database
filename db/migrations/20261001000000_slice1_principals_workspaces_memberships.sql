-- Octo Schema: Slice 1 - Principals, Workspaces, and Memberships
-- Canonical tables and Row-Level Security policies.

CREATE SCHEMA IF NOT EXISTS octo;

-- 1. Principals: Canonical identity records mapped from authentication providers
CREATE TABLE IF NOT EXISTS octo.principals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_user_id UUID UNIQUE NOT NULL,
    email TEXT NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    is_platform_owner BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_principals_auth_user_id ON octo.principals(auth_user_id);
CREATE INDEX IF NOT EXISTS idx_principals_email ON octo.principals(email);

-- 2. Workspaces: Top-level isolation boundary for user content, files, and agents
CREATE TABLE IF NOT EXISTS octo.workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    created_by UUID NOT NULL REFERENCES octo.principals(id) ON DELETE RESTRICT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspaces_slug ON octo.workspaces(slug);
CREATE INDEX IF NOT EXISTS idx_workspaces_created_by ON octo.workspaces(created_by);

-- 3. Workspace Memberships: Canonical role mapping per workspace
CREATE TABLE IF NOT EXISTS octo.workspace_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    principal_id UUID NOT NULL REFERENCES octo.principals(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'operator', 'member')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_workspace_principal UNIQUE (workspace_id, principal_id)
);

CREATE INDEX IF NOT EXISTS idx_memberships_workspace_id ON octo.workspace_memberships(workspace_id);
CREATE INDEX IF NOT EXISTS idx_memberships_principal_id ON octo.workspace_memberships(principal_id);

-- Helper functions for Row-Level Security

-- Resolves the current principal ID from the calling session auth.uid()
CREATE OR REPLACE FUNCTION octo.current_principal_id()
RETURNS UUID AS $$
    SELECT id FROM octo.principals
    WHERE auth_user_id = auth.uid()
    LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Returns true if the calling session is a member of the given workspace
CREATE OR REPLACE FUNCTION octo.is_workspace_member(target_workspace_id UUID)
RETURNS BOOLEAN AS $$
    SELECT EXISTS (
        SELECT 1 FROM octo.workspace_memberships
        WHERE workspace_id = target_workspace_id
          AND principal_id = octo.current_principal_id()
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Returns the role of the calling session in the given workspace, or NULL
CREATE OR REPLACE FUNCTION octo.get_workspace_role(target_workspace_id UUID)
RETURNS TEXT AS $$
    SELECT role FROM octo.workspace_memberships
    WHERE workspace_id = target_workspace_id
      AND principal_id = octo.current_principal_id()
    LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- Enable Row-Level Security on all tables (fail-closed default)
ALTER TABLE octo.principals ENABLE ROW LEVEL SECURITY;
ALTER TABLE octo.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE octo.workspace_memberships ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Principals
-- Users can only see their own principal profile
CREATE POLICY principals_select_own ON octo.principals
    FOR SELECT
    USING (auth_user_id = auth.uid() OR id = octo.current_principal_id());

-- Authenticated users can insert their own initial principal record on first login
-- Client cannot self-promote to platform owner
CREATE POLICY principals_insert_own ON octo.principals
    FOR INSERT
    WITH CHECK (auth_user_id = auth.uid() AND is_platform_owner = false);

-- Users can update their own display name / avatar (cannot self-promote to platform owner)
CREATE POLICY principals_update_own ON octo.principals
    FOR UPDATE
    USING (auth_user_id = auth.uid())
    WITH CHECK (auth_user_id = auth.uid() AND is_platform_owner = false);

-- RLS Policies: Workspaces
-- Users can only see workspaces where they hold active membership
CREATE POLICY workspaces_select_member ON octo.workspaces
    FOR SELECT
    USING (octo.is_workspace_member(id) = true OR created_by = octo.current_principal_id());

-- Authenticated principals can create a workspace (they become owner via transaction)
CREATE POLICY workspaces_insert_authenticated ON octo.workspaces
    FOR INSERT
    WITH CHECK (created_by = octo.current_principal_id());

-- Only workspace owners or admins can update workspace metadata
CREATE POLICY workspaces_update_owner_admin ON octo.workspaces
    FOR UPDATE
    USING (octo.get_workspace_role(id) IN ('owner', 'admin'))
    WITH CHECK (octo.get_workspace_role(id) IN ('owner', 'admin'));

-- Only workspace owner can delete a workspace
CREATE POLICY workspaces_delete_owner ON octo.workspaces
    FOR DELETE
    USING (octo.get_workspace_role(id) = 'owner');

-- RLS Policies: Workspace Memberships
-- Members can view memberships within their own workspaces
CREATE POLICY memberships_select_member ON octo.workspace_memberships
    FOR SELECT
    USING (octo.is_workspace_member(workspace_id) = true);

-- Workspace creators can insert their initial owner membership;
-- existing workspace owners and admins can invite or add members.
CREATE POLICY memberships_insert_owner_admin ON octo.workspace_memberships
    FOR INSERT
    WITH CHECK (
        (principal_id = octo.current_principal_id()
         AND role = 'owner'
         AND EXISTS (
             SELECT 1 FROM octo.workspaces
             WHERE id = workspace_id AND created_by = octo.current_principal_id()
         ))
        OR
        (octo.get_workspace_role(workspace_id) IN ('owner', 'admin'))
    );

CREATE POLICY memberships_update_owner_admin ON octo.workspace_memberships
    FOR UPDATE
    USING (octo.get_workspace_role(workspace_id) IN ('owner', 'admin'))
    WITH CHECK (octo.get_workspace_role(workspace_id) IN ('owner', 'admin'));

CREATE POLICY memberships_delete_owner_admin ON octo.workspace_memberships
    FOR DELETE
    USING (octo.get_workspace_role(workspace_id) IN ('owner', 'admin'));

-- Schema and Table Grants
-- Grants USAGE on schema octo and table permissions to authenticated role.
-- Row-Level Security remains active and enforces authorization per row.
GRANT USAGE ON SCHEMA octo TO anon, authenticated;
-- DML only: TRUNCATE and REFERENCES are not subject to row security, so an
-- `ALL` grant would let any authenticated caller wipe every row despite RLS.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA octo TO authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA octo TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA octo GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA octo GRANT USAGE, SELECT ON SEQUENCES TO authenticated;
