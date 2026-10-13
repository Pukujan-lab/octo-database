#!/usr/bin/env bash
# Octo database backup (macOS host).
#
# Dumps the octo-db Postgres cluster to a timestamped custom-format archive and
# prunes old copies. If rclone is configured with an `r2:` remote it also copies
# the dump off the host, so a dead laptop is not a dead backup.
#
# The dump is the whole cluster (control plane, all workspaces, per-workspace
# provisioned databases), so it restores a complete Octo. When the host uses the
# local storage backend the uploaded file bytes live in the octo-file-data
# volume, not in Postgres, so that volume is archived alongside the dump.
#
# Usage: ./backup.sh
# Env:
#   OCTO_BACKUP_DIR    local destination (default: $HOME/octo-backups)
#   OCTO_BACKUP_KEEP   local dumps to retain (default: 1)
#   OCTO_BACKUP_R2     rclone remote:path for offsite copy (default: r2:octo-backups)

set -euo pipefail

# A non-login ssh shell's PATH omits /usr/local/bin, where Docker Desktop installs
# its CLI; launchd supplies its own PATH for the timer but a manual run does not.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/../gravebuster/docker-compose.yml"
BACKUP_DIR="${OCTO_BACKUP_DIR:-$HOME/octo-backups}"
KEEP="${OCTO_BACKUP_KEEP:-1}"
R2_TARGET="${OCTO_BACKUP_R2:-r2:octo-backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$BACKUP_DIR/octo-$STAMP.dump"
FILES_FILE="$BACKUP_DIR/octo-files-$STAMP.tar.gz"

mkdir -p "$BACKUP_DIR"

# -Fc is pg_restore's custom format: compressed, and restorable table-by-table.
docker compose -f "$COMPOSE_FILE" exec -T octo-db \
  pg_dump -U postgres -d postgres -Fc > "$FILE"

if [ ! -s "$FILE" ]; then
  echo "ERROR: backup file is empty: $FILE" >&2
  rm -f "$FILE"
  exit 1
fi

SIZE="$(du -h "$FILE" | cut -f1)"
echo "backup: $FILE ($SIZE)"

# Uploaded file bytes (local storage backend) live in a volume, not Postgres.
# `compose run --rm` uses the service image so no extra image has to be pulled.
if docker volume inspect octo-file-data >/dev/null 2>&1; then
  if docker compose -f "$COMPOSE_FILE" run --rm --no-deps -T octo-api \
       tar -czf - -C /tmp/octo-storage . > "$FILES_FILE" 2>/dev/null && [ -s "$FILES_FILE" ]; then
    echo "files:  $FILES_FILE ($(du -h "$FILES_FILE" | cut -f1))"
  else
    echo "WARN: could not archive octo-file-data volume; DB dump is unaffected" >&2
    rm -f "$FILES_FILE"
  fi
fi

# Prune local dumps beyond KEEP, newest first. The file archive for a pruned
# dump is removed alongside it; it is named octo-files-<stamp>.tar.gz.
ls -1t "$BACKUP_DIR"/octo-*.dump 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
  stamp="$(basename "$old")"
  stamp="${stamp#octo-}"
  stamp="${stamp%.dump}"
  rm -f "$old" "$BACKUP_DIR/octo-files-$stamp.tar.gz"
  echo "pruned: $old"
done

# Offsite copy, only if rclone and the remote exist. A failure here is reported
# but does not delete the local dump.
if command -v rclone >/dev/null 2>&1 && rclone listremotes 2>/dev/null | grep -q '^r2:'; then
  if rclone copy "$FILE" "$R2_TARGET/" && { [ ! -f "$FILES_FILE" ] || rclone copy "$FILES_FILE" "$R2_TARGET/"; }; then
    echo "offsite: copied to $R2_TARGET/"
  else
    echo "WARN: offsite copy to $R2_TARGET failed; local dump kept" >&2
  fi
else
  echo "offsite: skipped (rclone or r2: remote not configured)"
fi
