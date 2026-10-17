"""Schema checks for credential egress routes and temp working keys."""

from __future__ import annotations

import unittest
from pathlib import Path

MIGRATION_PATH = (
    Path(__file__).parent.parent / "db" / "migrations" / "20261017200000_vault_routes_and_leases.sql"
)


class VaultRouteSchemaTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(MIGRATION_PATH.exists(), f"Migration file missing: {MIGRATION_PATH}")
        self.sql = MIGRATION_PATH.read_text(encoding="utf-8")

    def test_tables_exist(self) -> None:
        self.assertIn("CREATE TABLE IF NOT EXISTS octo.vault_routes", self.sql)
        self.assertIn("CREATE TABLE IF NOT EXISTS octo.vault_leases", self.sql)
        self.assertIn("route_key TEXT UNIQUE NOT NULL", self.sql)
        self.assertIn("key_hash TEXT UNIQUE NOT NULL", self.sql)

    def test_one_active_lease_per_grant_and_item(self) -> None:
        self.assertIn(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_vault_leases_active\n"
            "    ON octo.vault_leases(parent_grant_id, item_id) WHERE revoked_at IS NULL;",
            self.sql,
        )

    def test_lease_cascades_from_its_grant(self) -> None:
        self.assertIn(
            "parent_grant_id UUID NOT NULL REFERENCES octo.vault_grants(id) ON DELETE CASCADE",
            self.sql,
        )

    def test_auth_schemes(self) -> None:
        self.assertIn(
            "('bearer', 'x-api-key', 'basic', 'query', 'body_json', 'path')",
            self.sql,
        )
        self.assertIn("CONSTRAINT vault_route_scheme_fields CHECK", self.sql)

    def test_health_states(self) -> None:
        self.assertIn(
            "'unknown', 'ok', 'unauthorized', 'forbidden_group', 'unreachable'",
            self.sql,
        )

    def test_url_kind_taxonomy(self) -> None:
        self.assertIn(
            "'api_base', 'api_endpoint', 'docs', 'console', 'cors', 's3_endpoint'",
            self.sql,
        )

    def test_row_security_and_own_policies(self) -> None:
        for statement in (
            "ALTER TABLE octo.vault_routes ENABLE ROW LEVEL SECURITY;",
            "ALTER TABLE octo.vault_leases ENABLE ROW LEVEL SECURITY;",
            "CREATE POLICY vault_routes_select_own ON octo.vault_routes",
            "CREATE POLICY vault_routes_insert_own ON octo.vault_routes",
            "CREATE POLICY vault_leases_select_own ON octo.vault_leases",
        ):
            self.assertIn(statement, self.sql)

    def test_consume_function_joins_the_route(self) -> None:
        self.assertIn(
            "CREATE OR REPLACE FUNCTION octo.consume_vault_lease(target_hash TEXT, target_route_key TEXT)",
            self.sql,
        )
        self.assertIn("LANGUAGE plpgsql SECURITY DEFINER", self.sql)
        self.assertIn("AND l.revoked_at IS NULL", self.sql)
        self.assertIn("AND l.expires_at > now()", self.sql)
        self.assertIn(
            "GRANT EXECUTE ON FUNCTION octo.consume_vault_lease(TEXT, TEXT) TO anon, authenticated;",
            self.sql,
        )

    def test_grants_exclude_truncate(self) -> None:
        self.assertNotIn("GRANT ALL ON octo.vault_routes", self.sql)
        self.assertNotIn("GRANT ALL ON octo.vault_leases", self.sql)


if __name__ == "__main__":
    unittest.main()
