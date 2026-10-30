-- Octo Schema: API key use log and leak alerts (issue #362)
--
-- `agent_key_uses` is an append-only row per bearer-key presentation: the key,
-- the caller's source IP (X-Forwarded-For, which Caddy sets from Cloudflare's
-- Cf-Connecting-Ip since #374), the route and the outcome. Outcomes other than
-- 'ok' are a revoked or expired key being presented, which the server alerts on.
--
-- Revoking a key deletes its `api_keys` row, so `revoked_api_keys` keeps the hash
-- of every deleted key (filled by a trigger) to tell a revoked key apart from a
-- random string.
--
-- Both tables are trusted-path only: RLS with no policies denies every role
-- subject to row security, and only `octo_service` (BYPASSRLS) reads or writes
-- them (same pattern as the OAuth tables).

CREATE TABLE IF NOT EXISTS octo.agent_key_uses (
    id BIGSERIAL PRIMARY KEY,
    key_id UUID NOT NULL,
    principal_id UUID,
    used_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    source_ip TEXT,
    method TEXT,
    route TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN ('ok', 'revoked', 'expired'))
);

CREATE INDEX IF NOT EXISTS agent_key_uses_key_time
    ON octo.agent_key_uses (key_id, used_at);
CREATE INDEX IF NOT EXISTS agent_key_uses_key_ip
    ON octo.agent_key_uses (key_id, source_ip);

CREATE TABLE IF NOT EXISTS octo.revoked_api_keys (
    key_hash TEXT PRIMARY KEY,
    key_id UUID NOT NULL,
    prefix TEXT,
    principal_id UUID,
    revoked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE octo.agent_key_uses ENABLE ROW LEVEL SECURITY;
ALTER TABLE octo.revoked_api_keys ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.agent_key_uses TO octo_service;
GRANT USAGE ON SEQUENCE octo.agent_key_uses_id_seq TO octo_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.revoked_api_keys TO octo_service;

-- SECURITY DEFINER: the revoke route deletes on the fenced request role, which
-- cannot write the trusted-path table itself.
CREATE OR REPLACE FUNCTION octo.remember_revoked_api_key()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = octo, pg_temp
AS $$
BEGIN
    INSERT INTO octo.revoked_api_keys (key_hash, key_id, prefix, principal_id)
    VALUES (OLD.key_hash, OLD.id, OLD.prefix, OLD.principal_id)
    ON CONFLICT (key_hash) DO NOTHING;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS api_keys_remember_revoked ON octo.api_keys;
CREATE TRIGGER api_keys_remember_revoked
    AFTER DELETE ON octo.api_keys
    FOR EACH ROW EXECUTE FUNCTION octo.remember_revoked_api_key();
