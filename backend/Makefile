.PHONY: generate-nginx-conf

# Generate the nginx site configuration from nginx.conf and install it in the nginx include directory.
# Usage: sudo make generate-nginx-conf DOMAIN=backend.example.com
# Optional: NGINX_CONF_DIR (default /etc/nginx/conf.d), CERT_DIR (default /etc/letsencrypt/live/<DOMAIN>).
generate-nginx-conf:
	@NGINX_CONF_DIR="$(NGINX_CONF_DIR)" CERT_DIR="$(CERT_DIR)" bash scripts/generate-nginx-conf.sh "$(DOMAIN)"
