-- Octo Schema: Slice 2 - Files and API Keys
-- Canonical tables for file catalog (R2 object metadata) and workspace/account-wide API keys.

-- 1. Extend Principals table with Guest support
ALTER TABLE octo.principals ADD COLUMN IF NOT EXISTS is_guest BOOLEAN NOT NULL DEFAULT false;

-- 2. Files: Logical file records backed by Cloudflare R2 active storage
CREATE TABLE IF NOT EXISTS octo.files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    created_by UUID NOT NULL REFERENCES octo.principals(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    provider TEXT NOT NULL DEFAULT 'r2',
    storage_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'deleted')) DEFAULT 'active',
    content_hash TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_files_workspace_id ON octo.files(workspace_id);
CREATE INDEX IF NOT EXISTS idx_files_created_by ON octo.files(created_by);
CREATE INDEX IF NOT EXISTS idx_files_storage_key ON octo.files(storage_key);

-- 3. API Keys: Account-wide and workspace-scoped machine/agent credentials
CREATE TABLE IF NOT EXISTS octo.api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    key_hash TEXT UNIQUE NOT NULL,
    prefix TEXT NOT NULL,
    name TEXT NOT NULL,
    principal_id UUID NOT NULL REFERENCES octo.principals(id) ON DELETE CASCADE,
    workspace_id UUID REFERENCES octo.workspaces(id) ON DELETE CASCADE, -- NULL = Account-wide API key
    role TEXT CHECK (role IN ('owner', 'admin', 'operator', 'member')),
    scopes TEXT[] NOT NULL DEFAULT ARRAY['read', 'write'],
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_principal_id ON octo.api_keys(principal_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON octo.api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_workspace_id ON octo.api_keys(workspace_id);

-- Enable Row-Level Security
ALTER TABLE octo.files ENABLE ROW LEVEL SECURITY;
ALTER TABLE octo.api_keys ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Files
-- Members can view active files in authorized workspaces
CREATE POLICY files_select_member ON octo.files
    FOR SELECT
    USING (octo.is_workspace_member(workspace_id) = true);

-- Members with role owner, admin, or operator can upload files
CREATE POLICY files_insert_member ON octo.files
    FOR INSERT
    WITH CHECK (
        octo.is_workspace_member(workspace_id) = true
        AND octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator')
        AND created_by = octo.current_principal_id()
    );

-- Only workspace owners or admins can update file metadata
CREATE POLICY files_update_owner_admin ON octo.files
    FOR UPDATE
    USING (octo.get_workspace_role(workspace_id) IN ('owner', 'admin'))
    WITH CHECK (octo.get_workspace_role(workspace_id) IN ('owner', 'admin'));

-- Only workspace owners or admins can delete files
CREATE POLICY files_delete_owner_admin ON octo.files
    FOR DELETE
    USING (octo.get_workspace_role(workspace_id) IN ('owner', 'admin'));

-- Role ranking helper so a key's role can never exceed the creator's live role.
CREATE OR REPLACE FUNCTION octo.role_rank(target_role TEXT)
RETURNS INT AS $$
    SELECT CASE target_role
        WHEN 'owner' THEN 4
        WHEN 'admin' THEN 3
        WHEN 'operator' THEN 2
        WHEN 'member' THEN 1
        ELSE 0
    END;
$$ LANGUAGE sql IMMUTABLE;

-- RLS Policies: API Keys
-- Users can only view their own API keys
CREATE POLICY api_keys_select_own ON octo.api_keys
    FOR SELECT
    USING (principal_id = octo.current_principal_id());

-- Users can create API keys for themselves, but a key can never carry more
-- authority than the creator actually holds:
--   * account-wide keys must leave `role` NULL, so authority is derived from the
--     principal's live memberships at call time rather than asserted by the key;
--   * workspace-scoped keys may set a role only up to the creator's role there.
CREATE POLICY api_keys_insert_own ON octo.api_keys
    FOR INSERT
    WITH CHECK (
        principal_id = octo.current_principal_id()
        AND (
            (workspace_id IS NULL AND role IS NULL)
            OR (
                octo.is_workspace_member(workspace_id) = true
                AND (
                    role IS NULL
                    OR octo.role_rank(role) <= octo.role_rank(octo.get_workspace_role(workspace_id))
                )
            )
        )
    );

-- Users can delete their own API keys
CREATE POLICY api_keys_delete_own ON octo.api_keys
    FOR DELETE
    USING (principal_id = octo.current_principal_id());

-- Grants
-- DML only. TRUNCATE and REFERENCES are NOT subject to row security, so granting
-- ALL would let any authenticated caller wipe every row with RLS still "enabled".
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.files TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.api_keys TO authenticated;

-- Helper functions for API Key authentication
-- SECURITY DEFINER allows callers without a pre-existing session to verify bearer keys
CREATE OR REPLACE FUNCTION octo.verify_api_key(target_hash TEXT)
RETURNS TABLE (
    key_id UUID,
    prefix TEXT,
    key_name TEXT,
    principal_id UUID,
    workspace_id UUID,
    role TEXT,
    scopes TEXT[],
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ
) AS $$
BEGIN
    UPDATE octo.api_keys
    SET last_used_at = now()
    WHERE key_hash = target_hash
      AND (octo.api_keys.expires_at IS NULL OR octo.api_keys.expires_at > now());

    RETURN QUERY
    SELECT
        k.id,
        k.prefix,
        k.name,
        k.principal_id,
        k.workspace_id,
        k.role,
        k.scopes,
        k.expires_at,
        k.created_at
    FROM octo.api_keys k
    WHERE k.key_hash = target_hash
      AND (k.expires_at IS NULL OR k.expires_at > now())
    LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Principal fields are deliberately NOT exposed through a separate function: an
-- anon-grantable lookup by UUID would let anyone with the public anon key read any
-- principal's email, avatar, and platform-owner flag. Key holders get the principal
-- id from verify_api_key and resolve it server-side instead.
GRANT EXECUTE ON FUNCTION octo.verify_api_key(TEXT) TO anon, authenticated;
