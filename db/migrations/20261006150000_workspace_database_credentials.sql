-- Octo Schema: provisioned-database credentials (Slice 21)
--
-- Slice 20 provisions a real PostgreSQL database per workspace and returns the
-- client's connection string exactly once. The SQL surface
-- (POST /api/workspaces/:id/query) lets a client run SQL through its Octo API key
-- with no connection string, hostname, or IP -- which means the server itself must
-- authenticate as the workspace's own role. It cannot run client SQL as the
-- privileged provisioning credential: that connection is a superuser, and the
-- client's own SQL could `RESET ROLE` back to it and reach the whole cluster.
--
-- So the workspace role's password is kept here, encrypted with the platform's
-- existing AES-256-GCM envelope (src/lib/mfa.ts, keyed from OCTO_MFA_SECRET). This
-- is deliberately a separate table from octo.workspace_databases: that table is the
-- tenant-visible catalog and stores no credential; this one is control-plane secret
-- material, read only on the trusted service pool.
--
-- RLS is enabled with NO policies, so every role subject to row security is denied
-- by default. Only `octo_service` (BYPASSRLS) is granted access -- the same trusted
-- path the per-principal MFA secret uses. A fenced request role must never read it.

CREATE TABLE IF NOT EXISTS octo.workspace_database_credentials (
    -- One credential per workspace; the row follows the workspace out.
    workspace_id UUID PRIMARY KEY REFERENCES octo.workspaces(id) ON DELETE CASCADE,
    -- `iv.tag.ciphertext`, base64. Never the plaintext password.
    password_encrypted TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE octo.workspace_database_credentials ENABLE ROW LEVEL SECURITY;

-- No policies: deny-by-default under RLS. The server reads and writes this table
-- only on the service pool (BYPASSRLS), which is why the grant names octo_service
-- directly rather than `authenticated` -- granting to `authenticated` would let the
-- fenced app pool read every workspace's database credential.
GRANT SELECT, INSERT, UPDATE, DELETE ON octo.workspace_database_credentials TO octo_service;
