"""Schema and RLS migration validation tests for Slice 4 (scoped share links)."""

from __future__ import annotations

import unittest
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).parent.parent
    / "db"
    / "migrations"
    / "20261001020000_slice4_scoped_shares.sql"
)


class Slice4SchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(MIGRATION_PATH.exists(), f"Migration file missing: {MIGRATION_PATH}")
        self.sql_content = MIGRATION_PATH.read_text(encoding="utf-8")

    def test_shares_table_exists(self) -> None:
        self.assertIn("CREATE TABLE IF NOT EXISTS octo.shares", self.sql_content)

    def test_row_level_security_enabled(self) -> None:
        self.assertIn("ALTER TABLE octo.shares ENABLE ROW LEVEL SECURITY;", self.sql_content)

    def test_only_owner_and_admin_may_manage_shares(self) -> None:
        for policy in (
            "CREATE POLICY shares_select_owner_admin ON octo.shares",
            "CREATE POLICY shares_insert_owner_admin ON octo.shares",
            "CREATE POLICY shares_update_owner_admin ON octo.shares",
            "CREATE POLICY shares_delete_owner_admin ON octo.shares",
        ):
            self.assertIn(policy, self.sql_content, f"Missing share policy: {policy}")

    def test_token_hash_is_stored_not_raw_token(self) -> None:
        # The table must persist a hash column and never a plaintext token column.
        self.assertIn("token_hash TEXT UNIQUE NOT NULL", self.sql_content)
        self.assertNotIn("token TEXT", self.sql_content)
        self.assertNotIn("raw_token", self.sql_content)

    def test_read_permission_is_the_default(self) -> None:
        self.assertIn(
            "permission TEXT NOT NULL CHECK (permission IN ('read', 'upload')) DEFAULT 'read'",
            self.sql_content,
        )

    def test_expiry_must_follow_start(self) -> None:
        self.assertIn(
            "CONSTRAINT shares_expiry_after_start CHECK "
            "(valid_until IS NULL OR valid_until > valid_from)",
            self.sql_content,
        )

    def test_resolver_requires_active_share(self) -> None:
        self.assertIn(
            "CREATE OR REPLACE FUNCTION octo.resolve_share(target_hash TEXT)",
            self.sql_content,
        )
        self.assertIn("s.revoked_at IS NULL", self.sql_content)
        self.assertIn("s.valid_from <= now()", self.sql_content)
        self.assertIn("(s.valid_until IS NULL OR s.valid_until > now())", self.sql_content)

    def test_grants_exclude_truncate(self) -> None:
        self.assertNotIn("GRANT ALL", self.sql_content)
        self.assertIn(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON octo.shares TO authenticated;",
            self.sql_content,
        )


if __name__ == "__main__":
    unittest.main()
