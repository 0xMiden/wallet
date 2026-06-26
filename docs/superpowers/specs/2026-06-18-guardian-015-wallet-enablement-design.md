# Guardian on Miden 0.15 — wallet enablement (design)

**Date:** 2026-06-18
**Branch:** `wiktor/guardian-015` (stacked on `pr153-fix`)
**Status:** approved design, pre-implementation

## Problem

The wallet's Guardian feature crashes at account creation on the 0.15 SDK:
`RuntimeError: memory access out of bounds` inside `MultisigClient.create()`. Root
cause (proven via local devnet e2e + a Falcon/ECDSA A/B): the published
`@openzeppelin/miden-multisig-client` (latest **0.14.9**) targets
`@miden-sdk/miden-sdk@0.14.5`, but the wallet runs `0.15.0-alpha.7`. The OZ client
(written against the 0.14 SDK API) on a 0.15 SDK corrupts memory. It is NOT the
Falcon→ECDSA fix (both schemes crash identically), and there is no 0.15-targeting
OZ client published.

## Key external fact

OpenZeppelin has a near-complete 0.15 port on branch
`origin/miden-v0-15-upgrade` (repo `OpenZeppelin/guardian`, local clone at
`~/miden/private-state-manager`): Rust crates bumped to `miden-protocol/standards/tx
0.15.3`, `miden-client/node-proto 0.15.0`; TS multisig-client to
`@miden-sdk/miden-sdk ^0.15.0` (lockfile resolves to **0.15.0**). It is **not
published to npm and not merged to main**. So this is not a from-scratch port — we
base on this branch.

## Goal / definition of done

Pragmatic unblock of OUR wallet (not an upstream-quality OZ release):
**the `guardian-send-consume` e2e (create guardian account → fund → consume →
send) goes green on devnet.**

Out of scope: features we don't use (switch-guardian beyond what's wired, EVM,
operator dashboard, multi-signer), publishing to npm, merging OZ's branch.

## Version alignment (the crux) — standardize on `0.15.0`

| Component | Current | Target |
| --- | --- | --- |
| Wallet `@miden-sdk/miden-sdk` (+ `@miden-sdk/react`, `resolutions`) | `0.15.0-alpha.7` | **`0.15.0`** |
| OZ TS client `@miden-sdk/miden-sdk` | `^0.15.0` → `0.15.0` | `0.15.0` ✓ |
| OZ Rust server | `miden-client 0.15.0` / `miden-protocol 0.15.3` | unchanged ✓ |
| devnet node | 0.15.x (accepts `0.15.0` CLI + `alpha.7` wallet; gate is major-version) | unchanged ✓ |

`alpha.7 → 0.15.0` is the last prerelease to the stable of the *same* 0.15.0
release — a small bump — and it aligns the wallet with the OZ branch and devnet.

## Approach (chosen: bump wallet SDK up front)

1. **Build the guardian from OZ's 0.15 branch** (local checkout, branch off
   `origin/miden-v0-15-upgrade`):
   - TS packages `guardian-client` + `miden-multisig-client` (`npm i && npm run build`).
   - Rust server docker image (`docker compose build`; one-time ~10–20 min Rust build).
   - Fork `OpenZeppelin/guardian` on GitHub only when we have fixes worth pushing.
2. **Bump the wallet SDK** `0.15.0-alpha.7 → 0.15.0`: `@miden-sdk/miden-sdk`,
   `@miden-sdk/react`, and the `resolutions` override; check `@miden-sdk/vite-plugin`
   for a 0.15-matching version; `yarn install`.
3. **Wire the OZ 0.15 packages into the wallet** via yarn `resolutions`
   (`file:`/`link:`) replacing npm `0.14.9`. The wallet's single-SDK resolution +
   vite alias setup binds them to the wallet's one `0.15.0` SDK instance (verify the
   linked client resolves to the wallet's SDK copy, not a nested one).
4. **Run + fix**: spawn the local 0.15 guardian server (image, `MidenDevnet` +
   Postgres), rebuild the wallet for devnet, run `guardian-send-consume.spec.ts`; fix
   OZ-branch WIP bugs / SDK-bump fallout until green.

## Verification guardrail

After the `alpha.7 → 0.15.0` bump, also re-run the wallet's existing (non-guardian)
e2e (e.g. `send-public`) on devnet, so we catch any agglayer/SDK fallout from the
bump — not just the guardian path.

## Risks

- `alpha.7 → 0.15.0` API drift in the wallet (small, same release; mitigated by the
  guardrail e2e).
- OZ's branch is WIP — may have its own bugs we must patch (→ that's when we fork).
- Single-SDK class identity: the linked OZ client must import the *same*
  `@miden-sdk/miden-sdk` the wallet uses; a nested/duplicate copy reintroduces the
  ABI crash. Verify resolution.
- One-time Rust server build cost (~10–20 min).

## Branch placement

The SDK bump + OZ-link lives on `wiktor/guardian-015`, stacked on `pr153-fix` (which
holds the review fixes + the e2e), so the SDK bump isn't entangled with the
review-fix commit. The guardian-repo work lives on a branch in
`~/miden/private-state-manager` (fork when pushing).
