"""Schema migration validation tests for workspace database credentials (Slice 21)."""

from __future__ import annotations

import unittest
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).parent.parent
    / "db"
    / "migrations"
    / "20261006150000_workspace_database_credentials.sql"
)


class WorkspaceDatabaseCredentialsSchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(MIGRATION_PATH.exists(), f"Migration file missing: {MIGRATION_PATH}")
        self.sql_content = MIGRATION_PATH.read_text(encoding="utf-8")

    def test_credential_table_is_created(self) -> None:
        self.assertIn(
            "CREATE TABLE IF NOT EXISTS octo.workspace_database_credentials", self.sql_content
        )

    def test_one_credential_per_workspace(self) -> None:
        # The password belongs to the workspace's single provisioned role, so the
        # workspace id is the primary key and the row follows the workspace out.
        self.assertIn(
            "workspace_id UUID PRIMARY KEY REFERENCES octo.workspaces(id)", self.sql_content
        )
        self.assertIn("ON DELETE CASCADE", self.sql_content)

    def test_only_ciphertext_is_stored(self) -> None:
        # The plaintext password is never stored; the column holds the AES-256-GCM
        # envelope. A column named for the plaintext would invite storing it.
        self.assertIn("password_encrypted TEXT NOT NULL", self.sql_content)
        self.assertNotIn("password TEXT", self.sql_content)

    def test_credentials_live_in_a_separate_table_from_the_catalog(self) -> None:
        # octo.workspace_databases is the tenant-visible catalog and must carry no
        # credential; secret material belongs in its own control-plane table. This
        # migration may *name* the catalog in prose, but must not touch it in DDL.
        ddl = "\n".join(
            line for line in self.sql_content.splitlines() if not line.strip().startswith("--")
        )
        self.assertNotIn("octo.workspace_databases", ddl)

    def test_row_level_security_is_enabled(self) -> None:
        self.assertIn(
            "ALTER TABLE octo.workspace_database_credentials ENABLE ROW LEVEL SECURITY",
            self.sql_content,
        )

    def test_grant_is_to_the_trusted_role_only(self) -> None:
        # RLS with no policies denies by default; the only role granted access is
        # the BYPASSRLS service role. Granting to `authenticated` would let the
        # fenced app pool read every workspace's database credential.
        self.assertIn("TO octo_service", self.sql_content)
        self.assertNotIn("TO authenticated", self.sql_content)

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
