"""Schema and RLS migration validation tests for Slice 14 (key-scope isolation fence).

These are static assertions on the migration SQL (no live database): they prove the
migration *declares* the two runtime roles, the workspace-scope fence, and the
policy completion the server needs to keep working under a non-owner role. The
live behaviour (that the fence actually denies a cross-workspace request) is proven
by scripts/verify-key-scope-fence.ts against a real database in CI.
"""

from __future__ import annotations

import unittest
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).parent.parent
    / "db"
    / "migrations"
    / "20261001080000_slice14_key_scope_isolation.sql"
)

# The tenant tables the fence must cover. `workspaces` and `workspace_memberships`
# are handled separately (they key on the workspace id itself, not a workspace_id
# column), so they are asserted on their own below.
FENCED_TENANT_TABLES = [
    "files",
    "shares",
    "api_keys",
    "documents",
    "document_versions",
    "embedding_configs",
    "chunks",
    "embeddings",
    "epistemic_entities",
    "evidence",
    "claims",
    "perspectives",
    "beliefs",
    "claim_relations",
    "claim_evidence",
    "jobs",
    "activity",
]


class Slice14SchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(MIGRATION_PATH.exists(), f"Migration file missing: {MIGRATION_PATH}")
        self.sql_content = MIGRATION_PATH.read_text(encoding="utf-8")

    def test_app_role_is_non_superuser_and_non_owner(self) -> None:
        # The request path runs as octo_app; RLS only applies to it if it is neither
        # a superuser nor the table owner.
        self.assertIn(
            "CREATE ROLE octo_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE",
            self.sql_content,
        )

    def test_service_role_bypasses_rls(self) -> None:
        # The trusted surface (login/bootstrap, the job worker, server-owned
        # jobs/activity writes) runs as octo_service, which bypasses RLS.
        self.assertIn(
            "CREATE ROLE octo_service LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE BYPASSRLS",
            self.sql_content,
        )

    def test_roles_are_created_without_passwords(self) -> None:
        # No credential value may be committed; passwords are set out-of-band.
        self.assertNotIn("PASSWORD", self.sql_content)

    def test_workspace_scope_helper_reads_the_request_guc(self) -> None:
        self.assertIn("CREATE OR REPLACE FUNCTION octo.current_workspace_id()", self.sql_content)
        self.assertIn("current_setting('request.workspace_id', true)", self.sql_content)

    def test_principal_helper_prefers_the_direct_binding(self) -> None:
        # Identity is bound directly via octo.principal_id, with the auth_user_id
        # lookup retained only as a fallback for legacy/un-migrated callers.
        self.assertIn("current_setting('octo.principal_id', true)", self.sql_content)
        self.assertIn("WHERE auth_user_id = auth.uid()", self.sql_content)

    def test_fence_is_restrictive_for_all(self) -> None:
        # RESTRICTIVE (not PERMISSIVE) so it can only narrow access and is AND-ed
        # with the existing hand-written policies.
        self.assertIn("AS RESTRICTIVE", self.sql_content)
        self.assertIn("FOR ALL", self.sql_content)
        self.assertIn(
            "USING (octo.current_workspace_id() IS NULL OR workspace_id = "
            "octo.current_workspace_id())",
            self.sql_content,
        )
        self.assertIn(
            "WITH CHECK (octo.current_workspace_id() IS NULL OR workspace_id = "
            "octo.current_workspace_id())",
            self.sql_content,
        )

    def test_fence_covers_every_tenant_table(self) -> None:
        for table in FENCED_TENANT_TABLES:
            self.assertIn(f"'{table}'", self.sql_content, f"tenant table not fenced: {table}")

    def test_fence_enables_rls_on_the_tables_it_covers(self) -> None:
        # A policy on a table without RLS enabled is inert, so the fence enables
        # RLS itself rather than trusting an earlier migration to have done it.
        self.assertIn("ENABLE ROW LEVEL SECURITY", self.sql_content)
        self.assertIn(
            "ALTER TABLE octo.workspaces ENABLE ROW LEVEL SECURITY",
            self.sql_content,
        )
        self.assertIn(
            "ALTER TABLE octo.workspace_memberships ENABLE ROW LEVEL SECURITY",
            self.sql_content,
        )

    def test_fence_covers_workspaces_and_memberships_by_id(self) -> None:
        self.assertIn("CREATE POLICY tenant_scope_fence ON octo.workspaces", self.sql_content)
        self.assertIn("id = octo.current_workspace_id()", self.sql_content)
        self.assertIn(
            "CREATE POLICY tenant_scope_fence ON octo.workspace_memberships",
            self.sql_content,
        )

    def test_principals_is_not_fenced(self) -> None:
        # Identity bootstrap must read principals before any scope is known, so it
        # is deliberately left out of the fence.
        self.assertNotIn("'principals'", self.sql_content)

    def test_policy_completion_for_server_write_verbs(self) -> None:
        # Re-ingest deletes derived rows and revoke updates the key, so those verbs
        # need a policy for the non-owner role to keep working.
        self.assertIn("CREATE POLICY chunks_delete_operator ON octo.chunks", self.sql_content)
        self.assertIn(
            "CREATE POLICY embeddings_delete_operator ON octo.embeddings",
            self.sql_content,
        )
        self.assertIn("CREATE POLICY api_keys_update_own ON octo.api_keys", self.sql_content)

    def test_jobs_and_activity_keep_select_only_policies(self) -> None:
        # The fence must not have widened the server-owned control tables: no
        # client-side INSERT/UPDATE policy is added for them.
        self.assertNotIn("CREATE POLICY jobs_insert", self.sql_content)
        self.assertNotIn("CREATE POLICY jobs_update", self.sql_content)
        self.assertNotIn("CREATE POLICY activity_insert", self.sql_content)


if __name__ == "__main__":
    unittest.main()
