# Original Epoch Owner-Refund Retirement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans inline. Track the checkbox steps below and retain the evidence ledger.

**Goal:** Retire only the fully refunded original Epoch checkpoint as cancelled without another financial operation.
**Architecture:** An exact-case pure builder consumes original immutable bytes and independent public/private outcomes. An isolated official-nightly overlay runs the existing real auditors before publishing canonical final checkpoints; normal product code remains unchanged.
**Tech Stack:** Existing Node22 assertions/crypto/fs, current SDK0.18.0 and Guardian0.19.0-rc.2 auditors, existing YAML/GitHub artifact actions and checkpoint loader.
**Spec:** docs/superpowers/specs/2026-11-17-original-epoch-owner-refund-retirement.md

## Global Constraints

- Existing original cap2000000, verified spent243414 and remaining1756586; no reset, profit credit, repeated fee booking or new funds/accounts.
- Original Epoch SHA77652e5b0590797753f5fe920d79fec252af3411a5b125a663a12d77f60e40a1; swap and NEAR remain byte-identical.
- Only phase, updatedAt, after and realizedCostUsdMicros may change. Keep every original authority, receipt, price, nonce, source and deadline.
- No financial executor/EVM signing key, no new SDK intent or claim, no funded-green assertion, no dependency changes/private raw export/Council.
- Own signed author+committer poszerny@gmail.com, isolated worktree, local preflight only through ci-local, actual CI evidence before completion.

## Review Focus

- A valid unrelated or stale report cannot authorize this exact case: test wrong source/SDK/checkpoint hashes and fresh producer provenance in the workflow.
- Empty escrow alone does not prove return or disable: test returned-principal/disabled-status/withdrawable-at/intent flags and current owner balances.
- Native completion must not be invented: test absent return/consume fields and all unchanged original fields by an independent normalized-object digest.
- No money rebooked or credit: test exact70126 Epoch realized cost and preserve original paid fee fields; global ledger remains1756586.
- Canonical artifact discoverability must use the official workflow: verify actual run workflow ID and normal finder selection, not merely a successful auxiliary run.

### Task 1: Exact-case checkpoint builder and functional RED/GREEN

**Files:** Create scripts/retire-original-epoch-owner-refund.mjs and test/epoch-owner-refund-retirement.node.test.mjs; modify owned .github/workflows/nightly-loop-proof.yml for nonfinancial qualification only.
**Interfaces:** Produce retireOriginalEpochOwnerRefund(originalBytes, publicOutcome, privateOutcome, privateStatus, now): plain checkpoint object. No side effects; original bytes never mutated. A small CLI loads fixed test-results paths and writes only test-results/mainnet-epoch-state/roundtrip.json plus sanitized evidence.

- [x] Write positive test using original downloaded checkpoint and the known successful audit as fixtures: phase cancelled, after native18835663/evmToken254080030/evmNative297487428658860326, loss70126, no consumeAuthority/returnNoteId/returnMidenTxId. Verify original fields and input bytes unchanged.
- [x] Add single-input negative cases for wrong checkpoint bytes, sourceRunId/applicationSource/SDK, public/private failed status, unreturned principal, nonzero SFT, enabled status, nonzero withdrawable timestamp, intent not empty, wrong private holdings/nonces, unblocked consume/live policy/new authority, mismatched public/private cost and malformed costs.
- [x] Establish the importable fail-closed baseline only after the test exists. Push frozen tests/baseline to the owned auxiliary workflow, download original producer and audit fixture artifacts, run Node tests. Expected: positive assertion fails for the missing retirement behavior, not import/setup; negatives deny. Inspect actual failure before implementing.
- [ ] Implement the minimum exact-case builder; preserve original object fields and populate only the four allowed fields. Include real loader validation at the CLI boundary using the existing bundled loader, not a new schema.
- [ ] Run the exact same CI tests and original45 guard cases. Expected: all actual tests pass with nonzero counts. Record source, run and assertion chronology. Commit signed.

### Task 2: No-spend official canonical retirement

**Files:** Isolated .github/workflows/e2e-mainnet-nightly.yml overlay, existing independent public/private readers unchanged.
**Interfaces:** Consume Task1 builder. Publish only mainnet-swap-final-RUN/mainnet-epoch-final-RUN/mainnet-1click-final-RUN and sanitized recovery-only audit evidence.

- [ ] Configure push trigger only for a distinct canonical-once ref, original shared concurrency, read-only permissions, no EVM signing secret/executor or fresh provider stages. Retain auxiliary unit qualification on its own branch only.
- [ ] Bind original producer and all financial first-attempt run/source/authority hashes as in the already successful9937 audit. Bind current official producer frontier before execution. Run the existing actual SDK018 public and PRIVATE auditors against untouched original copies.
- [ ] After actual audits pass, run the builder, validate with existing loader, preserve original swap/NEAR bytes and original Epoch authorities. Require normal cancelled shape and recoveryOnly=true; no native/funded-complete claim.
- [ ] Freeze source after internal complete-source review and same-source unit qualification. Consume a distinct nonfinancial once marker, push the frozen canonical ref once, monitor exact run/SHA at30s. Expected: canonical artifacts and actual audit pass, zero transactions/signatures/new fees.

### Task 3: Independently verify canonical retirement and resume campaign

**Files:** Owned independent verification overlay/evidence and campaign/financial records only.
**Interfaces:** Consume Task2 immutable final artifacts and actual run provenance.

- [ ] Download all three canonical artifacts and compare independently: swap/NEAR byte-identical; Epoch only four permitted fields differ, phase cancelled, original source/authorities/receipts intact, no native consume/return invented. Actual original loader accepts it.
- [ ] Verify normal chooseSwapCheckpoint selects all three newest final artifacts from the official workflow. Requery actual original private/public holdings and disabled empty lock, required consume guard/no policy/no authority, unchanged costs. Expected: no new spend, actual remaining1756586 unchanged.
- [ ] Record internal-review limitation honestly; no independent-review receipt fabricated. Update canonical state, financial/README/campaign/SDD and standing monitors. Only then assess next source-bound ordinary qualification; cancellation is not funded green.
