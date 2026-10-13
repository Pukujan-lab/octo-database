"""Schema migration validation tests for provisioned databases (productization Slice 20)."""

from __future__ import annotations

import unittest
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).parent.parent
    / "db"
    / "migrations"
    / "20261001130000_provisioned_databases.sql"
)


class ProvisionedDatabasesSchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(MIGRATION_PATH.exists(), f"Migration file missing: {MIGRATION_PATH}")
        self.sql_content = MIGRATION_PATH.read_text(encoding="utf-8")

    def test_catalog_table_is_created(self) -> None:
        self.assertIn("CREATE TABLE IF NOT EXISTS octo.workspace_databases", self.sql_content)

    def test_one_database_per_workspace(self) -> None:
        # Exactly one provisioned database per workspace is the slice's core rule.
        self.assertIn("workspace_id UUID NOT NULL UNIQUE", self.sql_content)

    def test_identifiers_are_unique_in_the_cluster(self) -> None:
        self.assertIn("db_name TEXT NOT NULL UNIQUE", self.sql_content)
        self.assertIn("role_name TEXT NOT NULL UNIQUE", self.sql_content)

    def test_no_credential_column_is_stored(self) -> None:
        # The client's credential exists only in the once-returned connection
        # string, so the catalog table itself must define no column for it.
        table_body = self.sql_content.split(
            "CREATE TABLE IF NOT EXISTS octo.workspace_databases", 1
        )[1]
        table_body = table_body.split(");", 1)[0]
        self.assertNotIn("password", table_body.lower())
        self.assertNotIn("secret", table_body.lower())
        self.assertNotIn("connection_string", table_body.lower())

    def test_row_level_security_is_enabled(self) -> None:
        self.assertIn(
            "ALTER TABLE octo.workspace_databases ENABLE ROW LEVEL SECURITY", self.sql_content
        )

    def test_table_is_inside_the_tenant_fence(self) -> None:
        # The slice14 fence list is a hardcoded array that does not cover tables
        # created later, so this migration must add the fence itself.
        self.assertIn(
            "CREATE POLICY tenant_scope_fence ON octo.workspace_databases", self.sql_content
        )
        self.assertIn("AS RESTRICTIVE", self.sql_content)
        self.assertIn("octo.current_workspace_id()", self.sql_content)

    def test_migration_is_idempotent(self) -> None:
        self.assertIn("IF NOT EXISTS", self.sql_content)

    def test_migration_has_no_transaction_control(self) -> None:
        # The deploy runner wraps each migration in one transaction with its
        # tracking insert, so a top-level BEGIN/COMMIT here would break it.
        statements = self.sql_content.upper()
        self.assertNotIn("\nBEGIN;", statements)
        self.assertNotIn("\nCOMMIT;", statements)


if __name__ == "__main__":
    unittest.main()
