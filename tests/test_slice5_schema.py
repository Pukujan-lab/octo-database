"""Schema validation tests for Slice 5 (R2-to-Drive archive lifecycle)."""

from __future__ import annotations

import unittest
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).parent.parent
    / "db"
    / "migrations"
    / "20261001060000_slice5_archive_lifecycle.sql"
)

LIFECYCLE_STATES = (
    "active_r2",
    "archiving",
    "archived_drive",
    "restoring",
    "reconciliation_required",
)


class Slice5SchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(MIGRATION_PATH.exists(), f"Migration file missing: {MIGRATION_PATH}")
        self.sql_content = MIGRATION_PATH.read_text(encoding="utf-8")

    def test_archive_state_defaults_to_active_r2(self) -> None:
        self.assertIn(
            "ADD COLUMN IF NOT EXISTS archive_state TEXT NOT NULL DEFAULT 'active_r2'",
            self.sql_content,
        )

    def test_archive_state_is_constrained(self) -> None:
        for state in LIFECYCLE_STATES:
            self.assertIn(f"'{state}'", self.sql_content)
        self.assertIn("CHECK (archive_state IN (", self.sql_content)

    def test_locator_hash_and_timestamps_exist(self) -> None:
        # The locator is how a restore finds the cold object; the hash is how it
        # proves the cold copy is the same bytes that were archived.
        self.assertIn("ADD COLUMN IF NOT EXISTS archive_provider TEXT", self.sql_content)
        self.assertIn("ADD COLUMN IF NOT EXISTS archive_locator TEXT", self.sql_content)
        self.assertIn("ADD COLUMN IF NOT EXISTS archive_hash TEXT", self.sql_content)
        self.assertIn("ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ", self.sql_content)
        self.assertIn("ADD COLUMN IF NOT EXISTS last_verified_at TIMESTAMPTZ", self.sql_content)

    def test_reconciliation_scan_is_indexed(self) -> None:
        self.assertIn(
            "CREATE INDEX IF NOT EXISTS idx_files_archive_state ON octo.files(archive_state)",
            self.sql_content,
        )

    def test_does_not_change_file_status(self) -> None:
        # An archived file is still a live logical file; flipping `status` would
        # hide it from the gallery instead of restoring it on demand.
        self.assertNotIn("ALTER COLUMN status", self.sql_content)
        self.assertNotIn("SET status", self.sql_content)

    def test_adds_no_new_rls_policy(self) -> None:
        # The existing files_update_owner_admin policy already covers these columns.
        self.assertNotIn("CREATE POLICY", self.sql_content)


if __name__ == "__main__":
    unittest.main()
