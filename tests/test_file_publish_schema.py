"""Schema checks for the public-file publish columns (issue #175)."""

from __future__ import annotations

import unittest
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).parent.parent / "db" / "migrations" / "20261006160000_file_publish.sql"
)


class FilePublishSchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(MIGRATION_PATH.exists(), f"Migration file missing: {MIGRATION_PATH}")
        self.sql_content = MIGRATION_PATH.read_text(encoding="utf-8")

    def test_publish_columns_are_nullable_additions(self) -> None:
        self.assertIn("ALTER TABLE octo.files", self.sql_content)
        self.assertIn("ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ", self.sql_content)
        self.assertIn("ADD COLUMN IF NOT EXISTS public_key TEXT", self.sql_content)
        for line in self.sql_content.splitlines():
            if "published_at" in line or "public_key" in line:
                self.assertNotIn("NOT NULL", line)

    def test_migration_does_not_widen_access_or_rewrite_status(self) -> None:
        self.assertNotIn("CREATE POLICY", self.sql_content)
        self.assertNotIn("GRANT ALL", self.sql_content)
        self.assertNotIn("SET status", self.sql_content)
        self.assertNotIn("public-read", self.sql_content)
        self.assertNotIn("archive_state", self.sql_content)
