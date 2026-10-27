"""Schema validation tests for hybrid retrieval (lexical + vector, fused with RRF)."""

from __future__ import annotations

import unittest
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).parent.parent / "db" / "migrations" / "20261026000000_rag_hybrid_retrieval.sql"
)


class RagHybridRetrievalSchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(MIGRATION_PATH.exists(), f"Migration file missing: {MIGRATION_PATH}")
        self.sql_content = MIGRATION_PATH.read_text(encoding="utf-8")

    def test_lexical_index_is_generated_and_indexed(self) -> None:
        self.assertIn("content_tsv tsvector", self.sql_content)
        self.assertIn(
            "GENERATED ALWAYS AS (to_tsvector('english', content)) STORED", self.sql_content
        )
        self.assertIn(
            "CREATE INDEX IF NOT EXISTS idx_chunks_content_tsv ON octo.chunks "
            "USING GIN (content_tsv)",
            self.sql_content,
        )

    def test_hybrid_function_is_workspace_scoped(self) -> None:
        self.assertIn("CREATE FUNCTION octo.match_chunks_hybrid(", self.sql_content)
        # Both arms must filter on the workspace; a vector arm alone would let a
        # lexical arm read across tenants.
        self.assertIn("WHERE e.workspace_id = target_workspace", self.sql_content)
        self.assertIn("WHERE c.workspace_id = target_workspace", self.sql_content)

    def test_both_arms_contribute_reciprocal_rank(self) -> None:
        self.assertIn("1.0 / (60 + v.rank)", self.sql_content)
        self.assertIn("1.0 / (60 + l.rank)", self.sql_content)
        self.assertIn("FULL OUTER JOIN lex_ranked l", self.sql_content)

    def test_lexical_arm_does_not_require_an_embedding(self) -> None:
        # The lexical arm selects from chunks only, so a chunk whose embedding is
        # missing stays findable by text.
        lex_arm = self.sql_content.split("lex_raw AS (", 1)[1].split("lex_ranked AS (", 1)[0]
        self.assertNotIn("octo.embeddings", lex_arm)

    def test_grants_execute_to_authenticated(self) -> None:
        self.assertIn(
            "GRANT EXECUTE ON FUNCTION octo.match_chunks_hybrid(UUID, vector, TEXT, INT) "
            "TO authenticated;",
            self.sql_content,
        )

    def test_vector_only_primitive_is_preserved(self) -> None:
        self.assertNotIn("DROP FUNCTION IF EXISTS octo.match_chunks(", self.sql_content)


if __name__ == "__main__":
    unittest.main()
