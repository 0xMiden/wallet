#!/usr/bin/env bash
# Set TRUSTED_PROXIES in .env to the address that the backend container sees for nginx on the host:
# the gateway of the Docker network of the container. Then create the container again with the new value.
#
# Usage: scripts/set-trusted-proxies.sh
# The backend container must be in operation (`docker compose up -d`).
# The script replaces the full value of TRUSTED_PROXIES. It does not print the other values of .env.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ ! -f .env ]]; then
  echo ".env does not exist. Copy .env.example to .env and set the values first." >&2
  exit 1
fi

CONTAINER="$(docker compose ps -q backend)"
if [[ -z "$CONTAINER" ]]; then
  echo "The backend container is not in operation. Run 'docker compose up -d --build' first." >&2
  exit 1
fi

GATEWAY="$(docker inspect "$CONTAINER" --format '{{range .NetworkSettings.Networks}}{{.Gateway}} {{end}}' | awk '{print $1}')"
if [[ ! "$GATEWAY" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  echo "Cannot read the gateway address of the Docker network (found: '$GATEWAY')." >&2
  exit 1
fi

if grep -qx "TRUSTED_PROXIES=$GATEWAY" .env; then
  echo "TRUSTED_PROXIES is already $GATEWAY. No change."
  exit 0
fi

# The temporary file contains the secrets of .env. mktemp makes it readable only by this user.
WORK_FILE="$(mktemp)"
trap 'rm -f "$WORK_FILE"' EXIT

awk -v value="$GATEWAY" '
  /^TRUSTED_PROXIES=/ { print "TRUSTED_PROXIES=" value; done = 1; next }
  { print }
  END { if (!done) print "TRUSTED_PROXIES=" value }
' .env > "$WORK_FILE"
# Write through the file, so .env keeps its owner and its permissions.
cat "$WORK_FILE" > .env
echo "Set TRUSTED_PROXIES=$GATEWAY in .env"

docker compose up -d --no-build
echo "The backend container uses the new value."
