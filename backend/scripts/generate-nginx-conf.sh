#!/usr/bin/env bash
# Generate the nginx site configuration from the template (nginx.conf) and install it.
#
# Usage: scripts/generate-nginx-conf.sh <domain>
# Environment:
#   NGINX_CONF_DIR  The directory that nginx includes in its `http` block. Default: /etc/nginx/conf.d.
#   CERT_DIR        The directory of fullchain.pem and privkey.pem. Default: /etc/letsencrypt/live/<domain>.
#
# The script checks the result with `nginx -t`. It does not reload nginx.
set -euo pipefail

DOMAIN="${1:-}"
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  echo "Usage: $0 <domain>   (for example: $0 backend.example.com)" >&2
  exit 1
fi

NGINX_CONF_DIR="${NGINX_CONF_DIR:-/etc/nginx/conf.d}"
CERT_DIR="${CERT_DIR:-/etc/letsencrypt/live/$DOMAIN}"
if [[ "$CERT_DIR" == *"|"* || "$CERT_DIR" == *"&"* || "$CERT_DIR" =~ [[:space:]] ]]; then
  echo "CERT_DIR must not contain '|', '&' or a space" >&2
  exit 1
fi

TEMPLATE="$(cd "$(dirname "$0")/.." && pwd)/nginx.conf"
TARGET="$NGINX_CONF_DIR/miden-wallet-backend.conf"

if [[ ! -d "$NGINX_CONF_DIR" ]]; then
  echo "$NGINX_CONF_DIR is not a directory. Set NGINX_CONF_DIR to the nginx include directory." >&2
  exit 1
fi
if [[ ! -w "$NGINX_CONF_DIR" ]]; then
  echo "Cannot write to $NGINX_CONF_DIR. Run this command with sudo." >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__CERT_DIR__|$CERT_DIR|g" "$TEMPLATE" > "$WORK_DIR/generated.conf"

HAD_PREVIOUS=false
if [[ -f "$TARGET" ]]; then
  cp -p "$TARGET" "$WORK_DIR/previous.conf"
  HAD_PREVIOUS=true
fi

install -m 644 "$WORK_DIR/generated.conf" "$TARGET"
echo "Installed $TARGET"

for file in fullchain.pem privkey.pem; do
  if [[ ! -e "$CERT_DIR/$file" ]]; then
    echo "Warning: $CERT_DIR/$file does not exist. nginx cannot load this configuration without it." >&2
  fi
done

if ! command -v nginx > /dev/null; then
  echo "nginx is not in PATH, so the configuration is not checked." >&2
  exit 0
fi

if ! nginx -t; then
  # Do not leave a configuration that stops the next nginx reload.
  if [[ "$HAD_PREVIOUS" == true ]]; then
    cp -p "$WORK_DIR/previous.conf" "$TARGET"
    echo "The check failed. The previous $TARGET is restored." >&2
  else
    rm -f "$TARGET"
    echo "The check failed. $TARGET is removed." >&2
  fi
  exit 1
fi

echo "The configuration is valid. Apply it with: sudo nginx -s reload"
