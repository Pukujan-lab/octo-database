-- Credential egress routes and temp working keys.
--
-- A route is one vendor-facing base URL for a stored credential, with the
-- auth scheme the vendor expects. One item can have many routes (the same
-- key behind five interchangeable edge bases, or API vs management URLs).
-- A lease is one Octo-minted working key (octo_tmp_…) per agent grant per
-- item: it terminates at Octo's relay, which injects the real secret and
-- forwards upstream. The real secret never leaves Octo.
--
-- A lease's parent grant is ON DELETE CASCADE: revoking the grant kills its
-- leases. Grant expiry does not delete the row — expiry is time, deletion is
-- intent — and an expired lease simply stops resolving.

CREATE TABLE IF NOT EXISTS octo.vault_routes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_id UUID NOT NULL REFERENCES octo.principals(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES octo.vault_items(id) ON DELETE CASCADE,
    route_key TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL,
    auth_scheme TEXT NOT NULL CHECK (auth_scheme IN
        ('bearer', 'x-api-key', 'basic', 'query', 'body_json', 'path')),
    auth_header TEXT,
    body_field TEXT,
    basic_username TEXT,
    health_status TEXT NOT NULL DEFAULT 'unknown' CHECK (health_status IN
        ('unknown', 'ok', 'unauthorized', 'forbidden_group', 'unreachable')),
    health_detail TEXT,
    last_health_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT vault_route_scheme_fields CHECK (
        (auth_scheme = 'x-api-key' AND auth_header IS NOT NULL)
        OR (auth_scheme = 'query' AND auth_header IS NOT NULL)
        OR (auth_scheme = 'body_json' AND body_field IS NOT NULL)
        OR (auth_scheme = 'path' AND body_field IS NOT NULL)
        OR auth_scheme IN ('bearer', 'basic')
    )
);

CREATE INDEX IF NOT EXISTS idx_vault_routes_item ON octo.vault_routes(item_id);

CREATE TABLE IF NOT EXISTS octo.vault_leases (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_id UUID NOT NULL REFERENCES octo.principals(id) ON DELETE CASCADE,
    item_id UUID NOT NULL REFERENCES octo.vault_items(id) ON DELETE CASCADE,
    parent_grant_id UUID NOT NULL REFERENCES octo.vault_grants(id) ON DELETE CASCADE,
    key_hash TEXT UNIQUE NOT NULL,
    prefix TEXT NOT NULL,
    name TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_vault_leases_principal ON octo.vault_leases(principal_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_leases_active
    ON octo.vault_leases(parent_grant_id, item_id) WHERE revoked_at IS NULL;

ALTER TABLE octo.vault_items ADD COLUMN IF NOT EXISTS url_kind TEXT
    CHECK (url_kind IN ('api_base', 'api_endpoint', 'docs', 'console', 'cors', 's3_endpoint'));

ALTER TABLE octo.vault_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE octo.vault_leases ENABLE ROW LEVEL SECURITY;

CREATE POLICY vault_routes_select_own ON octo.vault_routes
    FOR SELECT
    USING (principal_id = octo.current_principal_id());

CREATE POLICY vault_routes_insert_own ON octo.vault_routes
    FOR INSERT
    WITH CHECK (principal_id = octo.current_principal_id());

CREATE POLICY vault_routes_update_own ON octo.vault_routes
    FOR UPDATE
    USING (principal_id = octo.current_principal_id())
    WITH CHECK (principal_id = octo.current_principal_id());

CREATE POLICY vault_routes_delete_own ON octo.vault_routes
    FOR DELETE
    USING (principal_id = octo.current_principal_id());

CREATE POLICY vault_leases_select_own ON octo.vault_leases
    FOR SELECT
    USING (principal_id = octo.current_principal_id());

CREATE POLICY vault_leases_update_own ON octo.vault_leases
    FOR UPDATE
    USING (principal_id = octo.current_principal_id())
    WITH CHECK (principal_id = octo.current_principal_id());

CREATE POLICY vault_leases_delete_own ON octo.vault_leases
    FOR DELETE
    USING (principal_id = octo.current_principal_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON octo.vault_routes TO authenticated;
GRANT SELECT, UPDATE, DELETE ON octo.vault_leases TO authenticated;

-- Bearer lookup for a working key against one route. No session exists on the
-- relay path, so this is SECURITY DEFINER like octo.consume_vault_grant. The
-- route is joined inside: a lease can never be paired with another item's
-- route. Revoked, expired, or wrong-route all yield no row.
CREATE OR REPLACE FUNCTION octo.consume_vault_lease(target_hash TEXT, target_route_key TEXT)
RETURNS TABLE (
    lease_id UUID,
    principal_id UUID,
    item_id UUID,
    route_id UUID,
    base_url TEXT,
    auth_scheme TEXT,
    auth_header TEXT,
    body_field TEXT,
    basic_username TEXT,
    item_username TEXT,
    secret_encrypted TEXT,
    expires_at TIMESTAMPTZ
) AS $$
BEGIN
    UPDATE octo.vault_leases AS l
    SET last_used_at = now()
    WHERE l.key_hash = target_hash
      AND l.revoked_at IS NULL
      AND l.expires_at > now();

    RETURN QUERY
    SELECT
        l.id,
        l.principal_id,
        l.item_id,
        r.id,
        r.base_url,
        r.auth_scheme,
        r.auth_header,
        r.body_field,
        r.basic_username,
        i.username,
        i.secret_encrypted,
        l.expires_at
    FROM octo.vault_leases l
    JOIN octo.vault_routes r ON r.item_id = l.item_id AND r.route_key = target_route_key
    JOIN octo.vault_items i ON i.id = l.item_id
    WHERE l.key_hash = target_hash
      AND l.revoked_at IS NULL
      AND l.expires_at > now()
    LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION octo.consume_vault_lease(TEXT, TEXT) TO anon, authenticated;
