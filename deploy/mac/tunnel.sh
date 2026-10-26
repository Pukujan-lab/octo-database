#!/usr/bin/env bash
# Run the Cloudflare Tunnel connector for Octo on this host.
#
# Octo has its own tunnel (`octo-mac`) whose only ingress rule maps
# octodb.design-bakery.com to `http://octo-web:80`. It must not share a tunnel
# with another host: a shared tunnel balances requests across every connector,
# and the two hosts hold different session and Google OAuth secrets, so a
# sign-in handled by the other host either fails the token exchange or returns
# a session the Mac cannot verify. Attaching the connector to the network the
# edge overlay uses (study-os_edge, where octo-web is aliased) is all the
# routing needed.
#
# The connector dials outbound, so no inbound port is opened and the host needs
# no public address.
#
# Usage:
#   ./tunnel.sh            start (or restart) the connector
#   ./tunnel.sh stop       stop and remove it
#   ./tunnel.sh status     show container state and recent log lines
#
# The tunnel token comes from TUNNEL_TOKEN in deploy/gravebuster/.env (Cloudflare
# Zero Trust -> Networks -> Tunnels -> <tunnel> -> Install connector).

set -euo pipefail

# A non-login ssh shell's PATH omits /usr/local/bin, where Docker Desktop installs
# its CLI; launchd supplies its own PATH for the timer but a manual run does not.
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../gravebuster/.env"
NETWORK="study-os_edge"
CONTAINER="octo-cloudflared"

usage() { sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

case "${1:-start}" in
  stop)
    docker rm -f "$CONTAINER" >/dev/null 2>&1 && echo "stopped: $CONTAINER" || echo "not running: $CONTAINER"
    exit 0
    ;;
  status)
    docker ps -a --filter "name=^${CONTAINER}$" --format "{{.Names}}|{{.Status}}"
    docker logs --tail 15 "$CONTAINER" 2>&1 || true
    exit 0
    ;;
  start) ;;
  *) usage; exit 2 ;;
esac

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found" >&2
  exit 1
fi

TUNNEL_TOKEN="$(grep -E '^TUNNEL_TOKEN=' "$ENV_FILE" | cut -d= -f2- | tr -d ' "\r' || true)"
# Must be exported: `docker run -e TUNNEL_TOKEN` with no value reads it from the
# docker client's environment, which only sees exported variables.
export TUNNEL_TOKEN
if [ -z "$TUNNEL_TOKEN" ]; then
  echo "ERROR: TUNNEL_TOKEN is not set in $ENV_FILE" >&2
  echo "Get it from Cloudflare Zero Trust -> Networks -> Tunnels -> <tunnel> -> Install connector." >&2
  exit 1
fi

docker network inspect "$NETWORK" >/dev/null 2>&1 || docker network create "$NETWORK" >/dev/null

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

# The token is passed in the environment rather than the command line so it does
# not appear in `docker inspect` / the process table.
docker run -d --name "$CONTAINER" --restart unless-stopped \
  --network "$NETWORK" \
  -e TUNNEL_TOKEN \
  cloudflare/cloudflared:latest tunnel --no-autoupdate run >/dev/null

echo "started: $CONTAINER on network $NETWORK"
sleep 5
docker logs --tail 20 "$CONTAINER" 2>&1 | sed 's/\(token=\)[^ ]*/\1<redacted>/g' || true
