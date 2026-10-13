"""Schema and RLS migration validation tests for Slice 1."""

from __future__ import annotations

import unittest
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).parent.parent
    / "db"
    / "migrations"
    / "20261001000000_slice1_principals_workspaces_memberships.sql"
)


class Slice1SchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(MIGRATION_PATH.exists(), f"Migration file missing: {MIGRATION_PATH}")
        self.sql_content = MIGRATION_PATH.read_text(encoding="utf-8")

    def test_canonical_tables_exist(self) -> None:
        required_tables = [
            "CREATE TABLE IF NOT EXISTS octo.principals",
            "CREATE TABLE IF NOT EXISTS octo.workspaces",
            "CREATE TABLE IF NOT EXISTS octo.workspace_memberships",
        ]
        for table in required_tables:
            self.assertIn(table, self.sql_content, f"Missing table definition: {table}")

    def test_row_level_security_enabled_on_all_tables(self) -> None:
        required_rls = [
            "ALTER TABLE octo.principals ENABLE ROW LEVEL SECURITY;",
            "ALTER TABLE octo.workspaces ENABLE ROW LEVEL SECURITY;",
            "ALTER TABLE octo.workspace_memberships ENABLE ROW LEVEL SECURITY;",
        ]
        for rls in required_rls:
            self.assertIn(rls, self.sql_content, f"Missing RLS enablement: {rls}")

    def test_self_promotion_prevention_in_policies(self) -> None:
        # INSERT check prevents client self-promotion
        self.assertIn(
            "WITH CHECK (auth_user_id = auth.uid() AND is_platform_owner = false);",
            self.sql_content,
            "INSERT policy must prevent setting is_platform_owner = true",
        )

        # UPDATE check prevents client self-promotion
        self.assertIn(
            "CREATE POLICY principals_update_own ON octo.principals",
            self.sql_content,
        )
        self.assertIn(
            "WITH CHECK (auth_user_id = auth.uid() AND is_platform_owner = false);",
            self.sql_content,
            "UPDATE policy must prevent escalating is_platform_owner = true",
        )

    def test_membership_bootstrap_policy_exists(self) -> None:
        # Workspace creator must be allowed to bootstrap owner membership
        self.assertIn(
            "CREATE POLICY memberships_insert_owner_admin ON octo.workspace_memberships",
            self.sql_content,
        )
        self.assertIn(
            "role = 'owner'",
            self.sql_content,
        )
        self.assertIn(
            "created_by = octo.current_principal_id()",
            self.sql_content,
        )

    def test_schema_and_table_grants_exist(self) -> None:
        required_grants = [
            "GRANT USAGE ON SCHEMA octo TO anon, authenticated;",
            "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA octo TO authenticated;",
            "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA octo TO authenticated;",
        ]
        for grant in required_grants:
            self.assertIn(grant, self.sql_content, f"Missing grant: {grant}")

    def test_role_enum_constraints(self) -> None:
        self.assertIn(
            "CHECK (role IN ('owner', 'admin', 'operator', 'member'))",
            self.sql_content,
            "Role constraint must specify exactly the four canonical roles",
        )


if __name__ == "__main__":
    unittest.main()
