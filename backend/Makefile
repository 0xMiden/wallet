.PHONY: generate-nginx-conf set-trusted-proxies setup-certbot config-change

# Replace one value in config.json. The command does not restart the backend.
# Usage: make config-change <section> <key> <new-value>
# Example: make config-change agglayer-testnet midenNetworkId 87
# make reads the words after the target as more targets. These lines make them arguments, only for this target.
ifeq (config-change,$(firstword $(MAKECMDGOALS)))
CONFIG_CHANGE_ARGS := $(wordlist 2,$(words $(MAKECMDGOALS)),$(MAKECMDGOALS))
$(eval $(CONFIG_CHANGE_ARGS):;@:)
endif
config-change:
	@bash scripts/config-change.sh $(CONFIG_CHANGE_ARGS)

# Ubuntu: install certbot, get the certificate, install the nginx configuration and set up the renewal.
# Usage: sudo make setup-certbot DOMAIN=backend.example.com EMAIL=admin@example.com
# EMAIL is optional. With EMAIL, certbot asks no questions and you agree to the Let's Encrypt terms of service.
# Optional: NGINX_CONF_DIR and CERT_DIR, as for generate-nginx-conf.
setup-certbot:
	@NGINX_CONF_DIR="$(NGINX_CONF_DIR)" CERT_DIR="$(CERT_DIR)" bash scripts/setup-certbot.sh "$(DOMAIN)" "$(EMAIL)"

# Set TRUSTED_PROXIES in .env to the gateway address of the Docker network, then create the container again.
# The backend container must be in operation. Usage: make set-trusted-proxies
set-trusted-proxies:
	@bash scripts/set-trusted-proxies.sh

# Generate the nginx site configuration from nginx.conf and install it in the nginx include directory.
# Usage: sudo make generate-nginx-conf DOMAIN=backend.example.com
# Optional: NGINX_CONF_DIR (default /etc/nginx/conf.d), CERT_DIR (default /etc/letsencrypt/live/<DOMAIN>).
generate-nginx-conf:
	@NGINX_CONF_DIR="$(NGINX_CONF_DIR)" CERT_DIR="$(CERT_DIR)" bash scripts/generate-nginx-conf.sh "$(DOMAIN)"
