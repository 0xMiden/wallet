# Epoch Solve-Failure Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline. Track the checkbox steps and source-bound evidence ledger.

**Goal:** Retain a safe original Epoch solve-failure clue before the later readiness timeout, without changing financial behavior.
**Architecture:** A bounded nightly console observer writes one keyed, finite record at the existing product error site. A self-contained metadata filter runs against the remote Error handle; a non-funded real-browser smoke proves that boundary.
**Tech Stack:** Existing Node22 crypto/fs, TypeScript, Jest, Playwright ConsoleMessage/JSHandle and EventEmitter test boundary.
**Spec:** docs/superpowers/specs/2026-11-17-epoch-solve-failure-diagnostics.md

## Global Constraints

- Start current main675cc723e32cf13c6a247936fd10876c788c18fe, SDK0.18/Guardian0.19rc2/dependency bytes unchanged; original15 and95 coverage unchanged.
- Original campaign cap2000000, verified243414 spent/1756586 remaining. No new accounts/funds/payments or expired authority/nonce/quote/deadline replay.
- Fixed public solve-error site only; keyed HMAC and finite kind/HTTPstatus only. No raw error/message/stack/URL/code/SDK bytes/key export or artifact glob.
- No request, transaction, retry, timeout, RPC, amount, nonce, authentication, ACK, budget, readiness predicate or exception replacement change.
- Own signed author+committer poszerny@gmail.com, isolated worktree. Local checks only ci-local, Jest maxWorkers2; heavy/browser/full/coverage in CI. Exit75 is refusal.
- Temporary branch-only regression proof workflow is omitted from final product PR through signed cherry-picks, never history rewrite.

## Review Focus

- Error handles/properties can be hostile or disappear: inspect own data descriptors only, catch metadata errors, preserve immediate basic HMAC record. Unit proxy/getter cases plus real browser smoke.
- Console callbacks/registration/disposal/I/O must not replace the financial error: unit on/off/write failures and stopped observer.
- Later/unrelated errors cannot overwrite original evidence: unit first-event and unrelated-type/prefix cases.
- Wrong SDK status field silently loses classification: unit actual APIError `.status`409 and browser own-property shape, invalid/non-API statuses omitted.
- Public artifact retention must remain explicit and bounded: parse existing upload manifest, exact new sidecar only, no worker log or state glob.

### Task 1: Filter/observer genuine assertion RED then GREEN

**Files:** Create playwright/e2e/helpers/mainnet-epoch-diagnostics.ts, scripts/mainnet-epoch-diagnostics.test.ts, playwright/e2e/tests/mainnet/mainnet-epoch-diagnostics.spec.ts; extend existing scripts/mainnet-swap-workflow.test.ts retention contract. Temporary .github/workflows/nightly-loop-proof.yml only on proof ref, not final PR.
**Interfaces:** epochSolveFailureMetadata(value: unknown): `{ kind: 'api-error' | 'transaction-error' | 'compact-sdk-error' | 'unknown'; httpStatus?: number }`; observeEpochSolveFailure(console source with on/off, checkpointPath: string): `() => void`. Real Page structurally satisfies the narrow event boundary.

- [ ] Write contracts before implementation: APIError/status409, TransactionError, CompactSDKError; unknown/free-form names and private properties never exported; getters/proxies never leak or execute private getters; malformed/non-HTTP/non-API status omitted.
- [ ] Observer contracts: existing exact error-site first event creates0600 `${path}.return-solve-failure.json`; HMAC equals independently computed fixed test key digest, not unkeyed SHA; original checkpoint untouched; no private text/code/URL/txHash/SDK data in JSON. Unrelated/later events ignored, stop unsubscribes and late metadata cannot rewrite, disappearing handle/registration/off/I/O failures never throw.
- [ ] Add the retention expectation before its missing workflow entry. Add a direct Playwright page smoke on about:blank, synthetic APIError/status409, actual ConsoleMessage/JSHandle classification and no raw marker in artifact; no wallet/server/RPC/signing key.
- [ ] Establish only importable unknown/no-op baseline after tests exist. Commit tests/spec/plan/baseline first. Add branch-only proof driver in a separate commit, push to proof ref; run new diagnostics and existing workflow contracts. Expected: real positive assertions fail for missing filter/record/retention, no import/setup failure. Verify actual nonzero counts and intended assertion failures before implementing.
- [ ] Implement the self-contained descriptor filter and first-event observer. Persist basic fixed-site/time/keyed digest immediately; optionally update only finite metadata asynchronously while active. No raw payload in closures written to disk, no propagated diagnostic failure. Add the single safe artifact path to make its contract pass.
- [ ] Run same tests and existing relevant suites; proof driver also runs one real-browser smoke with trace/video/screenshots off. Expected: nonzero all-pass counts, actual remote handle works. Record exact RED/GREEN source, commands and counts; commit signed.

### Task 2: Wire lifecycle, qualify product PR and resume standing campaign

**Files:** Modify playwright/e2e/helpers/mainnet-epoch-runtime.ts immediately before reverse UI try and first line of existing finally; modify .github/workflows/e2e-mainnet-nightly.yml exact sidecar path; update CHANGELOG only under current unreleased section.
**Interfaces:** Consume observeEpochSolveFailure(wallet.page,path), call cleanup before existing counterparty.stop. All existing money-path calls remain identical.

- [ ] Register bounded observer before the reverse UI action; stop in finally without awaiting diagnostic metadata. Run relevant runtime readonly-completion/evm/provider/workflow contracts plus new tests, actual Playwright discovery/types and no-funded browser smoke in CI. Preserve every existing wait/authorization/transport.
- [ ] Internal whole-change connected-caller/privacy review; fix concrete P0-P2 with assertion RED/GREEN. No Council or fabricated independent receipt.
- [ ] Create final branch from675cc and signed cherry-pick source test and implementation commits only, excluding temporary proof-workflow commit. Confirm product/test source parity and unchanged dependencies, add CHANGELOG after checking latest published tag, open scoped PR. No rebase/reset/amend/force.
- [ ] Monitor all original15 current-head checks and95 coverage to actual success; resolve reviews in scope. Admin squash merge only under standing campaign authority, verify merged/qualified tree equality or requalify differences.
- [ ] Return to actual current-source held NEAR plus independent original public/private readiness/remaining-cap checks before considering ONE fresh ordinary selected-provider run with new once-marker and fresh authorities. No payment in this plan alone; recovery/cancellation/readiness is not funded green. Original Epoch root cause remains UNKNOWN until actual finite evidence proves it.
