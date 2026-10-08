# Deploy the backend on Amazon EC2 (Ubuntu)

This guide installs the Miden Wallet backend on one EC2 instance with Ubuntu. Docker Compose runs the server.
nginx on the host terminates TLS and applies the rate limits. Certbot gets the certificate from Let's Encrypt and
renews it.

```
wallet  ──HTTPS 443──▶  nginx (host)  ──HTTP 127.0.0.1:8787──▶  backend (Docker)
```

The examples use the domain `backend.example.com`. Replace it with your domain in each command.

## Before you start

You need these items:

- An EC2 instance with Ubuntu Server 24.04 LTS or 22.04 LTS. A `t3.small` with a 20 GB disk is sufficient.
- An Elastic IP address attached to the instance. Without it, the public IP changes when the instance stops.
- A DNS `A` record that points your domain to the Elastic IP. Certbot fails if the record is not active.
  Check it from your computer: `dig +short backend.example.com` must print the Elastic IP.
- A security group with these inbound rules:

  | Port | Source | Purpose |
  | --- | --- | --- |
  | 22 | Your IP address only | SSH |
  | 80 | `0.0.0.0/0` and `::/0` | Certificate challenge and redirect to HTTPS |
  | 443 | `0.0.0.0/0` and `::/0` | The wallet API |

  Do not open port 8787. A caller that connects to that port bypasses TLS and the rate limits.
- The Transak partner API key and API secret (staging).
- A Sepolia private key for the relayer, with Sepolia ETH for gas. Use a key that is only for this backend.

Connect to the instance:

```bash
ssh -i <key-file>.pem ubuntu@backend.example.com
```

## 1. Clone the backend

The backend is on a feature branch for now. Clone only that branch, and download only the `backend` directory
(a sparse checkout). Git also keeps the small files of the repository root; the other directories are not
downloaded.

```bash
sudo apt-get update
sudo apt-get install -y git make


git clone --branch utkarsh/feat/onramp-offramp-integration --single-branch --depth 1 \
  --filter=blob:none --sparse https://github.com/0xMiden/wallet.git
cd wallet
git sparse-checkout set backend
cd backend
```

All later commands run from `wallet/backend`, unless the step gives a different directory.

## 2. Install Docker

Install Docker Engine and the Compose plugin from the Docker repository:

```bash
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" |
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

Let the `ubuntu` user run Docker, then log out and log in again:

```bash
sudo usermod -aG docker ubuntu
exit
```

After the new login, make sure that Docker works:

```bash
cd wallet/backend
docker compose version
```

## 3. Set the environment

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

Set these values. Keep the defaults for the other keys.

| Key | Value |
| --- | --- |
| `TRANSAK_API_KEY` | The Transak partner API key |
| `TRANSAK_API_SECRET` | The Transak partner API secret |
| `RELAYER_PRIVATE_KEY` | The Sepolia relayer key (`0x` + 64 hex) |
| `ALLOWED_ORIGINS` | The origins of the wallet surfaces that call the API, separated by commas. Empty permits all origins. |
| `TRUSTED_PROXIES` | Leave empty now. Step 5 sets it. |

Compose sets `PORT` and `DB_PATH` itself. The values of these two keys in `.env` have no effect.

## 4. Start the backend

```bash
docker compose up -d --build
docker compose logs --tail 20 backend
curl http://127.0.0.1:8787/health
```

The last command must print `{"ok":true}`. The log must show `worker_started` and `server_started`.

## 5. Trust the nginx proxy

The backend reads the client IP from the `X-Forwarded-For` header only when the request comes from a trusted
proxy. nginx runs on the host, and the backend runs in a container. For this reason the backend sees each request
come from the gateway address of its Docker network, not from `127.0.0.1`.

Run this command while the backend is in operation:

```bash
make set-trusted-proxies
```

The command reads the gateway address from the backend container and writes it to `.env`, for example
`TRUSTED_PROXIES=172.18.0.1`. It replaces the full value of the key. Then it creates the container again, so the
backend stops for a few seconds. When the value is already correct, the command changes nothing.

If this value is wrong, the backend sends a private address to Transak as the user IP, and the Transak widget
can reject the session. Do this step again if you delete the Docker network (`docker compose down`), because the
gateway address can change.

## 6. Install nginx

```bash
sudo apt-get install -y nginx
sudo rm /etc/nginx/sites-enabled/default
sudo systemctl enable --now nginx
```

The second command removes the default welcome site. The third command starts nginx now and on each boot.

## 7. Set up certbot and TLS

```bash
sudo make setup-certbot DOMAIN=backend.example.com EMAIL=admin@example.com
```

The command does these steps:

1. It installs certbot as a snap.
2. It gets the certificate from Let's Encrypt. It stops nginx for a short time for this step.
3. It writes `/etc/nginx/conf.d/miden-wallet-backend.conf` from the template `nginx.conf`, checks it, and reloads
   nginx.
4. It sets up the automatic renewal and does a test renewal.

`EMAIL` is the address for expiry notices. With `EMAIL`, certbot asks no questions, and you agree to the
[Let's Encrypt terms of service](https://letsencrypt.org/repository/). Without `EMAIL`, certbot asks for the
address and for the agreement. You can run the command again: it skips the steps that are done.

The last line of the output must start with `TLS is set up`. If certbot fails, check the DNS record and the inbound rule
for port 80 of the security group.

A Let's Encrypt certificate is valid for 90 days. The certbot snap installs a timer that tries a renewal two times
each day, and nginx reloads after each renewal. No manual work is necessary.

## 8. Make sure that the deployment works

Run these commands from your computer, not from the instance:

```bash
curl https://backend.example.com/health          # {"ok":true}
curl -I http://backend.example.com/health         # 301, Location: https://backend.example.com/health
curl -m 5 http://backend.example.com:8787/health  # must fail: the port is closed
```

Test the rate limit. The first 10 requests print 400 (the body is empty). The subsequent requests print 429:

```bash
for i in $(seq 1 12); do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -d '{}' \
    https://backend.example.com/transak/challenge
done
```

Then build the wallet with `BACKEND_URL=https://backend.example.com`.

## Update the backend

```bash
cd ~/wallet
git pull
cd backend
docker compose build
docker compose stop backend
docker compose up -d --no-build
```

To change only the Agglayer values, edit `config.json` and restart the container. No image build is necessary.
The wallet must have the same values in its build (see `config.json` in `README.md`).

```bash
docker compose restart backend
```

If `nginx.conf` changed, install it again and reload nginx:

```bash
sudo make generate-nginx-conf DOMAIN=backend.example.com
sudo nginx -s reload
```

## Operation

- **Logs of the backend:** `docker compose logs -f backend`.
- **Logs of nginx:** `/var/log/nginx/access.log` and `/var/log/nginx/error.log`. A rejected request shows as
  `limiting requests` in the error log.
- **Restart after a reboot:** Docker and nginx start automatically. The container has `restart: unless-stopped`.
- **Backup:** see "Backup and restore" in `README.md`. The order database is in the Docker volume
  `miden-wallet-backend_backend-data`. `docker compose down -v` deletes it.
- **Relayer balance:** the relayer pays the Sepolia gas of each bridge. Monitor its ETH balance. The address is
  the `relayer` field of the `worker_started` log line.
