-- Octo Schema: Slice 14 - Key-scope isolation fence
--
-- Makes Row-Level Security actually enforce on the server's own database path.
--
-- Background (issue #111): the server connected as the `postgres` superuser and
-- never set `request.jwt.claim.sub`, so every policy evaluated against a NULL
-- identity and RLS never filtered. Isolation rested entirely on hand-written
-- predicates in application code.
--
-- This migration:
--   1. creates a non-superuser runtime role (`octo_app`) so RLS applies to the
--      server's request path, and a `BYPASSRLS` service role (`octo_service`) for
--      the small trusted surface that runs without a caller identity (login /
--      bootstrap, the job worker, the archive lifecycle);
--   2. adds `octo.current_workspace_id()` and a RESTRICTIVE fence policy on every
--      tenant table so a workspace-scoped API key can only touch its own
--      workspace -- keyed on the KEY's scope, not the principal, because a scoped
--      key's principal is often legitimately a member of several workspaces;
--   3. preserves the platform owner's cross-workspace operator view by folding the
--      owner into the existing membership/role helpers, instead of editing every
--      policy.
--
-- Roles are created without passwords: passwords are set out-of-band (see the
-- OCTO_DB_URL / OCTO_SERVICE_URL entries in .env.example and
-- deploy/gravebuster/.env.example) so no credential is committed. Table ownership
-- is unchanged, so ordinary RLS applies to octo_app and `FORCE ROW LEVEL SECURITY`
-- is not required.

-- 1. Runtime roles -----------------------------------------------------------------

DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'octo_app') THEN
        CREATE ROLE octo_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE;
    END IF;
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'octo_service') THEN
        CREATE ROLE octo_service LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS;
    END IF;
END $$;

-- Inherit the existing table/function grants made to `authenticated`. Neither role
-- gains BYPASSRLS from this (only octo_service has it, and it was set explicitly).
GRANT authenticated TO octo_app, octo_service;
GRANT USAGE ON SCHEMA octo TO octo_app, octo_service;
GRANT USAGE ON SCHEMA auth TO octo_app, octo_service;

-- 2. Identity helpers --------------------------------------------------------------

-- The workspace scope of the current request, set only for workspace-scoped keys.
-- NULL means "unscoped" (account-wide key or human session), which the fence below
-- treats as "no restriction beyond the existing membership policy".
CREATE OR REPLACE FUNCTION octo.current_workspace_id()
RETURNS UUID AS $$
    SELECT NULLIF(current_setting('request.workspace_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- Direct principal binding. The server resolves the caller to a principal id in
-- `authenticateRequest` and sets this GUC on every fenced query. When present the
-- helpers take it; when absent (a Supabase-style JWT caller, or a legacy session)
-- we still fall back to the auth_user_id lookup so old paths keep working.
CREATE OR REPLACE FUNCTION octo.current_principal_id()
RETURNS UUID AS $$
    SELECT COALESCE(
        NULLIF(current_setting('octo.principal_id', true), '')::uuid,
        (SELECT id FROM octo.principals WHERE auth_user_id = auth.uid() LIMIT 1)
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- The platform owner is the single operator account. Folding it into the two
-- helpers below preserves its existing app-level cross-workspace view
-- (src/server/db.ts dbGetAuthorizedWorkspaces / dbGetWorkspaceMembership) without
-- editing every policy.
CREATE OR REPLACE FUNCTION octo.is_platform_owner()
RETURNS BOOLEAN AS $$
    SELECT COALESCE(
        (SELECT p.is_platform_owner FROM octo.principals p WHERE p.id = octo.current_principal_id()),
        false
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION octo.is_workspace_member(target_workspace_id UUID)
RETURNS BOOLEAN AS $$
    SELECT octo.is_platform_owner() OR EXISTS (
        SELECT 1 FROM octo.workspace_memberships
        WHERE workspace_id = target_workspace_id
          AND principal_id = octo.current_principal_id()
    );
$$ LANGUAGE sql STABLE SECURITY DEFINER;

CREATE OR REPLACE FUNCTION octo.get_workspace_role(target_workspace_id UUID)
RETURNS TEXT AS $$
    SELECT CASE
        WHEN octo.is_platform_owner() THEN 'owner'
        ELSE (
            SELECT role FROM octo.workspace_memberships
            WHERE workspace_id = target_workspace_id
              AND principal_id = octo.current_principal_id()
            LIMIT 1
        )
    END;
$$ LANGUAGE sql STABLE SECURITY DEFINER;

-- 3. The fence ---------------------------------------------------------------------
--
-- One RESTRICTIVE policy per tenant table. RESTRICTIVE policies are AND-combined
-- with the existing PERMISSIVE ones, so this can only narrow access -- it never
-- widens it, and it does not disturb the hand-written policies.
--
-- Predicate: when a request carries a workspace scope, every row it may see or
-- write must belong to that workspace. When no scope is set, the policy is inert.

DO $$
DECLARE
    t TEXT;
    tenant_tables TEXT[] := ARRAY[
        'files', 'shares', 'api_keys',
        'documents', 'document_versions', 'embedding_configs', 'chunks', 'embeddings',
        'epistemic_entities', 'evidence', 'claims', 'perspectives', 'beliefs',
        'claim_relations', 'claim_evidence',
        'jobs', 'activity'
    ];
BEGIN
    FOREACH t IN ARRAY tenant_tables LOOP
        -- A policy on a table without RLS enabled is inert, so the fence asserts its
        -- own precondition rather than trusting an earlier migration to have set it.
        -- Idempotent: re-enabling an already-enabled table is a no-op.
        EXECUTE format('ALTER TABLE octo.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS tenant_scope_fence ON octo.%I', t);
        EXECUTE format($fmt$
            CREATE POLICY tenant_scope_fence ON octo.%I
                AS RESTRICTIVE
                FOR ALL
                USING (octo.current_workspace_id() IS NULL OR workspace_id = octo.current_workspace_id())
                WITH CHECK (octo.current_workspace_id() IS NULL OR workspace_id = octo.current_workspace_id())
        $fmt$, t);
    END LOOP;
END $$;

-- `workspaces` and `workspace_memberships` key on the workspace id itself, not a
-- workspace_id column.
ALTER TABLE octo.workspaces ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope_fence ON octo.workspaces;
CREATE POLICY tenant_scope_fence ON octo.workspaces
    AS RESTRICTIVE
    FOR ALL
    USING (octo.current_workspace_id() IS NULL OR id = octo.current_workspace_id())
    WITH CHECK (octo.current_workspace_id() IS NULL OR id = octo.current_workspace_id());

ALTER TABLE octo.workspace_memberships ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope_fence ON octo.workspace_memberships;
CREATE POLICY tenant_scope_fence ON octo.workspace_memberships
    AS RESTRICTIVE
    FOR ALL
    USING (octo.current_workspace_id() IS NULL OR workspace_id = octo.current_workspace_id())
    WITH CHECK (octo.current_workspace_id() IS NULL OR workspace_id = octo.current_workspace_id());

-- 4. Policy completion -------------------------------------------------------------
--
-- The original policies were written for a trusted-server model and are
-- deliberately incomplete for a non-owner role. These are the verbs the server
-- actually uses that had no policy, so the app role does not lose working flows.

-- RAG re-ingest deletes and rewrites derived rows (src/server/db.ts
-- dbReplaceChunksAndEmbeddings). The service role bypasses RLS, but the request
-- path also runs these, so give operator+ the same DELETE authority the INSERT
-- policies already grant.
DROP POLICY IF EXISTS chunks_delete_operator ON octo.chunks;
CREATE POLICY chunks_delete_operator ON octo.chunks
    FOR DELETE
    USING (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'));

DROP POLICY IF EXISTS embeddings_delete_operator ON octo.embeddings;
CREATE POLICY embeddings_delete_operator ON octo.embeddings
    FOR DELETE
    USING (octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator'));

-- Key revocation and last_used bookkeeping run through SECURITY DEFINER today, but
-- an explicit UPDATE policy keeps a future non-definer revoke path working.
DROP POLICY IF EXISTS api_keys_update_own ON octo.api_keys;
CREATE POLICY api_keys_update_own ON octo.api_keys
    FOR UPDATE
    USING (principal_id = octo.current_principal_id())
    WITH CHECK (principal_id = octo.current_principal_id());
