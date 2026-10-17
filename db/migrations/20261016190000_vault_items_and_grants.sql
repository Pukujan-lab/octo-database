-- Account-wide and workspace-assigned password-manager cabinet, plus the
-- temporary grants an agent pastes to read one cabinet.
--
-- Secret columns hold the AES-256-GCM envelope from src/lib/mfa.ts
-- (OCTO_MFA_SECRET). They are never plaintext.
-- A grant with workspace_id NULL reads the account cabinet only.
-- A decoy grant is consumed through octo.consume_vault_grant, which records
-- the trip. The agent-facing payload is built in the route and never selects
-- the real secret for a decoy.

CREATE TABLE IF NOT EXISTS octo.vault_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_id UUID NOT NULL REFERENCES octo.principals(id) ON DELETE CASCADE,
    workspace_id UUID REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    label TEXT NOT NULL,
    description TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('login', 'token', 'url', 'note')),
    username TEXT,
    url TEXT,
    secret_encrypted TEXT,
    notes_encrypted TEXT,
    health_status TEXT NOT NULL DEFAULT 'unchecked' CHECK (health_status IN ('unchecked', 'healthy', 'weak', 'stale')),
    health_detail TEXT,
    last_health_at TIMESTAMPTZ,
    stale_since TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vault_items_principal ON octo.vault_items(principal_id);
CREATE INDEX IF NOT EXISTS idx_vault_items_workspace ON octo.vault_items(workspace_id);

CREATE TABLE IF NOT EXISTS octo.vault_grants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_id UUID NOT NULL REFERENCES octo.principals(id) ON DELETE CASCADE,
    workspace_id UUID REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    parent_grant_id UUID REFERENCES octo.vault_grants(id) ON DELETE CASCADE,
    key_hash TEXT UNIQUE NOT NULL,
    prefix TEXT NOT NULL,
    name TEXT NOT NULL,
    decoy BOOLEAN NOT NULL DEFAULT false,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    tripped_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_vault_grants_principal ON octo.vault_grants(principal_id);
CREATE INDEX IF NOT EXISTS idx_vault_grants_key_hash ON octo.vault_grants(key_hash);

ALTER TABLE octo.vault_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE octo.vault_grants ENABLE ROW LEVEL SECURITY;

CREATE POLICY vault_items_select_own ON octo.vault_items
    FOR SELECT
    USING (principal_id = octo.current_principal_id());

CREATE POLICY vault_items_insert_own ON octo.vault_items
    FOR INSERT
    WITH CHECK (
        principal_id = octo.current_principal_id()
        AND (workspace_id IS NULL OR octo.is_workspace_member(workspace_id) = true)
    );

CREATE POLICY vault_items_update_own ON octo.vault_items
    FOR UPDATE
    USING (principal_id = octo.current_principal_id())
    WITH CHECK (principal_id = octo.current_principal_id());

CREATE POLICY vault_items_delete_own ON octo.vault_items
    FOR DELETE
    USING (principal_id = octo.current_principal_id());

CREATE POLICY vault_grants_select_own ON octo.vault_grants
    FOR SELECT
    USING (principal_id = octo.current_principal_id());

CREATE POLICY vault_grants_insert_own ON octo.vault_grants
    FOR INSERT
    WITH CHECK (
        principal_id = octo.current_principal_id()
        AND (workspace_id IS NULL OR octo.is_workspace_member(workspace_id) = true)
    );

CREATE POLICY vault_grants_delete_own ON octo.vault_grants
    FOR DELETE
    USING (principal_id = octo.current_principal_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON octo.vault_items TO authenticated;
GRANT SELECT, INSERT, DELETE ON octo.vault_grants TO authenticated;

-- Bearer lookup for a grant. There is no session yet, so this is SECURITY
-- DEFINER like octo.verify_api_key. A decoy's first use stamps tripped_at.
CREATE OR REPLACE FUNCTION octo.consume_vault_grant(target_hash TEXT)
RETURNS TABLE (
    grant_id UUID,
    principal_id UUID,
    workspace_id UUID,
    prefix TEXT,
    grant_name TEXT,
    decoy BOOLEAN,
    expires_at TIMESTAMPTZ,
    tripped_at TIMESTAMPTZ
) AS $$
BEGIN
    UPDATE octo.vault_grants AS g
    SET last_used_at = now(),
        tripped_at = CASE
            WHEN g.decoy AND g.tripped_at IS NULL THEN now()
            ELSE g.tripped_at
        END
    WHERE g.key_hash = target_hash
      AND g.expires_at > now();

    RETURN QUERY
    SELECT
        g.id,
        g.principal_id,
        g.workspace_id,
        g.prefix,
        g.name,
        g.decoy,
        g.expires_at,
        g.tripped_at
    FROM octo.vault_grants g
    WHERE g.key_hash = target_hash
      AND g.expires_at > now()
    LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION octo.consume_vault_grant(TEXT) TO anon, authenticated;
