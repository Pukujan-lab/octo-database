#!/usr/bin/env bash
# Octo Rollback Script (Gravebuster)
# Rolls back to the previously recorded container image from .deploy-state.

set -euo pipefail

# A non-login ssh shell's PATH omits /usr/local/bin, where Docker Desktop installs
# its CLI; launchd supplies its own PATH for the timer but a manual run does not.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

STATE_FILE=".deploy-state"
COMPOSE_FILES=("-f" "docker-compose.yml")
if [ -f "docker-compose.edge.yml" ]; then
  COMPOSE_FILES+=("-f" "docker-compose.edge.yml")
fi
# Host overlay on the OVH server: embedder, resource limits, Postgres shm.
if [ -f "docker-compose.vps.yml" ]; then
  COMPOSE_FILES+=("-f" "docker-compose.vps.yml")
fi

if [ ! -f "$STATE_FILE" ]; then
  echo "ERROR: No .deploy-state found. Cannot determine rollback target."
  exit 1
fi

# shellcheck source=/dev/null
source "$STATE_FILE"

if [ -z "${PREVIOUS_IMAGE:-}" ] || [ "${PREVIOUS_IMAGE}" = "latest" ]; then
  echo "WARNING: No recorded previous image. Re-starting current containers..."
  docker compose "${COMPOSE_FILES[@]}" restart octo-api octo-web
  exit 0
fi

echo "=== Rolling back Octo to image tag: ${PREVIOUS_IMAGE} ==="

export IMAGE_TAG="${PREVIOUS_IMAGE}"
docker compose "${COMPOSE_FILES[@]}" up -d

echo "Recording rollback in deploy state..."
cat <<EOF > "$STATE_FILE"
SHA="rollback"
CURRENT_IMAGE="${PREVIOUS_IMAGE}"
PREVIOUS_IMAGE=""
DEPLOYED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
EOF

echo "=== Rollback complete. ==="
