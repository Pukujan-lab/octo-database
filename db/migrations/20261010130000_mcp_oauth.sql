-- OAuth 2.1 authorization server for the remote MCP endpoint.
--
-- A custom MCP connector (ChatGPT, Claude, ...) reaches /mcp either with a
-- bearer key or through OAuth. These three tables hold the server side of the
-- OAuth dance: registered clients, one-time authorization codes, and refresh
-- tokens. Access tokens are stateless HMAC JWTs (src/lib/oauth-token.ts), so
-- there is deliberately no access-token table.
--
-- These are server-owned credential rows, read and written only on the trusted
-- service path (registration, code exchange, refresh) before any request
-- identity is bound, exactly like api_keys and confirm_secret_hash. They
-- therefore carry no RLS policy: the fence is keyed on a bound principal, and
-- nothing here is ever read by a bound identity.
--
-- That trusted-path intent has to be enforced, not assumed. This schema grants
-- DML on every new table to `authenticated` (ALTER DEFAULT PRIVILEGES in the
-- Slice 1 migration), and the fenced request role `octo_app` inherits it, so
-- without a fence a request-path caller could read live authorization codes and
-- refresh tokens. RLS with no policies is what closes that: every role subject
-- to row security is denied by default, and only `octo_service` (BYPASSRLS)
-- reads these tables. The grant is repeated to `octo_service` directly for the
-- same reason Slice 21 does it -- and the access must NOT be taken back from
-- `authenticated`, because `octo_service` is a member of `authenticated` and a
-- REVOKE there would strip the trusted path's access too.

CREATE TABLE IF NOT EXISTS octo.oauth_clients (
    client_id TEXT PRIMARY KEY,
    client_name TEXT,
    redirect_uris TEXT[] NOT NULL,
    -- 'none' for a public client (PKCE mandatory), or 'client_secret_post'.
    token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none',
    -- SHA-256 of the issued client secret; NULL for public clients. The raw
    -- secret is returned once at registration and never stored.
    client_secret_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS octo.oauth_auth_codes (
    -- SHA-256 of the code, so a raw single-use credential never lands in the
    -- table. Claiming a code is a conditional UPDATE on `consumed_at`, which
    -- makes redemption single-use even under concurrent exchange attempts.
    code_hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    principal_id UUID NOT NULL REFERENCES octo.principals(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    code_challenge_method TEXT NOT NULL,
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_auth_codes_expires_idx
    ON octo.oauth_auth_codes (expires_at);

CREATE TABLE IF NOT EXISTS octo.oauth_refresh_tokens (
    token_hash TEXT PRIMARY KEY,
    -- The chain this token belongs to. Rotating a refresh token marks the old
    -- one revoked and issues a successor in the same family; presenting an
    -- already-rotated token is replay, and the whole family is revoked.
    family_id UUID NOT NULL,
    client_id TEXT NOT NULL,
    principal_id UUID NOT NULL REFERENCES octo.principals(id) ON DELETE CASCADE,
    workspace_id UUID NOT NULL REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    resource TEXT NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS oauth_refresh_tokens_family_idx
    ON octo.oauth_refresh_tokens (family_id);

ALTER TABLE octo.oauth_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE octo.oauth_auth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE octo.oauth_refresh_tokens ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON octo.oauth_clients TO octo_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.oauth_auth_codes TO octo_service;
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.oauth_refresh_tokens TO octo_service;
