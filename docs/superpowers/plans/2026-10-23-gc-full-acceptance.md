# GC Testnet full acceptance plan

> **For agentic workers:** Use superpowers:executing-plans for implementation and independent reviews before publishing completed changes.

**Goal:** Complete the whole Testnet GC experience defined in wallet issue #1452, rather than treating a deployed token or passing claim unit tests as acceptance.

**Architecture:** Retain the funded network-account issuer, ordinary Guardian transaction and receipt paths, token-list verification registry and wallet-explore catalog. Keep wallet changes in contained stacked PRs; companion repositories target main. No Mainnet activation or unapproved merges.

**Tech stack:** Published Miden SDK/protocol 0.17, React/TypeScript, Capacitor iOS/Android, extension, Rust/MASM.

**Spec:** https://github.com/0xMiden/wallet/issues/1452 and ../specs/2026-10-23-gc-funded-claims.md.

## Global constraints

- Preserve funded simulator data; never uninstall or erase Bread GC Testnet.
- Separate protocol/offline evidence, live CLI transactions and native Guardian acceptance.
- No hidden fee subsidy, optimistic balance grant or duplicate charge after uncertainty.
- Sunday-approved requests retain Sunday's allocation even when delivered Monday.
- New credentials and terms stay with the user; the existing Testnet passcode is authorized for this trial. Registry/catalog publication needs maintainer merge; report it accurately.

## Review focus

- History pagination must finish without manual repeated taps or becoming a fictitious submitted claim.
- A real uncertain dispatch must still block another charge, including across restart or concurrent devices.
- Only exact new-issuer receipts update the balance; earlier trial GC is a different asset.
- Game result validation and payment must be bound to the same immutable submission, with an explicit trust boundary.
- Never label unexercised Android, browser, offline fallback or rejected-result paths accepted.

## Tasks and evidence

### 1. Claim loading and native lifecycle

- [x] Reproduce incomplete history reported as pending and the resulting permanently disabled claim.
- [x] Write failing backend/hook regressions; introduce separate checking status and automatic read continuation.
- [ ] Test unknown submission, scan interruption, hidden/unmounted screen and week rollover without duplicate dispatch.
- [x] Build/install preserving data, prove exact Guardian approval → request → 10 GC receipt → consumption → balance. Request committed at 471727, issuer issued at 471729 and receipt consumed at 472225. Bread shows 10 GC and Claimed this week. Request/collection fee quotes 133 units each; issuer used 112 of 210 and returned 98 native units.
- [ ] Test cancelled approval, insufficient fee funds, repeated taps, restart and expiry/reclaim in the real wallet.

### 2. Balance, verification and transfers

- [ ] Prove ordinary public/private transfer and receipt of the new GC identity in Bread.
- [ ] Validate token-list PR #4 and wallet identity mapping. Publish through normal maintainer review, then validate refreshed verified badge and bundled offline fallback.

### 3. Reference game and catalog

- [x] Audit existing games and current catalog. No existing candidate meets the whole flat-fee contract.
- [x] Brian selected a dedicated treasury per game. Accepted submissions retain 1 GC there; do not burn GC or replace the issuer. Inspect Gaylord's games as the reference for records and game-specific payments.
- [x] Distinguish the existing first-successful-challenger escrow from a highest-score record. Use the clarified per-game treasury interpretation; timed contests and pooled prize distribution are not inferred from it.
- [x] Select the MIT-licensed GQ reference integration; keep free play/replay/share separate from paid submissions. Browser source integration and local verification are in progress.
- [ ] Add authoritative result validation, durable submission/payment identity, user-funded fees and rejection/expiry refund behavior; test uncertainty and concurrency before deployment.
- [ ] Create companion game and wallet-explore PRs, deploy approved Testnet build, validate launch/return and exact one-result/one-GC submission from Bread.

### 4. Supported surfaces and review

- [ ] Exercise real iOS and extension Testnet paths. Brian explicitly skipped local Android setup on October 23; Android remains unvalidated, not a passing acceptance gate. Command-line tooling and Java were installed, but SDK/emulator license acceptance was declined and installation stopped.
- [ ] Check light/dark and narrow layouts, stale/offline/network/account isolation and current Activity behavior.
- [ ] Run appropriate noncoverage tests, type/lint checks, target builds and independent review. Coverage runs in CI only.
- [ ] Update each PR with its own delta and actual evidence; keep unaccepted layers draft. No merges without authorization.

## Current external dependencies

Token-list #4 is open and CI validation passes, but the published main registry does not include GC. The live wallet-explore Testnet catalog lists only Where Legends Grow. Neither a pending PR nor a local override proves published verification or a working GC reference-game listing.

## Compact claim review

- Primary review shows 10 GC, estimated total fees and one short refund/second-confirmation explanation. Details discloses each fee, approved allocation week and expiry.
- Five drawer regressions pass; 390px light/dark and expanded Details inspected in a fictional review fixture. Native receipt review inspected and confirmed during the real Guardian claim trial.
- Full Jest run: 1191 suites passed, five failed while source was being edited. All five affected suites subsequently passed after locale/error-contract and consume-auth fixes. Android is explicitly skipped; other full-system acceptance tasks above remain open.
