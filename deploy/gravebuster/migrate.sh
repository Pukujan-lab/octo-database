#!/usr/bin/env bash
# Octo Migration Runner (Gravebuster)
#
# Applies the canonical migrations in db/migrations/ to the live database and
# records each in octo.schema_migrations, so a deploy brings the schema up to the
# code it is about to run. deploy.sh calls this before starting the API; without it
# a deploy could run new code against an old schema (the drift that once broke
# production login).
#
# Each migration runs in one transaction together with its tracking insert, so a
# failure leaves neither a half-applied migration nor a false "applied" row. The
# migrations contain no top-level BEGIN/COMMIT and nothing that cannot run inside a
# transaction, so wrapping them this way is safe.
#
# Adoption: a database that predates this tracking table has no rows in it, so a
# plain run would try to re-apply already-applied migrations and fail on the
# non-idempotent ones (plain CREATE POLICY). For that one-time case set
# MIGRATE_BASELINE=1 to record every present migration as applied without running
# it — only when the tracking table is empty. Confirm the schema is already current
# before using it.
#
# Baseline against the migration set the database ALREADY has — the commit that
# created it — never the set you are about to deploy. MIGRATE_BASELINE records every
# file in MIGRATIONS_DIR, so baselining from a checkout that also contains a new
# migration records that new migration as applied, and it is then skipped forever
# (the schema silently drifts behind the code). To adopt a database created by commit
# C while deploying D: check out C, run the baseline there, then deploy D so this
# runner applies only what D adds. See docs/self-hosting.md § 3a.

set -euo pipefail

# A non-login ssh shell's PATH omits /usr/local/bin, where Docker Desktop installs
# its CLI; launchd supplies its own PATH for the timer but a manual run does not.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="${MIGRATIONS_DIR:-$SCRIPT_DIR/../../db/migrations}"
TRACKING_TABLE="octo.schema_migrations"

# How to reach psql. Defaults to the compose-managed octo-db container; override for
# a host psql or CI, e.g.
#   MIGRATE_PSQL_CMD="psql -h localhost -p 54329 -U postgres -d postgres"
if [ -z "${MIGRATE_PSQL_CMD:-}" ]; then
  COMPOSE_ARGS="-f $SCRIPT_DIR/docker-compose.yml"
  if [ -f "$SCRIPT_DIR/docker-compose.edge.yml" ]; then
    COMPOSE_ARGS="$COMPOSE_ARGS -f $SCRIPT_DIR/docker-compose.edge.yml"
  fi
  MIGRATE_PSQL_CMD="docker compose $COMPOSE_ARGS exec -T octo-db psql -v ON_ERROR_STOP=1 -U postgres -d postgres"
fi

run_psql() {
  if [ "$#" -eq 0 ]; then
    sh -c "$MIGRATE_PSQL_CMD"
  else
    sh -c "$MIGRATE_PSQL_CMD \"\$@\"" sh "$@"
  fi
}

# The tracking table creates the octo schema if this is a fresh database; slice1
# creates the same schema idempotently, so the order does not matter.
run_psql <<SQL
CREATE SCHEMA IF NOT EXISTS octo;
CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
  filename   text        PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);
SQL

recorded="$(run_psql -tAc "SELECT count(*) FROM ${TRACKING_TABLE}" | tr -d '[:space:]')"

if [ "${MIGRATE_BASELINE:-}" = "1" ]; then
  if [ "$recorded" != "0" ]; then
    echo "MIGRATE_BASELINE=1 but ${TRACKING_TABLE} already has ${recorded} rows; nothing to baseline."
  else
    echo "Baselining: recording every present migration as already applied (no migration SQL executed)."
    for migration in "$MIGRATIONS_DIR"/*.sql; do
      [ -f "$migration" ] || continue
      name="$(basename "$migration")"
      run_psql -c "INSERT INTO ${TRACKING_TABLE}(filename) VALUES ('${name}') ON CONFLICT DO NOTHING"
      echo "  baselined: ${name}"
    done
  fi
  exit 0
fi

applied=0
skipped=0
for migration in "$MIGRATIONS_DIR"/*.sql; do
  [ -f "$migration" ] || continue
  name="$(basename "$migration")"
  if [ -n "$(run_psql -tAc "SELECT 1 FROM ${TRACKING_TABLE} WHERE filename = '${name}'")" ]; then
    skipped=$((skipped + 1))
    continue
  fi
  echo "Applying: ${name}"
  {
    echo "BEGIN;"
    cat "$migration"
    echo ""
    echo "INSERT INTO ${TRACKING_TABLE}(filename) VALUES ('${name}');"
    echo "COMMIT;"
  } | run_psql
  applied=$((applied + 1))
done

echo "Migrations: ${applied} applied, ${skipped} already recorded."
