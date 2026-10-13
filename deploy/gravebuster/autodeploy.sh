#!/usr/bin/env bash
# Octo Autodeploy Script (Gravebuster)
# Runs via systemd timer to poll origin/production and trigger deploy.sh when changed.

set -euo pipefail

# A non-login ssh shell's PATH omits /usr/local/bin, where Docker Desktop installs
# its CLI; launchd supplies its own PATH for the timer but a manual run does not.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_DIR="$REPO_DIR/deploy/gravebuster"
STATE_FILE="$DEPLOY_DIR/.deploy-state"

cd "$REPO_DIR"

git fetch origin production --quiet

REMOTE_SHA="$(git rev-parse origin/production)"
CURRENT_SHA=""

if [ -f "$STATE_FILE" ]; then
  # shellcheck source=/dev/null
  source "$STATE_FILE"
  CURRENT_SHA="${SHA:-}"
fi

if [ "$REMOTE_SHA" = "$CURRENT_SHA" ]; then
  # Already up to date
  exit 0
fi

echo "Autodeploy: New commit detected on origin/production: ${REMOTE_SHA:0:12} (current: ${CURRENT_SHA:0:12})"
git checkout --quiet production
git reset --hard --quiet "origin/production"

cd "$DEPLOY_DIR"
./deploy.sh "$REMOTE_SHA"
