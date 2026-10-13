"""Schema and semantics validation tests for Slice 9 (epistemic bitemporal schema)."""

from __future__ import annotations

import unittest
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).parent.parent
    / "db"
    / "migrations"
    / "20261001040000_slice9_epistemic_schema.sql"
)


class Slice9SchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(MIGRATION_PATH.exists(), f"Migration file missing: {MIGRATION_PATH}")
        self.sql_content = MIGRATION_PATH.read_text(encoding="utf-8")

    def test_canonical_tables_exist(self) -> None:
        for table in (
            "octo.epistemic_entities",
            "octo.claims",
            "octo.perspectives",
            "octo.beliefs",
            "octo.evidence",
            "octo.claim_relations",
            "octo.claim_evidence",
        ):
            self.assertIn(f"CREATE TABLE IF NOT EXISTS {table}", self.sql_content, table)

    def test_row_level_security_enabled_everywhere(self) -> None:
        for table in (
            "epistemic_entities",
            "claims",
            "perspectives",
            "beliefs",
            "evidence",
            "claim_relations",
            "claim_evidence",
        ):
            self.assertIn(f"ALTER TABLE octo.{table} ENABLE ROW LEVEL SECURITY;", self.sql_content)

    def test_claims_carry_both_time_axes(self) -> None:
        # Valid time and recorded time must be independent columns.
        self.assertIn("valid_from TIMESTAMPTZ NOT NULL DEFAULT now()", self.sql_content)
        self.assertIn("recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()", self.sql_content)
        self.assertIn("superseded_at TIMESTAMPTZ", self.sql_content)

    def test_belief_is_not_a_column_on_claims(self) -> None:
        # Belief must live in its own perspective-keyed table, not on claim.
        claims_block = self.sql_content.split("CREATE TABLE IF NOT EXISTS octo.claims")[1].split(
            ");"
        )[0]
        self.assertNotIn("belief", claims_block.lower())
        self.assertIn("CREATE TABLE IF NOT EXISTS octo.beliefs", self.sql_content)
        self.assertIn(
            "perspective_id UUID NOT NULL REFERENCES octo.perspectives(id)", self.sql_content
        )

    def test_relations_are_constrained(self) -> None:
        self.assertIn("'SUPPORTS', 'CONTRADICTS', 'SUPERSEDES', 'QUALIFIES'", self.sql_content)
        self.assertIn("'DERIVED_FROM', 'DUPLICATES', 'REFINES'", self.sql_content)
        self.assertIn(
            "CONSTRAINT claim_relations_no_self CHECK (from_claim_id <> to_claim_id)",
            self.sql_content,
        )

    def test_bitemporal_query_functions_apply_both_axes(self) -> None:
        self.assertIn("CREATE OR REPLACE FUNCTION octo.belief_as_of", self.sql_content)
        self.assertIn("CREATE OR REPLACE FUNCTION octo.claims_as_of", self.sql_content)
        # Recorded-time filter
        self.assertIn("b.recorded_at <= as_of_recorded", self.sql_content)
        self.assertIn("b.superseded_at > as_of_recorded", self.sql_content)
        # Valid-time filter
        self.assertIn("b.valid_from <= as_of_valid", self.sql_content)
        self.assertIn("b.valid_to > as_of_valid", self.sql_content)

    def test_grants_exclude_truncate(self) -> None:
        self.assertNotIn("GRANT ALL", self.sql_content)
        self.assertIn(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON octo.claims TO authenticated;",
            self.sql_content,
        )

    def test_writers_require_operator_role(self) -> None:
        self.assertIn("CREATE POLICY claims_insert_operator ON octo.claims", self.sql_content)
        self.assertIn(
            "octo.get_workspace_role(workspace_id) IN ('owner', 'admin', 'operator')",
            self.sql_content,
        )


if __name__ == "__main__":
    unittest.main()
