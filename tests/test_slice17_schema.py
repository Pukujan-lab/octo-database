"""Schema migration validation tests for Slice 17 (per-principal MFA step-up)."""

from __future__ import annotations

import unittest
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).parent.parent
    / "db"
    / "migrations"
    / "20261001100000_slice17_principal_mfa.sql"
)


class Slice17SchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(MIGRATION_PATH.exists(), f"Migration file missing: {MIGRATION_PATH}")
        self.sql_content = MIGRATION_PATH.read_text(encoding="utf-8")

    def test_encrypted_secret_column_is_added(self) -> None:
        # The TOTP secret must be recoverable to verify codes, so it is stored
        # encrypted at rest rather than hashed. The column is the durable,
        # reviewable home for that envelope.
        self.assertIn(
            "ADD COLUMN IF NOT EXISTS mfa_secret_encrypted",
            self.sql_content,
            "Migration must add octo.principals.mfa_secret_encrypted",
        )

    def test_confirmation_timestamp_is_added(self) -> None:
        # A pending (unconfirmed) secret must be distinguishable from an active
        # one, so enrollment sets the secret but only confirmation stamps the time.
        self.assertIn("ADD COLUMN IF NOT EXISTS mfa_confirmed_at TIMESTAMPTZ", self.sql_content)

    def test_recovery_code_hashes_are_not_null_with_empty_default(self) -> None:
        # Every principal row must carry a usable array so reads and the consume
        # path never branch on null.
        self.assertIn(
            "ADD COLUMN IF NOT EXISTS mfa_recovery_code_hashes TEXT[] NOT NULL DEFAULT '{}'",
            self.sql_content,
        )

    def test_columns_live_on_principals_beside_confirm_secret_hash(self) -> None:
        # MFA is a per-principal secret like confirm_secret_hash, read and written
        # on the trusted service path, so it belongs on the same table.
        self.assertIn("ALTER TABLE octo.principals", self.sql_content)

    def test_migration_is_idempotent(self) -> None:
        # CI applies every migration on every run; each ADD COLUMN must tolerate
        # an already-migrated database.
        self.assertEqual(self.sql_content.count("IF NOT EXISTS"), 3)


if __name__ == "__main__":
    unittest.main()
