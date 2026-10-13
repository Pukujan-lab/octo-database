-- Octo Schema: Slice 4 - Scoped share links
-- A share grants read-only access to exactly one target resource for anyone holding
-- a high-entropy token. The raw token is never stored; only its SHA-256 hash is.

CREATE TABLE IF NOT EXISTS octo.shares (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    -- Target resource. 'gallery' with a NULL resource_id means the whole workspace
    -- gallery; a resource_id narrows the share to one album/folder.
    resource_type TEXT NOT NULL CHECK (resource_type IN ('gallery', 'album', 'folder')),
    resource_id TEXT,
    token_hash TEXT UNIQUE NOT NULL,
    token_prefix TEXT NOT NULL,
    permission TEXT NOT NULL CHECK (permission IN ('read', 'upload')) DEFAULT 'read',
    valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_until TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_by UUID NOT NULL REFERENCES octo.principals(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_accessed_at TIMESTAMPTZ,
    access_count BIGINT NOT NULL DEFAULT 0,
    CONSTRAINT shares_expiry_after_start CHECK (valid_until IS NULL OR valid_until > valid_from)
);

CREATE INDEX IF NOT EXISTS idx_shares_workspace_id ON octo.shares(workspace_id);
CREATE INDEX IF NOT EXISTS idx_shares_token_hash ON octo.shares(token_hash);

ALTER TABLE octo.shares ENABLE ROW LEVEL SECURITY;

-- Only workspace owners and admins may see or manage a workspace's shares.
CREATE POLICY shares_select_owner_admin ON octo.shares
    FOR SELECT
    USING (octo.get_workspace_role(workspace_id) IN ('owner', 'admin'));

CREATE POLICY shares_insert_owner_admin ON octo.shares
    FOR INSERT
    WITH CHECK (
        octo.get_workspace_role(workspace_id) IN ('owner', 'admin')
        AND created_by = octo.current_principal_id()
    );

-- Revocation is an UPDATE of revoked_at; only owner/admin may perform it.
CREATE POLICY shares_update_owner_admin ON octo.shares
    FOR UPDATE
    USING (octo.get_workspace_role(workspace_id) IN ('owner', 'admin'))
    WITH CHECK (octo.get_workspace_role(workspace_id) IN ('owner', 'admin'));

CREATE POLICY shares_delete_owner_admin ON octo.shares
    FOR DELETE
    USING (octo.get_workspace_role(workspace_id) IN ('owner', 'admin'));

-- Resolves a share by token hash for anonymous recipients.
-- SECURITY DEFINER is required because the caller has no session and therefore no
-- membership row. Disclosure is gated on possessing the high-entropy token itself,
-- and only share metadata is returned -- never the hash, and never principal data.
CREATE OR REPLACE FUNCTION octo.resolve_share(target_hash TEXT)
RETURNS TABLE (
    share_id UUID,
    workspace_id UUID,
    resource_type TEXT,
    resource_id TEXT,
    permission TEXT,
    valid_until TIMESTAMPTZ
) AS $$
BEGIN
    UPDATE octo.shares s
    SET last_accessed_at = now(), access_count = s.access_count + 1
    WHERE s.token_hash = target_hash
      AND s.revoked_at IS NULL
      AND s.valid_from <= now()
      AND (s.valid_until IS NULL OR s.valid_until > now());

    RETURN QUERY
    SELECT s.id, s.workspace_id, s.resource_type, s.resource_id, s.permission, s.valid_until
    FROM octo.shares s
    WHERE s.token_hash = target_hash
      AND s.revoked_at IS NULL
      AND s.valid_from <= now()
      AND (s.valid_until IS NULL OR s.valid_until > now())
    LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- DML only: TRUNCATE and REFERENCES are not subject to row security.
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.shares TO authenticated;
GRANT EXECUTE ON FUNCTION octo.resolve_share(TEXT) TO anon, authenticated;
