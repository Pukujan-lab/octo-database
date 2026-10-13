"""Schema validation tests for Slice 10 (rebuildable graph projection)."""

from __future__ import annotations

import unittest
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).parent.parent
    / "db"
    / "migrations"
    / "20261007000000_slice10_graph_projection.sql"
)


class Slice10SchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(MIGRATION_PATH.exists(), f"Migration file missing: {MIGRATION_PATH}")
        self.sql_content = MIGRATION_PATH.read_text(encoding="utf-8")

    def test_projection_bookkeeping_table_exists(self) -> None:
        self.assertIn("CREATE TABLE IF NOT EXISTS octo.graph_projections", self.sql_content)

    def test_source_watermark_makes_staleness_detectable(self) -> None:
        # The graph is a projection, so a lost graph must be rebuildable from
        # octo.* rows: nothing here is canonical, and the watermark is what lets a
        # query detect that the graph has fallen behind the ledger.
        self.assertIn("source_watermark TIMESTAMPTZ NOT NULL", self.sql_content)

    def test_row_level_security_enabled(self) -> None:
        self.assertIn(
            "ALTER TABLE octo.graph_projections ENABLE ROW LEVEL SECURITY;", self.sql_content
        )

    def test_members_read_and_operators_write(self) -> None:
        self.assertIn(
            "CREATE POLICY graph_projections_select_member ON octo.graph_projections",
            self.sql_content,
        )
        self.assertIn(
            "octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator')",
            self.sql_content,
        )

    def test_grants_exclude_truncate(self) -> None:
        self.assertNotIn("GRANT ALL", self.sql_content)
        self.assertIn(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON octo.graph_projections TO authenticated;",
            self.sql_content,
        )


if __name__ == "__main__":
    unittest.main()
