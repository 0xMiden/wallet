#!/usr/bin/env bash
# Set up TLS for the backend on Ubuntu: install certbot, get the certificate, install the nginx configuration,
# and set up the certificate renewal. It is safe to run this script again; it skips the steps that are done.
#
# Usage: sudo scripts/setup-certbot.sh <domain> [email]
#   With an email, certbot runs with no questions, and you agree to the Let's Encrypt terms of service.
#   With no email, certbot asks for the email and the agreement.
# Environment: NGINX_CONF_DIR and CERT_DIR, as for generate-nginx-conf.sh.
#
# Before this script: install nginx, and point the DNS record of the domain to this host with port 80 open.
set -euo pipefail

DOMAIN="${1:-}"
EMAIL="${2:-}"
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]]; then
  echo "Usage: sudo $0 <domain> [email]   (for example: sudo $0 backend.example.com admin@example.com)" >&2
  exit 1
fi
if [[ "$EUID" -ne 0 ]]; then
  echo "Run this command with sudo." >&2
  exit 1
fi
for tool in nginx systemctl snap; do
  if ! command -v "$tool" > /dev/null; then
    echo "$tool is not installed. This script is for Ubuntu with nginx installed (see DEPLOYMENT.md)." >&2
    exit 1
  fi
done

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WEBROOT=/var/www/certbot
LIVE_DIR="/etc/letsencrypt/live/$DOMAIN"

echo "==> Install certbot"
if [[ ! -x /snap/bin/certbot ]]; then
  # The apt package is older and has no `reconfigure` command.
  apt-get remove -y certbot > /dev/null 2>&1 || true
  snap install --classic certbot
fi
ln -sf /snap/bin/certbot /usr/bin/certbot
certbot --version

mkdir -p "$WEBROOT"

echo "==> Get the certificate for $DOMAIN"
if [[ -e "$LIVE_DIR/fullchain.pem" ]]; then
  echo "A certificate is already in $LIVE_DIR. This step is skipped."
else
  # nginx cannot load the backend configuration before the certificate exists.
  # Thus the first certificate uses the standalone mode, which needs port 80.
  NGINX_WAS_ACTIVE=false
  if systemctl is-active --quiet nginx; then
    NGINX_WAS_ACTIVE=true
    systemctl stop nginx
    # Start nginx again if certbot fails.
    trap 'systemctl start nginx || true' ERR
  fi
  CERTBOT_ARGS=(certonly --standalone -d "$DOMAIN")
  if [[ -n "$EMAIL" ]]; then
    CERTBOT_ARGS+=(--non-interactive --agree-tos -m "$EMAIL")
  fi
  certbot "${CERTBOT_ARGS[@]}"
  trap - ERR
  if [[ "$NGINX_WAS_ACTIVE" == true ]]; then
    systemctl start nginx
  fi
fi

echo "==> Install the nginx configuration"
bash "$SCRIPT_DIR/generate-nginx-conf.sh" "$DOMAIN"
systemctl reload-or-restart nginx

echo "==> Set up the certificate renewal"
# The renewal uses the webroot mode, because nginx has port 80 from now on.
certbot reconfigure --cert-name "$DOMAIN" --webroot -w "$WEBROOT" --deploy-hook "systemctl reload nginx"
certbot renew --dry-run --cert-name "$DOMAIN"

echo "TLS is set up. Check it from a different computer: curl https://$DOMAIN/health"
