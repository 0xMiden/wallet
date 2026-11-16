# NEAR unspent reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Safely reconcile one proven unsigned NEAR checkpoint before a new mainnet nightly.
**Architecture:** Extend the existing knownUnspentEpochPreAuthorization pattern with an exact-source NEAR exception backed by completed independent audits. Verify original live balances and original provider status at runtime; mark only phase/updatedAt and force recovery-only exit.
**Tech Stack:** Node/TypeScript, Jest, Playwright, GitHub Actions.
**Spec:** docs/superpowers/specs/2026-11-16-near-unspent-reconciliation.md

## Global Constraints
- Original2000000 micro-USD cap; verified90246spent/1909754remaining. No reset, new funds/accounts or replay.
- Preserve SDK-byte upload/ACK, original recovery, retention, concurrency, shared budget and95%canonical coverage.
- Only evidenced status-envelope tracing normalization; no retry, deadline, amount, signature/authentication policy or public rollout changes. No merge/admin or additional Council.
- Guarded local preflight only; full tests, coverage, compilation and live wallets on CI. Signed feature commits with original user identity; no dependency changes.

## Review Focus
- Missing/duplicate GitHub jobs/steps or attempted downstream gates must never certify an unsigned checkpoint.
- A green audit must bind exact repository/run/source/attempt and both actual public/private jobs.
- A valid-looking pending status for another quote must fail signature and canonical hash binding; unsigned per-request tracing metadata is not an authority field.
- A changed Guardian, principal, fee, balance or pending nonce must leave the checkpoint untouched.
- Clearing an expired quote must not release fresh funding in the same run.

### Task1: Exact known-case provenance and runtime reconciliation
**Files:** scripts/mainnet-swap-artifacts.mjs; scripts/mainnet-provider-artifacts.test.ts; playwright/e2e/helpers/mainnet-near-runtime.ts; scripts/mainnet-near-unspent.test.ts; .github/workflows/e2e-mainnet-nightly.yml; scripts/mainnet-swap-workflow.test.ts; CHANGELOG.md.
**Interfaces:** Export knownUnspentNearPreAuthorization(checkpointDigest, run, jobs, audit, auditJobs, now=Date.now()) from the existing artifact module. Export verifyUnstartedNearForward(wallet:GuardianAwareWalletPage,state:MainnetNearCheckpoint):Promise<void> from the existing runtime. Pass MAINNET_NEAR_PREAUTH_UNSPENT only from the official attempts output.
- [ ] Write real positive/negative provenance tests against existing exports before implementation; use current Epoch test pattern and exact original step counts.
- [ ] Add functional runtime tests with mocked network/wallet boundaries; assert original expired quote accepted, all Review Focus negatives rejected, zero grants/sign/broadcast/submitDeposit and unchanged original authority.
- [ ] Run focused CI RED on committed pre-fix source and retain intended assertion failures. Baseline established by unchanged existing tests in the same run.
- [ ] Implement exact recognizer and wire trusted output, retaining original forward_attempted semantics. Validate live original portfolio/provider binding before saving only unspent/updatedAt; emit recoveryOnly=true and return.
- [ ] Run focused CI GREEN plus canonical full tests/types/lint/coverage95% on exact feature head; self-review all callers, workflow guards and malformed input cases. Add one unreleased changelog entry.
- [ ] Commit and publish the feature branch without PR merge/admin.

### Task2: No-spend recovery and fresh nightly
**Files:** durable private state under ~/.local/state/wallet-swap-bridge-overview-2026-11-15/; no raw private CI logs exported.
- [ ] Reconfirm no competing funded jobs; dispatch NEW source-bound recovery under original workflow identity and actualremaining1909754. Preserve consumed marker before dispatch. SDK/no-spend path only; recoveryOnly must prevent fresh phases.
- [ ] Independently verify original unspent checkpoint/holdings and cost0 before another job; retain original checkpoint and authority snapshots.
- [ ] Dispatch one separate fresh ordinary swap->Epoch->NEAR nightly with loops_only=true, actualremaining1909754, new prices/quotes/nonces/SDK authority. Monitor30s; do not retry uncertain submissions.
- [ ] Audit all actual outcomes/costs/private holdings and update the durable ledger once. Report settlement and unexecuted routes honestly; no inferred success from upload ACK.

Native execution in this session; no subagent tool is exposed. User has approved the narrow fix and subsequent fresh nightly. No new approval request for routine reversible implementation details.
