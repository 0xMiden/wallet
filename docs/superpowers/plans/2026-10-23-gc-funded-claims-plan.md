# Recoverable GC claims implementation plan

> **For agentic workers:** Use superpowers:executing-plans for inline integration and superpowers:test-driven-development for protocol and wallet behavior.

**Goal:** Deliver exact-fee, recoverable Testnet weekly claims in Bread and publish the canonical GC token identity in separate reviewable PRs.

**Architecture:** A self-funded custom network note replaces unreclaimable automatic sponsorship. A narrowly extended issuer authentication settles exact protocol fees and returns change inside each GC receipt, preserving network-account conventions. Bread uses its existing Guardian request, transaction and receive pipelines.

**Tech Stack:** Pinned Miden protocol/standards/testing 0.17.1, Rust 1.98.1; published Web SDK 0.17.5; existing React/Guardian wallet backend; token-list JSON.

**Spec:** [Recoverable Testnet GC claims](../specs/2026-10-23-gc-funded-claims.md), continuing approved wallet #1452.

## Global constraints

- Testnet only. Keep Claim disabled until protocol proof and real node execution gates pass. Brian approved allocation by the signed network week even when delivery arrives after Monday.
- 10,000,000 units = 10 GC, six decimals; one allocation per authenticated account/week, independent of balance.
- No user-fee subsidy, retained surplus, silent approval rollover, optimistic credit or second transaction engine.
- Keep wallet-explore as catalog source. Verification belongs to token-list.
- Wallet changes remain stacked above #1751; companion token-list changes target that repository's main.

## Review focus

- Node batches and adversarial note ordering: no single-claim-only liveness assumption or cross-user subsidy.
- Uncertain sender submission and issuer execution: reconcile before retry, including restart/reinstall.
- Reference-week versus inclusion-week and reclaim races: preserve the signed scope and report the actual winner.
- Actual TX_FEE and refund settlement: preserve reserves, cover post-fee cycles and zero-surplus branches.
- Published issuer identity: validate code/metadata/genesis before listing; never relabel old trial assets.

### Task 1: Funded claim protocol (own stack layer)

**Files:** `packages/gamecoin/src/{funded.rs,claim.masm,funded-auth.masm,funded-fee.masm}`, `src/lib.rs`, `tests/funded_claims.rs`, package README and CHANGELOG.

**Interfaces:** Export a funded issuer builder, the custom claim script, and a Rust note constructor binding issuer/code, sender, week, expiry, reclaim height, routing and native budget. Preserve the old experiment for comparison. Record exact script/storage ABI for the Web SDK constructor.

- [x] Write and run a failing real-protocol test requiring receipt GC=10,000,000 and native refund=budget−actual TX_FEE, with unchanged issuer reserves.
- [x] Implement the smallest funded note and network auth that pass that test. Fee quote zero must be restricted to the supported funded note root/shape.
- [x] Add authenticated execution tests for zero/nonzero reserves, insufficient budget despite reserves, exact/zero-surplus budget, native-asset mismatch, wrong sender/issuer/code, expiry and duplicate week.
- [x] Add multiple-claim batching and ordering tests; split the actual total fee deterministically, verify each refund and aggregate conservation. Reject unsupported inputs/scripts/extra outputs.
- [x] Add reclaim before/at/after height, issuer/reclaim race in both commit orders, and Sunday/Monday reference tests. A Sunday approval delivered Monday counts only against Sunday's week; fresh Monday references reject old-week approvals.
- [x] Prove normal Guardian output generation creates no extra sponsorship. Measure and bound post-fee cycles, including maximum admitted batch/output shape and zero-base-fee behavior.
- [x] Run the locked package test suite and independent security review; commit only the protocol delta above #1751.

### Task 2: SDK request and durable wallet recovery (next stack layer)

**Files:** `src/lib/arcade/` request/operation modules, existing wallet custom-request queue interfaces, backend/intercom handlers only where needed, focused tests.

**Interfaces:** A deterministic prepare result includes genesis/account/issuer/week, request note ID, receipt recipient commitment, budget, expiry and reclaim height. Persist before dispatch. Read/submit/reconcile/reclaim reuse existing Guardian custom request and note consumption paths.

- [x] Pin a Rust→JS construction vector and fail a test for exact note/script/storage/preimage mismatch before writing the constructor.
- [ ] Implement preparation and real fee review; require request+budget+receipt costs to fit the user's native balance.
- [ ] Test lost responses, duplicate taps, wrong network/account/issuer, failed reads and restart; uncertain outcomes remain pending and never dispatch a second logical claim.
- [ ] Recover requests and receipts from public authenticated history after reinstall. Link issuer execution and receipt consumption separately; only consumed delivery is claimed.
- [ ] Run focused wallet tests, type checking and builds; independently review and commit this layer.

### Task 3: Native activation and verified identity (separate layers)

**Files:** Existing Coins adapter/components and translations; Testnet deployment artifacts; token-list `testnet.json`; wallet token-list snapshot/tests after publication.

- [ ] Deploy a replacement issuer only after protocol review; record exact genesis/code/storage/asset identity.
- [ ] Demonstrate real Guardian funding, automatic issuer execution, receipt/refund consumption, duplicate rejection and failed-note reclaim in Bread. If node compatibility fails, keep Claim disabled and report the exact blocker.
- [ ] Connect the existing Coins UI to real balances, eligibility and operation state; retain unknown/pending/error distinctions and wallet fee approval.
- [ ] Prepare the companion token-list PR with verified on-chain metadata and correct bare bech32 faucet; run its validators. Do not claim publication before maintainer merge.
- [ ] Refresh the published wallet snapshot in a final stack layer; verify light/dark native UI, actual claim→balance→transfer and supported surface builds.
- [ ] Publish only reviewed, passing deltas as stacked PRs; attach every PR and state any untested or externally blocked gates.
