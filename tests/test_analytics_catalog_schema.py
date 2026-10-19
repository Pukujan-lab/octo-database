"""Schema migration validation tests for the Slice 7 analytics catalog."""

from __future__ import annotations

import unittest
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).parent.parent
    / "db"
    / "migrations"
    / "20261019000000_slice7_analytics_catalog.sql"
)

TABLES = ("octo.datasets", "octo.dataset_versions", "octo.analytics_results")


class AnalyticsCatalogSchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(MIGRATION_PATH.exists(), f"Migration file missing: {MIGRATION_PATH}")
        self.sql_content = MIGRATION_PATH.read_text(encoding="utf-8")

    def test_the_three_catalog_tables_are_created(self) -> None:
        for table in TABLES:
            self.assertIn(f"CREATE TABLE IF NOT EXISTS {table}", self.sql_content)

    def test_versions_are_unique_per_dataset(self) -> None:
        # A re-export is a new version; two rows may never claim the same number.
        self.assertIn("UNIQUE (dataset_id, version)", self.sql_content)

    def test_versions_are_immutable_metadata(self) -> None:
        # The object-key list, schema, provenance, and row count are recorded once.
        for column in (
            "schema JSONB NOT NULL",
            "provenance JSONB NOT NULL",
            "object_keys TEXT[] NOT NULL",
        ):
            self.assertIn(column, self.sql_content)

    def test_one_result_per_job(self) -> None:
        # A retried job converges on the same artifact row instead of registering
        # a second one.
        self.assertIn("UNIQUE (job_id)", self.sql_content)

    def test_row_level_security_is_enabled(self) -> None:
        for table in TABLES:
            self.assertIn(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY", self.sql_content)

    def test_every_table_carries_the_tenant_fence(self) -> None:
        self.assertEqual(self.sql_content.count("CREATE POLICY tenant_scope_fence"), 3)
        self.assertEqual(self.sql_content.count("AS RESTRICTIVE"), 3)
        # USING and WITH CHECK each compare the fence function twice.
        self.assertEqual(self.sql_content.count("octo.current_workspace_id()"), 12)

    def test_grants_are_to_the_trusted_role_only(self) -> None:
        # The request path never writes the catalog directly; the app pool is
        # RLS-fenced and the migration grants it no DML.
        self.assertEqual(self.sql_content.count("TO octo_service"), 3)
        self.assertNotIn("TO authenticated", self.sql_content)

    def test_migration_is_idempotent(self) -> None:
        self.assertIn("IF NOT EXISTS", self.sql_content)

    def test_migration_has_no_transaction_control(self) -> None:
        statements = self.sql_content.upper()
        self.assertNotIn("\nBEGIN;", statements)
        self.assertNotIn("\nCOMMIT;", statements)


if __name__ == "__main__":
    unittest.main()
