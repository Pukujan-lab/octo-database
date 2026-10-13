"""Schema migration validation tests for the ops-events slice (issue #140, O1)."""

from __future__ import annotations

import unittest
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).parent.parent
    / "db"
    / "migrations"
    / "20261001110000_slice18_ops_events.sql"
)


class OpsEventsSchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(MIGRATION_PATH.exists(), f"Migration file missing: {MIGRATION_PATH}")
        self.sql_content = MIGRATION_PATH.read_text(encoding="utf-8")

    def test_ops_events_table_is_created(self) -> None:
        self.assertIn("CREATE TABLE IF NOT EXISTS octo.ops_events", self.sql_content)

    def test_workspace_id_is_nullable(self) -> None:
        # Platform-level errors (auth failures, pre-workspace 500s) have no
        # workspace, so the column must be nullable rather than NOT NULL.
        self.assertIn("workspace_id UUID REFERENCES octo.workspaces(id)", self.sql_content)
        self.assertNotIn("workspace_id UUID NOT NULL", self.sql_content)

    def test_source_is_constrained(self) -> None:
        self.assertIn("CHECK (source IN ('api', 'worker'))", self.sql_content)

    def test_row_level_security_is_enabled(self) -> None:
        self.assertIn("ALTER TABLE octo.ops_events ENABLE ROW LEVEL SECURITY", self.sql_content)

    def test_null_workspace_rows_are_platform_owner_only(self) -> None:
        # A null-workspace event is a platform-level record; only the owner reads it.
        self.assertIn("workspace_id IS NULL AND octo.is_platform_owner() = true", self.sql_content)

    def test_migration_is_idempotent(self) -> None:
        self.assertIn("IF NOT EXISTS", self.sql_content)


if __name__ == "__main__":
    unittest.main()
