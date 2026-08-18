# Local Miden Stack — E2E development environment

Hermetic local Miden stack for running the wallet's core Chrome E2E specs without live network access.
CI (`pr-e2e-local.yml`) is the source of truth — this README documents how to run the same stack locally.

## Version pins (resolved 2026-07-02)

| Component | Pin | Source |
|---|---|---|
| `miden-node` / `miden-validator` / `miden-ntx-builder` / `miden-remote-prover` | `v0.15.0` | `ghcr.io/0xmiden/*` — confirmed on all four images |
| `note-transport-service` | `v0.4.1` | `0xMiden/note-transport-service` — pins `miden-protocol = "0.15"`, matching node `v0.15.0` |
| `miden-client-cli` | `rev 733720a7` (`0.14.8`) | `package.json` `midenClientCliGit.rev` |
| `guardian` (Tier-2) | `v0.15.0` | `ghcr.io/openzeppelin/guardian`, `GUARDIAN_IMAGE_TAG` in `versions.env` |

> **Compat concern:** The CLI is at `0.14.8` while the node images are at `v0.15.0`. The compat gate is verified by the `mint-and-balance` + `send-public` specs (faucet symbol rendering). If those are red, the CLI rev needs to be bumped in `package.json`.

## Prerequisites

- Docker with Compose v2 (`docker compose`)
- `cargo` + `rustc` (stable) — for building `note-transport`
- `nc` (netcat) — for the port-readiness wait in `run-note-transport.sh`

## Running the stack locally

### 1. Bring up the node + prover

```bash
cd playwright/e2e/local-stack
docker compose --env-file versions.env -f docker-compose.local.yml up --wait --wait-timeout 300
```

Bootstrap runs once and is cached in the `node-data` Docker volume. Subsequent starts skip it.

### 2. Start note-transport

```bash
playwright/e2e/local-stack/run-note-transport.sh
```

Clones + builds `note-transport-service @ v0.4.1` on first run (several minutes); subsequent runs use the cached binary at `${RUNNER_TEMP:-/tmp}/note-transport/target/release/miden-note-transport-node`. Waits until `:57292` is open.

### 3. Build the extension for localnet

```bash
E2E_NETWORK=localhost yarn test:e2e:blockchain:build
```

### 4. Run the core specs

```bash
E2E_NETWORK=localhost yarn test:e2e:blockchain:run
```

Specs: `wallet-lifecycle`, `mint-and-balance`, `send-public`, `send-public-local-prove`, `multi-account`, `multi-claim`, `send-private`.

### 5. (Tier-2) Guardian specs — optional

The guardian specs (`guardian-send-consume`) need a local guardian (in the `guardian`
compose profile, so it is skipped by the base `up --wait`). Bring it up after the node
is ready, then run them:

```bash
docker compose --env-file versions.env -f docker-compose.local.yml --profile guardian up -d guardian
GUARDIAN_URL=http://localhost:3000 E2E_NETWORK=localhost yarn test:e2e:guardian:run
```

### 6. Tear down

```bash
cd playwright/e2e/local-stack
docker compose --env-file versions.env --profile guardian -f docker-compose.local.yml down -v
kill "$(cat /tmp/note-transport.pid)"
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `NODE_IMAGE_TAG` | from `versions.env` | ghcr.io image tag for all node components |
| `MIDEN_NTX_AUTH` | `e2e-ntx-secret` | Shared auth header: sequencer `--rpc.network-tx-auth-header-value` = ntx-builder `--rpc.auth-header-value` |
| `MIDEN_REMOTE_PROVER_URL` | `http://tx-prover:50051` | Override the tx-prover URL seen by ntx-builder |
| `RUNNER_TEMP` | `/tmp` | Where the note-transport build cache lives (set automatically by GitHub Actions) |
| `GUARDIAN_IMAGE_TAG` | from `versions.env` | ghcr.io/openzeppelin/guardian tag (Tier-2 `guardian` profile) |
| `GUARDIAN_URL` | `http://localhost:3000` | Guardian endpoint the guardian specs point the wallet at |

## Ports

| Service | Host port | Protocol |
|---|---|---|
| node RPC (sequencer) | `127.0.0.1:57291` | gRPC |
| remote prover | `127.0.0.1:50052` (container `:50051`) | gRPC |
| note-transport | `127.0.0.1:57292` | HTTP/gRPC |
| guardian (Tier-2) | `:3000` (host network) | HTTP |
| guardian-postgres (Tier-2) | `127.0.0.1:5432` | postgres |

The node/prover/transport host ports match `playwright/e2e/config/environments.ts`
`localhost` config. The prover's host `:50052` maps to container `:50051`; it moved off
`:50051` because the host-network guardian binds `:50051` for its gRPC.
