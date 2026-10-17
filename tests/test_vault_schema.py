"""Schema checks for the vault cabinet and temporary grants."""

from __future__ import annotations

import unittest
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).parent.parent / "db" / "migrations" / "20261016190000_vault_items_and_grants.sql"
)


class VaultSchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(MIGRATION_PATH.exists(), f"Migration file missing: {MIGRATION_PATH}")
        self.sql = MIGRATION_PATH.read_text(encoding="utf-8")

    def test_tables_exist(self) -> None:
        self.assertIn("CREATE TABLE IF NOT EXISTS octo.vault_items", self.sql)
        self.assertIn("description TEXT NOT NULL", self.sql)
        self.assertIn("CREATE TABLE IF NOT EXISTS octo.vault_grants", self.sql)

    def test_row_security_and_own_policies(self) -> None:
        for statement in (
            "ALTER TABLE octo.vault_items ENABLE ROW LEVEL SECURITY;",
            "ALTER TABLE octo.vault_grants ENABLE ROW LEVEL SECURITY;",
            "CREATE POLICY vault_items_select_own ON octo.vault_items",
            "CREATE POLICY vault_items_insert_own ON octo.vault_items",
            "CREATE POLICY vault_grants_select_own ON octo.vault_grants",
            "CREATE POLICY vault_grants_insert_own ON octo.vault_grants",
        ):
            self.assertIn(statement, self.sql)

    def test_kinds_and_health(self) -> None:
        self.assertIn("CHECK (kind IN ('login', 'token', 'url', 'note'))", self.sql)
        self.assertIn("'unchecked', 'healthy', 'weak', 'stale'", self.sql)

    def test_consume_function_trips_decoys(self) -> None:
        self.assertIn(
            "CREATE OR REPLACE FUNCTION octo.consume_vault_grant(target_hash TEXT)",
            self.sql,
        )
        self.assertIn("LANGUAGE plpgsql SECURITY DEFINER", self.sql)
        self.assertIn("WHEN g.decoy AND g.tripped_at IS NULL THEN now()", self.sql)
        self.assertIn(
            "GRANT EXECUTE ON FUNCTION octo.consume_vault_grant(TEXT) TO anon, authenticated;",
            self.sql,
        )

    def test_grants_exclude_truncate(self) -> None:
        self.assertNotIn("GRANT ALL ON octo.vault_items", self.sql)
        self.assertNotIn("GRANT ALL ON octo.vault_grants", self.sql)
        self.assertIn(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON octo.vault_items TO authenticated;",
            self.sql,
        )
        self.assertIn(
            "GRANT SELECT, INSERT, DELETE ON octo.vault_grants TO authenticated;",
            self.sql,
        )
