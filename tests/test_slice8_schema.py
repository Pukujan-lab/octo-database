"""Schema and semantics validation tests for Slice 8 (RAG with pgvector)."""

from __future__ import annotations

import unittest
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).parent.parent / "db" / "migrations" / "20261001050000_slice8_rag_pgvector.sql"
)


class Slice8SchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(MIGRATION_PATH.exists(), f"Migration file missing: {MIGRATION_PATH}")
        self.sql_content = MIGRATION_PATH.read_text(encoding="utf-8")

    def test_vector_extension_loaded(self) -> None:
        self.assertIn("CREATE EXTENSION IF NOT EXISTS vector;", self.sql_content)

    def test_canonical_and_derived_tables_exist(self) -> None:
        # Canonical metadata
        self.assertIn("CREATE TABLE IF NOT EXISTS octo.documents", self.sql_content)
        self.assertIn("CREATE TABLE IF NOT EXISTS octo.document_versions", self.sql_content)
        self.assertIn("CREATE TABLE IF NOT EXISTS octo.embedding_configs", self.sql_content)
        # Derived artifacts
        self.assertIn("CREATE TABLE IF NOT EXISTS octo.chunks", self.sql_content)
        self.assertIn("CREATE TABLE IF NOT EXISTS octo.embeddings", self.sql_content)

    def test_reingest_is_idempotent(self) -> None:
        # Same content hash cannot duplicate a version within a document.
        self.assertIn(
            "CONSTRAINT document_versions_unique UNIQUE (document_id, content_hash)",
            self.sql_content,
        )

    def test_reembedding_configs_coexist(self) -> None:
        # A new config is a new row, not an in-place mutation.
        self.assertIn(
            "CONSTRAINT embedding_configs_unique UNIQUE "
            "(workspace_id, model, model_version, chunker, chunk_size, chunk_overlap)",
            self.sql_content,
        )

    def test_retrieval_function_applies_workspace_filter(self) -> None:
        self.assertIn("CREATE OR REPLACE FUNCTION octo.match_chunks", self.sql_content)
        self.assertIn("WHERE e.workspace_id = target_workspace", self.sql_content)
        self.assertIn("ORDER BY e.embedding <=> query_embedding", self.sql_content)

    def test_row_level_security_enabled(self) -> None:
        for table in (
            "documents",
            "document_versions",
            "embedding_configs",
            "chunks",
            "embeddings",
        ):
            self.assertIn(f"ALTER TABLE octo.{table} ENABLE ROW LEVEL SECURITY;", self.sql_content)

    def test_grants_exclude_truncate(self) -> None:
        self.assertNotIn("GRANT ALL", self.sql_content)
        self.assertIn(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON octo.embeddings TO authenticated;",
            self.sql_content,
        )


if __name__ == "__main__":
    unittest.main()
