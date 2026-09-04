# Local Miden Stack — E2E development environment

Hermetic local Miden stack for running the wallet's core Chrome E2E specs without live network access.
CI (`pr-e2e-local.yml`) is the source of truth — this README documents how to run the same stack locally.

## Version pins

Every pin lives in `versions.env` (node + note-transport + guardian) or `package.json`
(`midenClientCliVersion` / `midenClientCliGit.rev`). The table below is a snapshot of what
those files currently say; when they disagree, the files win.

| Component | Pin | Source |
|---|---|---|
| `miden-node` / `miden-validator` / `miden-ntx-builder` / `miden-remote-prover` | built from **miden-client `v0.16.0-rc.1`** (`efebb6a7`) | `NODE_SRC_REPO` / `NODE_SRC_REF` in `versions.env` |
| `note-transport-service` | `v0.5.0-rc.1` | `NOTE_TRANSPORT_REF` in `versions.env` |
| `miden-client-cli` | `0.16.0-rc.3` (rev `4fec7b22`) | `package.json` `midenClientCliVersion` / `midenClientCliGit.rev` |
| `guardian` (Tier-2) | `v0.17.0-rc.3` | `GUARDIAN_IMAGE_TAG` in `versions.env` |

> **No node image tag.** The published `ghcr.io/0xmiden/*` node images lag the node the SDK is
> built against, so the node is **compiled and run from source** — miden-client's
> `scripts/start-test-node.sh` at `NODE_SRC_REF`. There is deliberately no `NODE_IMAGE_TAG`.

> **Keep `GUARDIAN_IMAGE_TAG` in lockstep with the client.** The guardian server image and
> `@openzeppelin/miden-multisig-client` in `package.json` have to agree on the MASM procedure
> roots, and the guardian's version line is independent of Miden's — `v0.17.0-rc.3` is the first
> release whose guarded accounts come from the upstream `AuthGuardedMultisig` component, which is
> what lets miden-client classify them and commit their fee conversion info. Bumping one without
> the other still installs and starts cleanly; it fails at runtime on procedure-root mismatch.

## Prerequisites

- `cargo` + `rustc` (CI pins 1.98.0) — for building the node, the CLI and note-transport
- `protobuf-compiler`, `clang`, `cmake` — node build deps
- `nc` (netcat) — for the port-readiness wait in `run-note-transport.sh`
- Docker with Compose v2 (`docker compose`) — only for the optional Tier-2 guardian profile

## Running the stack locally

### 1. Bring up the node + prover

The node runs as a **host process**, not in compose. Mirror what
`.github/actions/run-local-node` does:

```bash
set -a; . playwright/e2e/local-stack/versions.env; set +a
git clone --filter=blob:none "$NODE_SRC_REPO" /tmp/miden-client
git -C /tmp/miden-client checkout "$NODE_SRC_REF"

# The wallet's localnet prover endpoint is :50052 (the guardian binds :50051), and the
# sequencer must listen on 0.0.0.0 so bridge-networked guardian containers can reach it.
f=/tmp/miden-client/scripts/start-test-node.sh
sed -i '' 's/^PROVER_PORT=50051$/PROVER_PORT=50052/' "$f"          # GNU sed: drop the ''
sed -i '' 's|sequencer --rpc.listen "$RPC"|sequencer --rpc.listen "0.0.0.0:57291"|' "$f"

cd /tmp/miden-client && ./scripts/start-test-node.sh --background
```

The script cargo-installs the four node binaries at the rev its own `Cargo.lock` pins,
generates genesis, seeds each component's DB, and starts validator + sequencer + ntx-builder
+ prover. A cold build takes ~28 min; the build output under `target/test-node` is what CI
caches. Logs land in `/tmp/miden-client/target/test-node/data/logs`.

### 2. Start note-transport

```bash
playwright/e2e/local-stack/run-note-transport.sh
```

Clones + builds `note-transport-service` at `NOTE_TRANSPORT_REF` on first run (several
minutes); subsequent runs reuse the cached binary under
`${RUNNER_TEMP:-/tmp}/note-transport/target/release/`. The binary's name depends on the
pinned ref, so the script resolves it from `bin/node/Cargo.toml` rather than hardcoding one.
Waits until `:57292` is open.

### 3. Build the extension for localnet

```bash
E2E_NETWORK=localhost yarn test:e2e:blockchain:build
```

### 4. Run the core specs

```bash
E2E_NETWORK=localhost yarn test:e2e:blockchain:run
```

`playwright.e2e.config.ts` ignores `guardian-*.spec.ts` and the `swap/`, `bridge/`, `earn/`
and `resilience/` subsuites, so this is the core set: `wallet-lifecycle`, `mint-and-balance`,
`send-public`, `send-public-local-prove`, `send-private`, `multi-account`, `multi-claim`,
`recall-reclaim`, `contacts-send`, `group-claim`, `history-cancel`, `receive-address`,
`settings-toggles`, `unlock-lockout`.

### 5. (Tier-2) Guardian specs — optional, currently quarantined

The guardian specs need a local guardian, which is the only thing
`docker-compose.local.yml` still provides (every service in it is behind the `guardian` or
`guardian-switch` profile, so a bare `up` selects nothing). See the quarantine note above
before spending time here.

```bash
cd playwright/e2e/local-stack
docker compose --env-file versions.env -f docker-compose.local.yml --profile guardian up -d guardian
GUARDIAN_URL=http://localhost:3000 E2E_NETWORK=localhost yarn test:e2e:guardian:run
```

The switch/fault specs additionally need guardian-B (`--profile guardian-switch`), which is
what `pr-e2e-guardian-lifecycle.yml` brings up.

### 6. Tear down

```bash
cd playwright/e2e/local-stack
docker compose --env-file versions.env --profile guardian -f docker-compose.local.yml down -v
kill "$(cat /tmp/note-transport.pid)"
pkill -f 'miden-(node|validator|ntx-builder|remote-prover)'   # the host-process node
```

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `NODE_SRC_REPO` / `NODE_SRC_REF` | from `versions.env` | miden-client repo + rev the test node is built from |
| `NOTE_TRANSPORT_REPO` / `NOTE_TRANSPORT_REF` | from `versions.env` | note-transport repo + tag `run-note-transport.sh` builds |
| `MIDEN_NTX_AUTH` | `e2e-ntx-secret` | Shared auth header: sequencer `--rpc.network-tx-auth-header-value` = ntx-builder `--rpc.auth-header-value` |
| `MIDEN_NODE_BLOCK_INTERVAL` / `MIDEN_NODE_BATCH_INTERVAL` | node defaults | Block/batch cadence; the CI matrix runs a `500ms` leg for the timing-critical private-note specs |
| `RUNNER_TEMP` | `/tmp` | Where the note-transport build cache lives (set automatically by GitHub Actions) |
| `GUARDIAN_IMAGE_TAG` | from `versions.env` | ghcr.io/openzeppelin/guardian tag (Tier-2 `guardian` profile) |
| `GUARDIAN_URL` | `http://localhost:3000` | Guardian endpoint the guardian specs point the wallet at |

## Ports

| Service | Host port | Protocol |
|---|---|---|
| node RPC (sequencer) | `127.0.0.1:57291` | gRPC |
| remote prover | `127.0.0.1:50052` | gRPC |
| note-transport | `127.0.0.1:57292` | HTTP/gRPC |
| guardian (Tier-2) | `:3000` (host network) | HTTP |
| guardian-postgres (Tier-2) | `127.0.0.1:5432` | postgres |
| guardian-b (Tier-3) | `127.0.0.1:3001` HTTP / `127.0.0.1:50053` gRPC | HTTP/gRPC |
| guardian-b-postgres (Tier-3) | `127.0.0.1:5433` | postgres |

The node/prover/transport host ports match `playwright/e2e/config/environments.ts`
`localhost` config. The prover is patched off its `:50051` default because the host-network
guardian binds `:50051` for its gRPC.
