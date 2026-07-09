# Design: PR-level fully-local E2E blockchain gate

**Date:** 2026-07-01
**Branch:** `feat/local-e2e-ci`
**Status:** Implemented in PR #305 (Tier-1 + Tier-2 both shipped in one PR).

> **Implementation deltas** (this spec was written before the build; the code is authoritative):
> - **Guardian needs Postgres.** The published `ghcr.io/openzeppelin/guardian:v0.15.0`
>   image is postgres-backed, so the stack runs a `guardian-postgres` service — §9's
>   "no genesis/Postgres" is wrong for the published image.
> - **Prover host port is `:50052`, not `:50051`.** The host-network guardian binds
>   host `:50051` for its gRPC, so the prover's host publish moved to `:50052` and the
>   wallet's localnet proving endpoint points there (§5/§8 say `:50051`; container port
>   is still `:50051`).
> - **Playwright `--retries=1`** on the two CI spec steps (base config is `retries:0`);
>   §7 said `retries: 1` as the budget, which matches.
> - **Tier-2 guardian was folded into this PR**, not deferred to a separate "PR C" (§12).

## 1. Problem & motivation

The wallet's `E2E Blockchain` workflow is **main-only** and runs the Chrome + iOS
suites against **live** infrastructure: `rpc.{testnet,devnet}.miden.io`, hosted
tx-provers, hosted note-transport, and OpenZeppelin's **hosted** guardian. That
has three costs:

- **No per-PR signal.** Blockchain regressions are only caught after merge (as
  the #303 → #304 guardian-onboarding break demonstrated).
- **Flakiness.** Live networks intermittently fail; the workflow's gate is
  literally "at least one of devnet/testnet passed" *because* live networks
  flake.
- **External coupling.** testnet's guardian being on an older server made the
  guardian E2E chronically expected-red.

**Goal:** a **hermetic, fully-local** replica of the blockchain E2E run — node,
prover, note-transport, faucet (and, in a fast-follow, guardian) all local — that
runs on **every PR** as a deterministic, required gate.

## 2. Key finding: this is orchestration, not research

The wallet is **already wired for a localnet**: `MIDEN_NETWORK_NAME.LOCALNET`, the
`http://localhost:*` endpoint maps in `src/lib/miden-chain/constants.ts`, the
`E2E_NETWORK=localhost` CLI path, and `test:e2e:blockchain:localhost` scripts all
exist. Every port the wallet expects has a **version-matched local source**. The
work is standing the stack up in CI and closing a handful of version-compat gaps
— not inventing anything.

## 3. Decisions (resolved)

| # | Decision | Resolution |
|---|---|---|
| D1 | Platform scope | **Chrome-only, `ubuntu-latest`.** The stack is Linux-docker; macOS mobile runners can't run it without native node binaries. Mobile stays on the existing main-only live run. |
| D2 | Spec breadth | **Full public + private core** (7 specs). Requires node + prover + note-transport. |
| D3 | Orchestration | **`docker compose up --wait` in-job**, lifting `gateway-fm/miden-agglayer/docker-compose.e2e.yml`. Rejected: GH `services:` (can't express genesis ordering / auth header), native binaries (only needed for mobile). |
| D4 | Guardian | **Tier-2 fast-follow.** Ship node/prover/transport gate first; add local `guardian:v0.15.0` after a verified green create→consume→send. Guardian E2E stays hosted/main-only until then. |
| D5 | Funding | **Keep the CLI-mint faucet path** — the harness already deploys a `TST` faucet and mints via `miden-client-cli`. No faucet service, no genesis pre-fund. |
| D6 | Gate posture | **Required day one**, *earned via burn-in* (§7). Runs **alongside** the main-only live E2E, does not replace it. |

## 4. Prerequisite fix (blocks everything): `localhost` vs `localnet`

`test:e2e:blockchain:build` bakes `MIDEN_NETWORK=${E2E_NETWORK:-testnet}`, so
`E2E_NETWORK=localhost` → `MIDEN_NETWORK='localhost'`. But the wallet enum key is
`localnet` (`MIDEN_NETWORK_NAME.LOCALNET = 'localnet'`), so `'localhost'` is not a
key in `MIDEN_NETWORK_ENDPOINTS` and `getRpcEndpoint()` dereferences `undefined`
and throws. **The localhost extension build is broken today.**

Fix: make the E2E/CLI network token and the wallet enum agree on a single
canonical token (`localnet`) end-to-end — the `E2E_NETWORK` value, the CLI
`networkFlag`, and the baked `MIDEN_NETWORK`. Ships as its own small PR first so
the rest builds on a working localhost bundle.

## 5. Architecture — the Tier-1 local stack

All services on `ubuntu-latest`, one Linux bridge network, brought up with
`docker compose up --wait` (healthchecks gate readiness). Reference topology:
`gateway-fm/miden-agglayer/docker-compose.e2e.yml`.

| Service | Port | Source | Notes |
|---|---|---|---|
| node / validator / sequencer / ntx-builder | 57291 (RPC) | `ghcr.io/0xmiden/miden-{node,validator,ntx-builder}` @ **exact `v0.15.0`** | Retag bare names or `image:` override. Genesis auto-bootstraps. Sequencer↔ntx **shared auth header** (`--rpc.network-tx-auth-header-value == --rpc.auth-header-value`). |
| remote tx-prover | 50051 | `ghcr.io/0xmiden/miden-remote-prover` @ `v0.15.0` | `--kind=transaction --capacity=16` (avoids "proof queue full" under concurrency). Add `ports: ["127.0.0.1:50051:50051"]` override (base compose only publishes 57291). |
| note-transport | 57292 | build-from-source `0xMiden/note-transport-service` | `miden-note-transport-node-bin`, `:memory:` sqlite, no flags. **Cache the build.** Do NOT use its docker-compose (grafana squats on :3000). |
| faucet | — | **none** | Harness deploys a `TST` faucet via `miden-client new-account -p basic-fungible-faucet --deploy` and mints via CLI. `:8080` is UI-only, never touched. |

The Chrome extension is built for `localnet` (post-§4 fix); the wallet's
`guardian_url_setting` / endpoint overrides already let the harness point it at
local ports (the harness comments already anticipate a "guardian spawned by the
CI job").

## 6. CI job — `.github/workflows/pr-e2e-local.yml`

`on: pull_request`. Single Chrome job on `ubuntu-latest`:

1. Reconcile network token = `localnet`; build the Chrome extension for localnet.
2. Install / restore-cache `miden-client-cli` at the **rev matched** to node
   `v0.15.0` + SDK `0.15.2`.
3. `docker compose up --wait` (node topology + prover + note-transport).
4. Run the **7 core specs**: `wallet-lifecycle`, `mint-and-balance`,
   `send-public`, `send-public-local-prove`, `multi-account`, `multi-claim`,
   `send-private`.
5. Upload artifacts (playwright report, container logs) on failure; `docker
   compose down` teardown.

**Budget:** ~10–12 min (image pull + `up --wait` + extension build + core specs),
GHCR/docker-layer + CLI-build cached. Runs **alongside** the main-only live E2E.

## 7. Determinism & the "required day one" posture

A blocking gate that flakes is worse than no gate, so determinism is load-bearing:

- **Exact** version pins everywhere (never floating tags): node images, prover,
  transport, CLI rev, `--locked`.
- Healthchecks + `up --wait` before any test; prover `--capacity` headroom;
  deterministic single-node block cadence (`block.interval`, `batch.interval`).
- Playwright `retries: 1`, tight 60s timeouts.

**Burn-in before the branch-protection flip.** The gate lands *required* (per D6),
but we earn the flip: prove the job green over **~8–10 consecutive runs** on
`feat/local-e2e-ci` before marking the check required in branch protection. It is
required as soon as it is required — we just don't flip the bit blind. If flakes
appear, we fix determinism, we do **not** loosen the gate to "at least one."

## 8. Compatibility gates to close in a first spike

Each is closed by **one green localhost run**; none blocks *starting* Tier-1:

- Exact node tag ↔ CLI rev ↔ SDK `0.15.2` triple (mismatch → CLI-deployed faucet
  renders "Unknown", symbol selectors break).
- LOCALNET bech32 HRP round-trip (wallet encodes with `NetworkId.testnet()` —
  confirm it round-trips with node/CLI output, or send/claim silently breaks).
- note-transport `0.14`-proto vs `0.15.2`-SDK wire compat (prove via a real
  private send + consume).
- Whether the browser wallet delegates proving on localnet (`delegateProving`) —
  decides whether `:50051` is even exercised or the WASM local-prove path covers
  it.

## 9. Tier-2 fast-follow — local guardian

The "0.14-only guardian image" premise is **stale**: `ghcr.io/openzeppelin/guardian:v0.15.0`
exists (anonymously pullable), supports `NetworkType::MidenLocal`
(`GUARDIAN_NETWORK_TYPE=MidenLocal` → `localhost:57291`), self-generates its
Falcon+ECDSA keystore on first boot (no genesis needed). **Correction (post-build):**
the published image is postgres-backed, so a `guardian-postgres` service IS required
(via `DATABASE_URL`) — the "no Postgres" premise below is wrong. Fast-follow work:

- Add the guardian service (`--network host`, started **after** the node — eager
  connect at `.build()`), extend the gate to `guardian-send-consume`.
- Close the `0.15.0-rc.0` (what the wallet ships, `@openzeppelin/*`) vs image
  `0.15.0` MASM/wire-parity check first.
- Optional small patch: `GUARDIAN_MIDEN_RPC_URL` override in guardian
  `network/mod.rs` to drop the hardcoded `localhost:57291` (removes the
  `--network host` requirement).

Until Tier-2 lands, guardian E2E stays hosted on the main-only live run.

## 10. Out of scope

- **Mobile** local E2E (needs native macOS node binaries) — stays on the existing
  main-only live-network run.
- **Replacing** the main E2E — the live-network run stays alongside as the
  real-network signal.

## 11. Prior art to lift (don't invent)

- `gateway-fm/miden-agglayer/docker-compose.e2e.yml` — the copy-paste node
  topology (pinned images, healthchecks, `up --wait`, sequencer↔ntx auth header,
  `--capacity=16`).
- `0xMiden/node/docker-compose.yml` (`v0.15.0`) — canonical topology, genesis
  auto-bootstrap; gotchas: bare image names, only 57291 published.
- miden-client `Makefile` `start-node-background` / `start-prover-background` /
  `start-note-transport-bg.sh` — version-locked to the CLI rev the wallet installs.

## 12. Delivery order

1. **PR A** — the `localhost`/`localnet` naming fix (§4). Small, standalone.
2. **PR B** — Tier-1: compose stack + `pr-e2e-local.yml` + the 7 core specs. Lands
   as a non-required check; close the §8 compat gates; burn-in ~8–10 green runs;
   then flip the check to required in branch protection (§7).
3. **PR C** — Tier-2: local guardian + `guardian-send-consume` (§9).
