"""Schema and RLS migration validation tests for Slice 2 (Files & API Keys)."""

from __future__ import annotations

import unittest
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).parent.parent
    / "db"
    / "migrations"
    / "20261001010000_slice2_files_and_api_keys.sql"
)


class Slice2SchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(MIGRATION_PATH.exists(), f"Migration file missing: {MIGRATION_PATH}")
        self.sql_content = MIGRATION_PATH.read_text(encoding="utf-8")

    def test_canonical_tables_exist(self) -> None:
        required_tables = [
            "CREATE TABLE IF NOT EXISTS octo.files",
            "CREATE TABLE IF NOT EXISTS octo.api_keys",
        ]
        for table in required_tables:
            self.assertIn(table, self.sql_content, f"Missing table definition: {table}")

    def test_row_level_security_enabled(self) -> None:
        required_rls = [
            "ALTER TABLE octo.files ENABLE ROW LEVEL SECURITY;",
            "ALTER TABLE octo.api_keys ENABLE ROW LEVEL SECURITY;",
        ]
        for rls in required_rls:
            self.assertIn(rls, self.sql_content, f"Missing RLS enablement: {rls}")

    def test_files_rls_policies(self) -> None:
        required_policies = [
            "CREATE POLICY files_select_member ON octo.files",
            "CREATE POLICY files_insert_member ON octo.files",
            "CREATE POLICY files_update_owner_admin ON octo.files",
            "CREATE POLICY files_delete_owner_admin ON octo.files",
        ]
        for policy in required_policies:
            self.assertIn(policy, self.sql_content, f"Missing files policy: {policy}")

    def test_api_keys_rls_policies(self) -> None:
        required_policies = [
            "CREATE POLICY api_keys_select_own ON octo.api_keys",
            "CREATE POLICY api_keys_insert_own ON octo.api_keys",
            "CREATE POLICY api_keys_delete_own ON octo.api_keys",
        ]
        for policy in required_policies:
            self.assertIn(policy, self.sql_content, f"Missing api_keys policy: {policy}")

    def test_security_definer_functions_exist(self) -> None:
        required_functions = [
            "CREATE OR REPLACE FUNCTION octo.verify_api_key(target_hash TEXT)",
            "LANGUAGE plpgsql SECURITY DEFINER",
        ]
        for fn in required_functions:
            self.assertIn(fn, self.sql_content, f"Missing helper function: {fn}")

    def test_no_anon_reachable_principal_lookup(self) -> None:
        # An anon-grantable lookup by UUID would disclose any principal's email,
        # avatar, and platform-owner flag to anyone holding the public anon key.
        self.assertNotIn(
            "octo.resolve_principal_by_id",
            self.sql_content,
            "Principal lookup must not be exposed as an anon-executable function",
        )

    def test_grants_exclude_truncate(self) -> None:
        # TRUNCATE is not subject to row security, so an ALL grant would let any
        # authenticated caller wipe every row with RLS still enabled.
        self.assertNotIn("GRANT ALL ON octo.files", self.sql_content)
        self.assertNotIn("GRANT ALL ON octo.api_keys", self.sql_content)
        self.assertIn(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON octo.files TO authenticated;",
            self.sql_content,
        )
        self.assertIn(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON octo.api_keys TO authenticated;",
            self.sql_content,
        )

    def test_api_key_role_cannot_exceed_creator_role(self) -> None:
        self.assertIn(
            "octo.role_rank(role) <= octo.role_rank(octo.get_workspace_role(workspace_id))",
            self.sql_content,
        )
        self.assertIn("(workspace_id IS NULL AND role IS NULL)", self.sql_content)


if __name__ == "__main__":
    unittest.main()
