# GC Testnet full acceptance plan

> **For agentic workers:** Use superpowers:executing-plans for implementation and independent reviews before publishing completed changes.

**Goal:** Complete the whole Testnet GC experience defined in wallet issue #1452, rather than treating a deployed token or passing claim unit tests as acceptance.

**Architecture:** Reuse Gaylord's canonical GC issuer and PSWAP shop. Deliver weekly allowance from a separate funded network-account distributor holding that GC, using ordinary Guardian transaction/receipt paths, token-list verification and wallet-explore catalog. GQ challenge stakes are the recommended per-game reference; games may choose and disclose different payouts. Keep wallet changes in contained stacked PRs; companion repositories target main. No Mainnet activation or unapproved merges.

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
- Only receipts from the pinned distributor containing canonical GC update the canonical balance; earlier trial GC is a different asset.
- Game result validation and payment must be bound to the same immutable submission, with an explicit trust boundary.
- Never label unexercised Android, browser, offline fallback or rejected-result paths accepted.

## Tasks and evidence

### 1. Claim loading and native lifecycle

- [x] Reproduce incomplete history reported as pending and the resulting permanently disabled claim.
- [x] Write failing backend/hook regressions; introduce separate checking status and automatic read continuation.
- [ ] Test unknown submission, scan interruption, hidden/unmounted screen and week rollover without duplicate dispatch.
- [x] Build/install preserving data, prove exact Guardian approval → request → 10 GC receipt → consumption → balance. Request committed at 471727, issuer issued at 471729 and receipt consumed at 472225. Bread shows 10 GC and Claimed this week. Request/collection fee quotes 133 units each; issuer used 112 of 210 and returned 98 native units.
- [ ] Test cancelled approval, insufficient fee funds and repeated taps in the real wallet. Restart retained the 10-GC trial balance. The duplicate request committed at472489 was rejected, became recoverable after472552 without reopening Coins, and its separately approved Guardian reclaim consumed it at473280. Review showed210 native base units before a133-unit network fee; GC remained10. See native-budget-recovery-review.png and native-budget-recovered-10gc.png in ../evidence/2026-10-23-gc/.

### 2. Balance, verification and transfers

- [ ] Prove ordinary public/private transfer and receipt of the new GC identity in Bread.
- [ ] Validate token-list PR #4 and wallet identity mapping. Publish through normal maintainer review, then validate refreshed verified badge and bundled offline fallback.

### 3. Reference game and catalog

- [x] Audit existing games and current catalog; the earlier flat-fee contract is superseded by the approved per-game policy.
- [x] October23 updated decision: use Gaylord's canonical GC and PSWAP shop. GQ champion/rival stakes are recommended; each game may choose its own disclosed payout rules. This supersedes the earlier universal dedicated-treasury direction.
- [x] Distinguish GQ's first-successful-challenger escrow from a highest-score treasury record. Integrate the existing GQ mechanism as reference; do not deploy the separate local funded-results fork as the new default.
- [x] Select the MIT-licensed GQ reference integration; keep free play/replay/share separate from paid submissions. Browser source integration and local verification are in progress.
- [ ] Validate the existing GQ result, stake, payout and timeout contracts, durable payment identity and user-funded fees; test uncertainty and concurrency before enabling it in Bread.
- [ ] Create companion game and wallet-explore PRs, deploy approved Testnet build, validate launch/return and the disclosed 1-GC GQ record/challenge stake from Bread.

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

## Approved canonical-token alignment

Finish and validate Bread's GC system using Gaylord's existing canonical GC token on each verified network, with Testnet as the acceptance environment. Reuse his PSWAP shop and GQ champion/rival mechanism as the recommended game reference while allowing each game to define and disclose its own payout rules. Preserve free play, replay and social result sharing at zero GC; optional on-chain challenge sharing is separate. Deliver the free 10-GC/account/calendar-week allowance through a user-funded distributor of canonical GC, preserving approved-week binding, fee review/refunds, explicit receipt collection, failed-request reclaim, restart/replay/concurrency safety and ordinary transfers. Keep wallet-explore as the catalog source; align token verification, offline registry snapshots and integration documentation with the canonical faucet. Validate real Bread Guardian/native and extension flows plus appropriate protocol/regression/build/CI checks, document the explicitly skipped Android surface and external maintainer publication dependencies, and create/update contained review-ready wallet stacked PRs with companion repositories based on main. Preserve funded simulator data and all existing work. Do not deploy/activate Mainnet, change mint signers, or merge without separate authorization.

The confirmed native10GC trial above uses the old experimental issuer; it is not canonical-token acceptance. Canonical Testnet identity, multisig governance/funding owner, separate distributor top-up/auth and wallet receiver-vs-token identity separation must be verified before activation. Preserve the existing evidence; do not promote that experimental issuer. Token-list PR #4 now targets the canonical asset; verification still requires normal registry publication.
