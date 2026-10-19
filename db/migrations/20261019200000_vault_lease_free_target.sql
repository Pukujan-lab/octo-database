-- A working key becomes a free-form proxy credential.
--
-- Before this, a lease could only be spent on one route's base URL, so an
-- imported token with no url could not be used at all, and the first route an
-- agent guessed pinned the item permanently (issue #289). The lease now records
-- how to inject the secret (scheme + header/field/username) and an optional
-- default upstream; the caller names the upstream per request on
-- /api/vault/proxy. A route is a convenience, not a requirement.

ALTER TABLE octo.vault_leases
    ADD COLUMN IF NOT EXISTS base_url TEXT,
    ADD COLUMN IF NOT EXISTS auth_scheme TEXT NOT NULL DEFAULT 'bearer'
        CHECK (auth_scheme IN ('bearer', 'x-api-key', 'basic', 'query', 'body_json', 'path')),
    ADD COLUMN IF NOT EXISTS auth_header TEXT,
    ADD COLUMN IF NOT EXISTS body_field TEXT,
    ADD COLUMN IF NOT EXISTS basic_username TEXT;

-- Resolve a working key without naming a route. Falls back to the item's own
-- url when the lease carries no default upstream. Service path: no session.
CREATE OR REPLACE FUNCTION octo.consume_vault_lease_by_key(target_hash TEXT)
RETURNS TABLE (
    lease_id UUID,
    principal_id UUID,
    item_id UUID,
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
        COALESCE(l.base_url, i.url),
        l.auth_scheme,
        l.auth_header,
        l.body_field,
        l.basic_username,
        i.username,
        i.secret_encrypted,
        l.expires_at
    FROM octo.vault_leases l
    JOIN octo.vault_items i ON i.id = l.item_id
    WHERE l.key_hash = target_hash
      AND l.revoked_at IS NULL
      AND l.expires_at > now()
    LIMIT 1;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

GRANT EXECUTE ON FUNCTION octo.consume_vault_lease_by_key(TEXT) TO anon, authenticated;
