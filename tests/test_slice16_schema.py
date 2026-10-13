"""Schema migration validation tests for Slice 16 (workspace-creation daily limit)."""

from __future__ import annotations

import unittest
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).parent.parent
    / "db"
    / "migrations"
    / "20261001090000_slice16_workspace_creation_limit.sql"
)


class Slice16SchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(MIGRATION_PATH.exists(), f"Migration file missing: {MIGRATION_PATH}")
        self.sql_content = MIGRATION_PATH.read_text(encoding="utf-8")

    def test_auto_provisioned_column_is_added(self) -> None:
        # The daily limit excludes the sign-in sandbox; that exclusion must be a
        # durable, reviewable column rather than a slug-name heuristic.
        self.assertIn(
            "ADD COLUMN IF NOT EXISTS auto_provisioned",
            self.sql_content,
            "Migration must add octo.workspaces.auto_provisioned",
        )

    def test_column_is_not_null_with_false_default(self) -> None:
        # Every existing and future API-created workspace must count, so the
        # default is false (only the sign-in sandbox is explicitly true).
        self.assertIn("BOOLEAN NOT NULL DEFAULT false", self.sql_content)

    def test_migration_is_idempotent(self) -> None:
        # CI applies every migration on every run; the ADD COLUMN must tolerate
        # an already-migrated database.
        self.assertIn("IF NOT EXISTS", self.sql_content)


if __name__ == "__main__":
    unittest.main()
