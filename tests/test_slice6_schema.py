"""Schema and RLS migration validation tests for Slice 6 (jobs and activity)."""

from __future__ import annotations

import unittest
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).parent.parent
    / "db"
    / "migrations"
    / "20261001030000_slice6_jobs_and_activity.sql"
)


class Slice6SchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(MIGRATION_PATH.exists(), f"Migration file missing: {MIGRATION_PATH}")
        self.sql_content = MIGRATION_PATH.read_text(encoding="utf-8")

    def test_jobs_and_activity_tables_exist(self) -> None:
        self.assertIn("CREATE TABLE IF NOT EXISTS octo.jobs", self.sql_content)
        self.assertIn("CREATE TABLE IF NOT EXISTS octo.activity", self.sql_content)

    def test_row_level_security_enabled(self) -> None:
        self.assertIn("ALTER TABLE octo.jobs ENABLE ROW LEVEL SECURITY;", self.sql_content)
        self.assertIn("ALTER TABLE octo.activity ENABLE ROW LEVEL SECURITY;", self.sql_content)

    def test_members_can_read_but_not_transition(self) -> None:
        # Members observe operations; only the trusted server transitions state,
        # so there must be no client-side INSERT/UPDATE policy on jobs.
        self.assertIn("CREATE POLICY jobs_select_member ON octo.jobs", self.sql_content)
        self.assertNotIn("CREATE POLICY jobs_insert", self.sql_content)
        self.assertNotIn("CREATE POLICY jobs_update", self.sql_content)

    def test_states_are_constrained(self) -> None:
        self.assertIn(
            "CHECK (state IN ('queued', 'running', 'completed', 'failed', 'paused'))",
            self.sql_content,
        )

    def test_idempotency_key_is_unique_per_workspace_and_type(self) -> None:
        self.assertIn(
            "CONSTRAINT jobs_idempotency_unique UNIQUE (workspace_id, job_type, idempotency_key)",
            self.sql_content,
        )

    def test_claim_uses_skip_locked_and_a_lease(self) -> None:
        self.assertIn("CREATE OR REPLACE FUNCTION octo.claim_job", self.sql_content)
        self.assertIn("FOR UPDATE SKIP LOCKED", self.sql_content)
        self.assertIn(
            "lease_expires_at = now() + make_interval(secs => lease_seconds)",
            self.sql_content,
        )
        self.assertIn("target_workspace UUID DEFAULT NULL", self.sql_content)
        self.assertIn(
            "target_workspace IS NULL OR j.workspace_id = target_workspace",
            self.sql_content,
        )
        # A crashed worker's running job must become claimable again.
        self.assertIn(
            "j.state = 'running' AND j.lease_expires_at IS NOT NULL "
            "AND j.lease_expires_at <= now()",
            self.sql_content,
        )

    def test_grants_exclude_truncate(self) -> None:
        self.assertNotIn("GRANT ALL", self.sql_content)
        self.assertIn(
            "GRANT SELECT, INSERT, UPDATE, DELETE ON octo.jobs TO authenticated;",
            self.sql_content,
        )

    def test_claim_job_not_granted_to_clients(self) -> None:
        self.assertNotIn("GRANT EXECUTE ON FUNCTION octo.claim_job", self.sql_content)


if __name__ == "__main__":
    unittest.main()
