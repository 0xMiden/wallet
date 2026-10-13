# Live iOS USDCx Burn, PR 2b: the Burn Half of the Live iOS Spec Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The live iOS USDCx spec keeps its secret-funded deposit leg, hardens it, and then burns 1 USDCx from a public faucet grant through the Send UI back to the deposit key's own Arc address, gating hard on Circle's payout (PR 1b's payout leg, made key-agnostic) and on the wallet's own confirmation of it; the nightly hands its Arc key only to the two steps that read it.

**Architecture:** `playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts` is extended in place: the deposit leg runs first (so a late Circle payout can only redden a run after the deposit result is in), then xReserve's withdrawal flags, the grant, the Guardian settle, PR 1b's payout leg reading the deposit key right before the burn (`key_snapshot`), the Send-UI burn (PR 2a's `burnUsdcxViaSendFlow`, handed the step's abort signal), the faucet's consume, Circle's payout (the leg's `payout` step: `waitForGatewayPayout` in R20's delta mode, counted from the snapshot) and the wallet's `destinationBalanceConfirmed` plus History pill. PR 1b's `harnessPayoutLeg` becomes a thin wrapper of a new `payoutLeg` that takes any key, so the extension and iOS share one payout wiring (R23). The nightly workflow changes its header comment and hands `USDCX_LIVE_EVM_PRIVATE_KEY` only to its key check and its test step (R25).

**Tech Stack:** Playwright (iOS two-simulator fixture over appium-remote-debugger), Jest (`@swc/jest`, node environment), viem, PR 1b's harness modules (`arc-usdcx.ts`, `usdcx-constants.ts`, `usdcx-miden.ts` with its Node SDK oracle, `usdcx-guardian.ts`, `usdcx-run.ts`, `usdcx-legs.ts`, `bridge.ts`, `history.ts`), PR 2a's `IosWalletPage` readers and driver.

**Spec:** `docs/superpowers/specs/2026-10-09-usdcx-live-e2e-design.md` (sections 4, 7, 9, 12, 14 PR 2, 15), as re-scoped by `/Users/celrisen/miden/wt-usdcx-e2e/.superpowers/pr2/pr2-rescope.md` section 4 and the user's decisions of 2026-10-11 (below). Measured facts: `/Users/celrisen/miden/wt-usdcx-e2e/.superpowers/pr2/ios-spike-report.md` and `ios-spike-evidence.json` (3 of 3 live iOS burns green on main 8e7ae1630), `small-burn-probe-report.md` (the 1 USDCx numbers). Selector and harness facts: `scout-a-ios-harness.md`, `scout-b-ios-send-flow.md`, `scout-c-pr1b-reuse.md` in the same folder. PR 2a's plan: `2026-10-11-usdcx-ios-pr2a-plan.md` in the same folder.

**User decisions that bind this plan (2026-10-11):**
1. KEEP the secret-funded deposit leg, #1402's workflow, its key-check step and `usdcx-live-workflow.test.ts`. Extend `usdcx-live-deposit.ios.spec.ts` IN PLACE with the burn half AFTER the deposit leg: public faucet grant to the Guardian wallet, Send-UI burn of 1 USDCx (R19) with the Arc Testnet chip, a HARD payout gate (Circle's `AttestationUsed` for the key with the burn note id, deadline consume + 10 min, failure text naming Circle) and a HARD wallet confirmation (`destinationBalanceConfirmed` and the History pill `Confirmed`). The deposit leg gets the re-scope's hardening: recipient/maxFee/hookData decode, a preflight floor of deposit plus gas, the row's `usdcxRemoteRecipient`, the exact vault with f2 read from the consume row, and `guardianCommitment` equal to the hosted Guardian's. Deposit phases are monotone within `submitting, delivering, ready, received` and end `received`; `ready` is never required (#1405).
2. The burn's destination is the deposit key's own address (R20, which superseded the fresh-key ruling for iOS): the CI key on CI, so each night's payout of about 0.98 USDC refills what its deposit leg spends.
3. SPLIT PR 2: this plan is the old Tasks 3-5, renumbered 1-3, on main after PR 2a merged. PR 2 reuses PR 1b's modules; no copy of a PR 1b helper. DROPPED: removing the secret, a self-funded deposit, a 1 USDC deposit, replacing the spec file, the runner repoint, the `usdcx-ios` suite, the build-step removal, the `E2E_REAL_USDCX` guard, the two phase rules #1405 disproved, and the relayer deletion. Review is internal only (no review-council).
4. Merging: the harness autonomy grant of 2026-10-11 ("you have permission to merge. work autonomously until the end of harness development") covers an admin squash-merge once the relevant CI and the dispatched nightly are green.

**PR 1b rulings this plan follows (SDD ledger `/Users/celrisen/miden/wt-usdcx-e2e/.superpowers/sdd/2026-10-11-usdcx-live-e2e-harness/progress.md`), all landed in PR 1b (#1421, squash `20949e612`, tree equal to its final head `d8345cbd4` for every file this plan reads):**
- **R19:** `BURN_UNITS = 1_000_000n` (the USDCx faucet's on-chain minimum burn); one public-faucet grant per wallet of the 10 USDCx tier, `GRANT_UNITS = 10_000_000n`. Measured on 1 USDCx: Circle's fee a flat 16400, payout 983600, vault delta 1000252.
- **R20:** the payout gate's delta mode (`balanceBefore`); `DEPOSIT_UNITS 1_000n` and `GAS_RESERVE_UNITS 20_000n` for PR 1b's own deposit leg, while the iOS deposit keeps its `USDCX_LIVE_DEPOSIT_AMOUNT` default 0.01; a fail-fast check that a deposit exceeds the wallet's unattended claim floor (base fee x 30).
- **R21:** the extension suites share one harness key (`~/.miden-e2e/arc-keys/harness.json`, `HARNESS_ARC_KEY_FILE`) behind a run lock (`~/.miden-e2e/usdcx-run.lock`, `USDCX_RUN_LOCK`); the CI key stays the nightly's alone. A local run of this spec uses the harness key while holding the lock (Delivery Step 4).
- **R22:** every burn waits for its own payout through the delta-mode gate, counted from a read taken right before the burn, so no payout is left to land in a later run's window; a stray payout fails the strict check, named.
- **R23:** that payout wiring is one helper in `usdcx-legs.ts` (`harnessPayoutLeg`); an uncorrelated multi-log verdict names each log's transaction hash and block.
- **R24:** keys come only from the environment (no key flags); `confirmBurn` asserts `outputNoteIds` only on the local completion path (`burnOutputNoteProblem`); Arc reads tolerate transient errors by endpoint failover; every Arc read step's budget covers trying every endpoint (`ARC_READ_STEP_BUDGET_MS`); evidence and failure messages name an Arc RPC by its host only (`arcHost`).
- **R25 (for this PR):** `.github/workflows/e2e-usdcx-live.yml` scopes `USDCX_LIVE_EVM_PRIVATE_KEY` to the key-check step and the test step only, keeping #1402's key-check step, `usdcx-live-workflow.test.ts` and `linked-pr-injection.test.ts` green.
- **R26:** a step that sends checks its abort signal first. PR 2a's driver takes the step's signal; this spec hands it over. The iOS deposit is signed and sent by the WalletConnect counterparty on the wallet's request and has no harness simulation, so R26's write-endpoint rule has nothing to apply to here.
- **R27 (parked):** neither parked edge applies here: this deposit has no harness simulation, and the iOS driver checks its signal before submit.

## Global Constraints

- Base: `origin/main` after PR 2a (`wiktor/usdcx-ios-burn-a`) has merged. Worktree `/Users/celrisen/miden/wt-usdcx-ios-burn-b`, branch `wiktor/usdcx-ios-burn-b`, PR base `main`. Never run `yarn install`, a build, an E2E run, `git checkout` or any write in `/Users/celrisen/miden/wt-usdcx-e2e`; this plan file is read from there by absolute path.
- Toolchain: `export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"` in every shell (Node 22: `engines`, and the build's `yarn check --integrity`, KB `yarn-integrity-system-parameters-node-abi`). Jest runs as `yarn jest <paths> --maxWorkers=2`.
- The Bash tool's shell is zsh, which does not split `$VAR` into words: pass file lists through `xargs -0` or `bash -c`, never as an unquoted variable.
- New and edited jest test files under `playwright/` start with the `@jest-environment node` docblock (jest.config.ts:152 defaults to jsdom, and `@playwright/test` throws `Class extends value undefined` under jsdom; telemetry-consent.ts:21-27).
- Commits: 4 implementation commits (Task 1; Task 2's payout leg; Task 2's burn half; Task 3), messages verbatim from each task, single line, no trailers of any kind (no `Co-Authored-By`, no `Generated with`, whatever a tool's reminder asks), `git add` by explicit path, never `git add -A`, never amend, never force-push. Review and CI fixes are later commits of their own, pushed unsquashed.
- No em dash (U+2014) or en dash (U+2013) in any added line, commit message, PR text or comment. `playwright.ios.config.ts` already holds some on lines this plan does not touch; only added lines are checked.
- Comments say why, never what, at each file's density. No `any`, no `as` in non-test code.
- Anchors: every edit quotes its before-snippet from main (`file:line`; PR 1b's files equal `d8345cbd4`, Setup Step 2), from PR 2a's merged code, or from an earlier task's output in this plan. Line numbers drift as edits land; when a quoted snippet and a line number disagree, the snippet wins. A snippet that matches nothing means the base moved: stop and report it.
- The nightly `.github/workflows/e2e-usdcx-live.yml` keeps every step, permission, input, trigger, concurrency and timeout. Its changes are its header comment and R25: `USDCX_LIVE_EVM_PRIVATE_KEY` leaves the job's `env` and goes to the `env` of the key-check step and of the test step, and nowhere else. `playwright/e2e/harness/usdcx-live-workflow.test.ts` (with R25's new test) and `linked-pr-injection.test.ts:355` (`e2e-usdcx-live.yml mobile-usdcx-live: push 150, dispatch 235`) pass.
- The spec file name, its `test.skip` on a missing `USDCX_LIVE_EVM_PRIVATE_KEY`, the `USDCX_LIVE_DEPOSIT_AMOUNT` default `0.01`, the local-relayer path and `package.json:112` stay as they are. No new environment variable, no key flag (R24), no `E2E_REAL_USDCX` guard, no runner suite.
- Burn destination (R20): the deposit key, `evmAddress` (`USDCX_LIVE_EVM_PRIVATE_KEY`), handed to PR 1b's payout leg as a `PayoutKey` with role `deposit`; no new key, no ledger write. The deposit leg's approve and deposit are mined before the burn and nothing else spends from the key, so the leg's snapshot plus the payout is the key's balance after it. The private key is in `secrets` from the start and never goes through `cdp.eval` (appium-remote-debugger logs every eval body at debug level, spike section 4.3), a log line, a step name, a screenshot name or an attachment. A late payout from an earlier night that lands inside this run's window fails the payout gate as `uncorrelated`, naming each log by its transaction hash and block and saying the key held USDC before the burn (`PREFUNDED_KEY_NOTE`): R20 accepts that risk.
- Keys (R21): the CI key `~/arc_testnet_usdcx_ci_key.txt` belongs to the nightly alone. The one local live run (Delivery Step 4) deposits from and burns back to the harness key while it holds the run lock, because two payouts into one key break the delta gate and a local run cannot see a nightly. Before the key enters any environment, the pinned CLI is installed, so no cargo build runs with the key in its environment (PR 1b's keyless children, R24).
- Evidence: one JSON file, `usdcx-live-ios-evidence.json`, written through PR 1b's `evidenceJson(evidence, secrets)` (which refuses any secret's hex) and refused when it contains `password=` (the onboarding bypass keeps `?__test_skip_onboarding=1&password=...` in `location.href` for the whole session, spike section 4.6). Page locations enter evidence as `location.hash` only; an Arc endpoint enters evidence and failure messages as its host only (`arcHost`, R24).
- Guardian: the hosted Guardian from `envConfig.guardianUrl` (`https://guardian.openzeppelin.com`); `process.env.GUARDIAN_URL` is never read.
- Payout gate (D3, R22, R23): `payoutLeg`'s `key_snapshot` step reads the deposit key with `readArcUsdcSnapshot` (the head and the balance at that head, one endpoint, one read) right before the burn, and its `payout` step runs `waitForGatewayPayout` in delta mode from that snapshot's block and balance, deadline `consumeTsMs + PAYOUT_TIMEOUT_MS` from the oracle's consume block time; the failure names the deposit key, which Circle pays, and the late-payout note. The burn row's saved `destinationBalanceBefore.balance` must equal the snapshot's balance. The wallet confirmation (Q6) is hard, runs after the payout gate and must read the gate's `payout.balance` (the snapshot plus the payout).
- CDP reads that a long poll repeats ride out a failed eval through PR 2a's readers; PR 1b's `pollUntil` fails on a failed read at once.
- Fees are read from the rows that paid them, never pinned; a landed path's fee is bounded, `0 < f <= baseFee x FEE_RESERVE_MULTIPLE`, and recorded as `bounded` (Q5(d)). A burn that completed locally must list its burn note in `outputNoteIds`; a landed one rests on the oracle (R24).
- Vault reads happen on Home only: the store's balance poll does not run on the generating or details pages (spike section 4.1).
- Never reload or lock wallet A; never call `midenCli.mint`, `claimAllNotes` (it injects fake `TST` metadata for the ids it is given; `claimAllNotes` in ios-wallet-page.ts) or `ensureFeeFunded`: the wallet auto-consumes USDCx (testnet's native asset).
- Constants come from PR 1b's `usdcx-constants.ts` (`BURN_UNITS`, `GRANT_UNITS`, `GAS_RESERVE_UNITS`, `PAYOUT_TIMEOUT_MS`, `WALLET_CONFIRM_TIMEOUT_MS`, `ARC_*`, `ARC_READ_STEP_BUDGET_MS`, `USDCX_DECIMALS`, `isWorthClaiming`, `CLAIM_COST_FEE_MULTIPLE`) and copy from `public/_locales/en/en.json` through `enText`; nothing is pinned twice. Prose (comments, workflow header, docs, CHANGELOG, PR body) states R19's amounts: 1 USDCx burned, a payout of about 0.98 USDC; Delivery Step 1 greps the added lines for a stale `burns 10 USDCx` or `9.98`.
- Simulators: never run `xcrun simctl shutdown all`, `erase` or `killall` by hand. The two-simulator fixture's recovery runs `simctl shutdown all` plus a CoreSimulatorService kill on a setup hang (simulator-control.ts:238, :256), so the one local live run uses a dedicated pair and starts only when no other session's simulator is booted.
- Screenshots are read only after `sips -Z 1800 <file>` (KB `claude-code-images-over-2000px-break-multi-image-turns`).
- Gates that apply: the jest suites of every changed file's directory (`playwright/e2e/harness`, `playwright/e2e/helpers`, `playwright/e2e/ios/helpers`), prettier, eslint, `yarn lint:e2e`, `yarn ts` and the changelog check. Jest's coverage gate counts only `src/**` (jest.config.ts:15-28), so nothing here moves a coverage number.
- CHANGELOG: one `[CHANGE][ci]` line under the highest `## X.Y.Z (TBD)` section above the latest `vX.Y.Z` tag (`git fetch --tags` first; an `-rc` tag does not count). Never run prettier on `public/_locales` or `CHANGELOG.md`.
- Review: internal whole-branch review only (no review-council). P3 findings are neither fixed nor filed.

## Review Focus

1. **A transfer into or out of the deposit key during the payout window.** A late payout from an earlier night, a manual top-up or a deposit a killed run left pending all move the key's balance; a reasonable person expects the run to fail naming the transfer rather than pass on someone else's credit. The gate's own tests in `arc-usdcx.test.ts` pin the verdicts; Task 2's `takes any key the run names` test pins that the iOS key reaches that gate with its own label and role, and Task 2's guard pins that the wallet's saved balance must equal the leg's snapshot.
2. **The Arc key reaching code the job does not own.** The CLI build, the dependency install (including a linked web-sdk PR's build on a dispatch) and the app build run third-party code; a reasonable person expects the key to be visible only to the steps that read it. Pinned by Task 3's `hands the live Arc Testnet key only to the key check and the test step` test.
3. **A deposit the wallet will never claim.** A dispatch can set `deposit_amount` below the wallet's unattended claim floor (base fee x 30, 210 base units at testnet's base fee of 7); a reasonable person expects the run to refuse before it pairs a counterparty or sends anything, not to time out 15 minutes after a real deposit. Pinned by Task 1's `refuses a deposit the wallet would leave unclaimed before it pairs the counterparty` test.
4. **The onboarding password or an endpoint's API key in artifacts.** `location.href` carries `password=` all session and an operator's Arc URL can carry an API key in its path; a reasonable person expects neither in the evidence or a failure message. Pinned by Task 1's `names Arc endpoints by host and writes the evidence only through its refusal of secrets` test; checked again on the live evidence in Delivery Step 4.
5. **A wrong recipient on the deposit.** A deposit whose `remoteRecipient` is not this account strands at the faucet; a reasonable person expects that to fail in seconds, not after Circle's 20 minutes. Pinned by Task 1's `checks what the counterparty signed and the row's recipient before it waits on Circle` test.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts` | Modify (Tasks 1, 2) | deposit-leg hardening, then the burn half, evidence |
| `playwright/e2e/harness/usdcx-live-spec.test.ts` | Create (Task 1), extend (Task 2) | source guards: checks before Circle's wait, the claim floor before pairing, host-only endpoints, burn after the deposit leg, the burn back to the deposit key from the leg's snapshot |
| `playwright/e2e/helpers/usdcx-legs.ts` | Modify (Task 2) | `payoutLeg` for any key; `harnessPayoutLeg` wraps it |
| `playwright/e2e/helpers/arc-usdcx.test.ts` | Modify (Task 2) | one test of `payoutLeg` on a key the run names |
| `playwright.ios.usdcx-live.config.ts` | Modify (Task 2) | timeout re-derived from the worst case; stale comment |
| `playwright.ios.config.ts` | Modify (Task 3) | stale relayer comment at :18-19 |
| `.github/workflows/e2e-usdcx-live.yml` | Modify (Task 3) | header comment; R25's key scoping |
| `playwright/e2e/harness/usdcx-live-workflow.test.ts` | Modify (Task 3) | R25 guard |
| `playwright/e2e/docs/e2e-architecture.md` | Modify (Task 3) | the iOS nightly's self-refilling key and which key a local run uses |
| `CHANGELOG.md` | Modify (Task 3) | one `[CHANGE][ci]` line |

**Size: about 700 lines added and 80 removed.** Measured from this plan's code blocks against their anchors (non-blank lines, import blocks counted once): the spec about 480 added and 55 removed (the deposit hardening about 190, the burn half about 290), its guard test about 70, `payoutLeg` about 35 added and 10 removed in `usdcx-legs.ts` and its test about 30, the config about 12 added and 10 removed, the workflow, its guard and the base iOS config's comment about 45 added and 5 removed, the docs and the CHANGELOG about 10. The unsplit plan's commits 2-4 measured about 695; the rest is R25's scoping and guard, `payoutLeg`, the claim-floor and host-only checks and their guards.

## Setup

- [ ] **Step 1: Confirm PR 2a merged and create the worktree**

```bash
export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"
gh pr list --repo 0xMiden/wallet --head wiktor/usdcx-ios-burn-a --state merged --json number,mergeCommit --jq '.[] | "\(.number) \(.mergeCommit.oid)"'
git -C /Users/celrisen/miden/miden-wallet fetch origin
git -C /Users/celrisen/miden/miden-wallet merge-base --is-ancestor "$(gh pr list --repo 0xMiden/wallet --head wiktor/usdcx-ios-burn-a --state merged --json mergeCommit --jq '.[0].mergeCommit.oid')" origin/main && echo "PR 2a is on origin/main"
git -C /Users/celrisen/miden/miden-wallet worktree add -b wiktor/usdcx-ios-burn-b /Users/celrisen/miden/wt-usdcx-ios-burn-b origin/main
cd /Users/celrisen/miden/wt-usdcx-ios-burn-b && yarn install --frozen-lockfile
```

Expected: one merged PR line, `PR 2a is on origin/main`, the worktree created, `yarn install` ending `Done`. If the first command prints nothing, PR 2a has not merged: stop and report (this plan's code calls its methods).

- [ ] **Step 2: Confirm the base still holds what this plan quotes**

```bash
cd /Users/celrisen/miden/wt-usdcx-ios-burn-b
git cat-file -e d8345cbd4^{commit} && echo "d8345cbd4 present"
git diff --stat d8345cbd4 HEAD -- playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts playwright.ios.usdcx-live.config.ts playwright.ios.config.ts .github/workflows/e2e-usdcx-live.yml playwright/e2e/harness/usdcx-live-workflow.test.ts playwright/e2e/harness/linked-pr-injection.test.ts playwright/e2e/docs/e2e-architecture.md playwright/e2e/helpers/arc-usdcx.ts playwright/e2e/helpers/arc-usdcx.test.ts playwright/e2e/helpers/usdcx-legs.ts playwright/e2e/helpers/usdcx-run.ts playwright/e2e/helpers/usdcx-miden.ts playwright/e2e/helpers/usdcx-guardian.ts playwright/e2e/helpers/usdcx-constants.ts playwright/e2e/helpers/bridge.ts playwright/e2e/helpers/history.ts playwright/e2e/helpers/public-faucet.ts playwright/e2e/helpers/public-note-commitment.ts src/lib/usdcx/constant.ts src/lib/usdcx/recipient.ts; echo "diff above (expect none)"
check() { grep -qE "^export (async function|function|const|class|interface|type) $2([^A-Za-z0-9_]|$)" "playwright/e2e/helpers/$1" && echo "ok $1 $2" || echo "MISSING $1 $2"; }
for n in arcEndpoints arcHost readArcUsdc readArcUsdcSnapshot readXReserveDomainState waitForGatewayPayout ArcReadDeps ArcKey ArcUsdcSnapshot GatewayPayout PREFUNDED_KEY_NOTE; do check arc-usdcx.ts $n; done
for n in namedSteps NamedStep PhaseTimeline pollUntil readSettledChange consumeFeePath burnCompletionPath burnOutputNoteProblem evidenceJson newRunEvidence describePage ledgerLine exactlyOne boundedTerm errorText takeRunArcKey FeeTerm RunEvidence StepContext; do check usdcx-run.ts $n; done
for n in harnessPayoutLeg HarnessPayoutLeg ConsumedBurn; do check usdcx-legs.ts $n; done
for n in accountHex burnEvidence burnOutputs note nullifier boundLandedFee BurnEvidence; do check usdcx-miden.ts $n; done
for n in guardianIdentity guardianFailureContext assertNoGuardianOpInFlight GuardianIdentity; do check usdcx-guardian.ts $n; done
for n in enText parseBridgeReceiveState; do check bridge.ts $n; done
for n in TxStatus describeTransactionRow TransactionRowSnapshot; do check history.ts $n; done
for n in BURN_UNITS GRANT_UNITS GAS_RESERVE_UNITS PAYOUT_TIMEOUT_MS WALLET_CONFIRM_TIMEOUT_MS ARC_CHAIN_ID ARC_CIRCLE_DOMAIN ARC_PUBLIC_URL ARC_READ_STEP_BUDGET_MS HARNESS_ARC_KEY_FILE; do check usdcx-constants.ts $n; done
grep -n 'USDCX_DECIMALS\|isWorthClaiming\|CLAIM_COST_FEE_MULTIPLE' playwright/e2e/helpers/usdcx-constants.ts | head -4
grep -nE '^export const (BURN_UNITS|GRANT_UNITS|GAS_RESERVE_UNITS) ' playwright/e2e/helpers/usdcx-constants.ts
grep -nE 'async (readTransactionRows|readBridgedSendRows|nativeAsset|readVaultBaseUnits|homeVaultBaseUnits|burnUsdcxViaSendFlow|waitForBurnCompleted|openTransactionDetails|transactionDetailsView)\(|signal\?: AbortSignal|^export (interface IosNativeAsset|function routeOf)' playwright/e2e/ios/helpers/ios-wallet-page.ts
grep -n 'USDCX_RUN_LOCK = \|HARNESS_ARC_KEY_FILE = ' scripts/e2e-real.mjs
```

Expected: `d8345cbd4 present`; no diff lines before `diff above (expect none)` (main's tree equals PR 1b's final head for these files; PR 2a touched none of them); every check line `ok ...`, no `MISSING`; the three re-exports in `usdcx-constants.ts`; `BURN_UNITS = 1_000_000n`, `GRANT_UNITS = 10_000_000n`, `GAS_RESERVE_UNITS = 20_000n`; PR 2a's nine methods, `signal?: AbortSignal`, `IosNativeAsset` and `routeOf`; the lock at `~/.miden-e2e/usdcx-run.lock` and the harness key at `~/.miden-e2e/arc-keys/harness.json`. A diff, a `MISSING` line or a changed shape means main moved after this plan was written: the merged code wins; re-check each before-snippet the diff touches, adapt the importing line and note the change in the task report. If `d8345cbd4` is absent, skip the diff and rely on the snippets.

- [ ] **Step 3: Baseline the suites this PR touches**

```bash
cd /Users/celrisen/miden/wt-usdcx-ios-burn-b && yarn jest playwright/e2e/ios/helpers playwright/e2e/harness playwright/e2e/helpers --maxWorkers=2 2>&1 | grep -E '^(Tests|Test Suites):'
```

Expected: `0 failed` in both lines. Record the totals; Tasks 1-3 add 7 tests to them (3 in Task 1, 1 plus 2 in Task 2, 1 in Task 3).

---

### Task 1: Harden the live iOS deposit leg

**Files:**
- Modify: `playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts:1-17`, `:52-55`, `:70-85`, `:106-110`, `:119-125`, `:127-167`, `:169-174`, `:211-215`, `:221-230`, `:249-258`, `:260-267`, `:269-276`, `:277-282`
- Create: `playwright/e2e/harness/usdcx-live-spec.test.ts`

**Interfaces:**
- Consumes: PR 2a's `IosWalletPage.nativeAsset`, `readTransactionRows`, `homeVaultBaseUnits`, `readVaultBaseUnits`, `navigateHome`, type `IosNativeAsset` (`baseFee` included); PR 1b: `arcEndpoints`, `arcHost(endpoint): string`, `readArcUsdc`, `readXReserveDomainState`, `ArcReadDeps` (arc-usdcx.ts:176, :152, :224, :268, :185), `parseBridgeReceiveState` (bridge.ts:589), `TxStatus`, `describeTransactionRow`, `TransactionRowSnapshot` (history.ts), `GAS_RESERVE_UNITS` (usdcx-constants.ts:33), `isWorthClaiming(amount, verificationBaseFee): boolean` and `CLAIM_COST_FEE_MULTIPLE` (30; re-exported by usdcx-constants.ts:20 from src/lib/miden/fees/spendable.ts), `guardianIdentity`, `GuardianIdentity` (usdcx-guardian.ts:47, :11), `accountHex`, `boundLandedFee` (usdcx-miden.ts:108, :345), and from `usdcx-run.ts`: `namedSteps`, `PhaseTimeline`, `pollUntil`, `readSettledChange`, `consumeFeePath`, `boundedTerm`, `exactlyOne`, `ledgerLine`, `errorText`, `evidenceJson`, `newRunEvidence`, `FeeTerm`, `RunEvidence`; `midenAccountHexToXReserveRecipient(hexId: string): Hex` (src/lib/usdcx/recipient.ts:19).
- Produces (spec-local, used by Task 2): `BUDGET`, `VAULT_MS`, `DEPOSIT_PHASES`, `noteIdsOf(row): string[]`, `hostedGuardian(url): Promise<GuardianIdentity>`, `settleLedger(wallet, native, term): Promise<{ vault: bigint; fee: FeeTerm }>`, `evidenceBody(evidence, secrets): string`; in the test body: `step`, `arc`, `evidence`, `secrets`, `native`, `recipient`, `depositVault` (Task 2 binds `identity` from `assert_guardian_account`).

- [ ] **Step 1: Write the failing guard tests**

Create `playwright/e2e/harness/usdcx-live-spec.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const spec = readFileSync(resolve(__dirname, '../ios/tests/usdcx-live-deposit.ios.spec.ts'), 'utf8');

/** The source between two step names, so a check is pinned to the step that owns it. */
function between(from: string, to: string): string {
  const start = spec.indexOf(`'${from}'`);
  const end = spec.indexOf(`'${to}'`, start);
  if (start === -1 || end === -1) throw new Error(`the spec has no step '${start === -1 ? from : to}'`);
  return spec.slice(start, end);
}

describe('the live iOS USDCx spec', () => {
  // A wrong recipient strands the deposit at the faucet, so it must fail in seconds, not after Circle's 20 minutes.
  it("checks what the counterparty signed and the row's recipient before it waits on Circle", () => {
    expect(between('assert_deposit_broadcast', 'row_reaches_delivering')).toMatch(
      /remoteRecipient: recipient,\s*maxFee: 0n,\s*hookData: '0x'/
    );
    expect(between('row_reaches_delivering', 'circle_attests_deposit')).toMatch(/usdcxRemoteRecipient/);
  });

  // A dispatch sets the deposit amount; one the wallet will not claim unattended must fail before anything is sent.
  it('refuses a deposit the wallet would leave unclaimed before it pairs the counterparty', () => {
    expect(between('native_asset', 'connect_evm')).toMatch(/isWorthClaiming\(depositUnits, read\.baseFee\)/);
  });

  // R24: an Arc URL can carry an API key in its path, and the evidence holds neither a key nor the password.
  it('names Arc endpoints by host and writes the evidence only through its refusal of secrets', () => {
    expect(spec).toMatch(/read on \$\{arcHost\(state\.endpoint\)\}/);
    expect(spec).not.toMatch(/\$\{[\w.]*\.endpoint\}/);
    expect(spec).toMatch(/fs\.writeFileSync\(evidencePath, evidenceBody\(evidence, secrets\)\)/);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `yarn jest playwright/e2e/harness/usdcx-live-spec.test.ts --maxWorkers=2 2>&1 | grep -E '^Tests:|Expected pattern|has no step'`
Expected: `Tests: 3 failed, 3 total`: the first on `Expected pattern: /remoteRecipient: recipient,\s*maxFee: 0n,\s*hookData: '0x'/`, the second on `the spec has no step 'native_asset'`, the third on `Expected pattern: /read on \$\{arcHost\(state\.endpoint\)\}/`.

- [ ] **Step 3: Replace the imports**

In `playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts` replace lines 1-17:

```ts
import { decodeFunctionData, encodeFunctionData, isHash, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { fetchXReserveAttestations, findAttestationForDomain } from '../../../../src/lib/usdcx/attestation';
import {
  CIRCLE_USDC_DECIMALS,
  ERC20_BALANCE_OF_ABI,
  getUsdcxXReserveSource,
  USDCX_DEPOSIT_HOOK_DATA,
  USDCX_DEPOSIT_MAX_FEE,
  USDCX_REMOTE_DOMAIN,
  XRESERVE_ABI
} from '../../../../src/lib/usdcx/constant';
import { ARC_TESTNET } from '../../../../src/lib/walletconnect/config';
import { readUsdcxRelayerEnv, UsdcxRelayer } from '../../helpers/usdcx-relayer';
import { expect, test } from '../fixtures/two-simulators';
import { WcCounterparty, type WcRequestLog } from '../helpers/wc-counterparty';
```

with:

```ts
import fs from 'fs';
import path from 'path';
import { decodeFunctionData, isHash, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { fetchXReserveAttestations, findAttestationForDomain } from '../../../../src/lib/usdcx/attestation';
import {
  CIRCLE_USDC_DECIMALS,
  getUsdcxXReserveSource,
  USDCX_REMOTE_DOMAIN,
  XRESERVE_ABI
} from '../../../../src/lib/usdcx/constant';
import { midenAccountHexToXReserveRecipient } from '../../../../src/lib/usdcx/recipient';
import { ARC_TESTNET } from '../../../../src/lib/walletconnect/config';
import { arcEndpoints, arcHost, readArcUsdc, readXReserveDomainState, type ArcReadDeps } from '../../helpers/arc-usdcx';
import { parseBridgeReceiveState } from '../../helpers/bridge';
import { describeTransactionRow, TxStatus, type TransactionRowSnapshot } from '../../helpers/history';
import { CLAIM_COST_FEE_MULTIPLE, GAS_RESERVE_UNITS, isWorthClaiming } from '../../helpers/usdcx-constants';
import { guardianIdentity, type GuardianIdentity } from '../../helpers/usdcx-guardian';
import { accountHex, boundLandedFee } from '../../helpers/usdcx-miden';
import { readUsdcxRelayerEnv, UsdcxRelayer } from '../../helpers/usdcx-relayer';
import {
  boundedTerm,
  consumeFeePath,
  errorText,
  evidenceJson,
  exactlyOne,
  ledgerLine,
  namedSteps,
  newRunEvidence,
  PhaseTimeline,
  pollUntil,
  readSettledChange,
  type FeeTerm,
  type RunEvidence
} from '../../helpers/usdcx-run';
import { expect, test } from '../fixtures/two-simulators';
import type { IosNativeAsset, IosWalletPage } from '../helpers/ios-wallet-page';
import { WcCounterparty, type WcRequestLog } from '../helpers/wc-counterparty';
```

- [ ] **Step 4: Replace the pause selector with the phase order, the vault wait and the budgets**

Replace lines 52-55:

```ts
// `DomainDepositsPaused(uint32)`: Circle paused deposits for a remote domain on xReserve.
const DOMAIN_DEPOSITS_PAUSED_SELECTOR = '0x14e2708f';
const ATTESTATION_TIMEOUT_MS = 20 * 60_000;
const MINT_AND_CLAIM_TIMEOUT_MS = 15 * 60_000;
```

with:

```ts
const ATTESTATION_TIMEOUT_MS = 20 * 60_000;
const MINT_AND_CLAIM_TIMEOUT_MS = 15 * 60_000;
// #1405: a fast round trip can go from submitting straight to received, so ready is recorded, never required.
const DEPOSIT_PHASES = ['submitting', 'delivering', 'ready', 'received'];
/** The store caught up within 5.1 s of a move Home (ios-spike-report.md section 4.1). */
const VAULT_MS = 30_000;
/** Step budgets: each a small multiple of the slowest spike run or CI run 38109117552, floored for chain variance. */
const BUDGET = {
  // spike 0.2 s for the cache, plus the oracle's account-hex read and a store that lands after Ready
  nativeAsset: 90_000,
  // CI 5.2 s for the old balance step (run 38109117552), plus the rows and the Home wait
  depositVault: 120_000,
  // the auth read, then 3 tries of /status and /pubkey at 15 s each: /pubkey answered one spike run with a 502 page
  guardianAccount: 150_000
};
```

- [ ] **Step 5: Replace the raw eth_call helper with the ledger and evidence helpers**

Replace lines 70-85:

```ts
const arcRpcUrl = ARC_TESTNET.rpcUrls.default.http[0];
const { usdc: arcUsdc, xReserve } = getUsdcxXReserveSource(ARC_TESTNET.id);

interface EthCallResult {
  result?: string;
  error?: { message?: string; data?: string };
}

async function arcEthCall(call: { from?: string; to: string; data: string }): Promise<EthCallResult> {
  const response = await fetch(arcRpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [call, 'latest'] })
  });
  return (await response.json()) as EthCallResult;
}
```

with:

```ts
const arcRpcUrl = ARC_TESTNET.rpcUrls.default.http[0];
const { usdc: arcUsdc, xReserve } = getUsdcxXReserveSource(ARC_TESTNET.id);

function noteIdsOf(row: TransactionRowSnapshot): string[] {
  return [...(row.noteIds ?? []), ...(row.noteId ? [row.noteId] : [])].map(id => id.toLowerCase());
}

/** The hosted Guardian's identity, read up to 3 times: its /pubkey answered one spike run with a 502 page. */
async function hostedGuardian(url: string): Promise<GuardianIdentity> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, 5_000));
    try {
      return await guardianIdentity(url);
    } catch (error) {
      last = error;
    }
  }
  throw new Error(`the hosted Guardian ${url} did not identify itself in 3 tries: ${errorText(last)}`);
}

/**
 * The vault after one transaction, read on Home: exact from the fee its row recorded, or settled with the fee bounded
 * by the chain's base fee when a landed path recorded none (Q5(d)). `credit` is what the transaction added and
 * `debits` all it took besides its fee.
 */
async function settleLedger(
  wallet: IosWalletPage,
  native: IosNativeAsset,
  term: {
    name: string;
    before: bigint;
    credit: bigint;
    debits: bigint;
    row: { id: string; feeAmount?: string; resultReleasedAt?: number };
  }
): Promise<{ vault: bigint; fee: FeeTerm }> {
  const feePath = consumeFeePath(term.row);
  if (feePath.kind === 'result') {
    const expected = term.before + term.credit - term.debits - feePath.fee;
    const terms = ledgerLine([
      ['before', term.before],
      ['credit', term.credit],
      ['debits', term.debits],
      [term.name, feePath.fee]
    ]);
    const vault = await wallet.homeVaultBaseUnits(
      native.tokenId,
      units => units === expected,
      VAULT_MS,
      `${expected} (${terms})`
    );
    return { vault, fee: { name: term.name, amount: feePath.fee, kind: 'exact' } };
  }
  await wallet.navigateHome();
  const vault = await readSettledChange(() => wallet.readVaultBaseUnits(native.tokenId), term.before, {
    timeoutMs: VAULT_MS,
    intervalMs: 2_000
  });
  const bound = boundLandedFee({
    vaultDelta: term.before - vault,
    knownTerms: term.debits - term.credit,
    baseFee: native.baseFee
  });
  return { vault, fee: boundedTerm(term.name, bound) };
}

/** The evidence JSON; throws rather than write a key or the onboarding password the bypass leaves in location.href. */
function evidenceBody(evidence: RunEvidence, secrets: readonly string[]): string {
  const body = evidenceJson(evidence, secrets);
  if (/[?&]password=/.test(body)) {
    throw new Error('the evidence would carry the onboarding password, so it was not written');
  }
  return body;
}
```

- [ ] **Step 6: Take `envConfig` from the fixture**

Replace lines 106-110:

```ts
  test('deposit USDC via the real UI, Circle attests, the relayer mints, the Guardian account claims', async ({
    walletA,
    walletB,
    steps
  }) => {
```

with:

```ts
  test('deposit USDC via the real UI, Circle attests, the relayer mints, the Guardian account claims', async ({
    walletA,
    walletB,
    steps,
    envConfig
  }) => {
```

- [ ] **Step 7: Set up the run state and the phase sampler**

Replace lines 119-125:

```ts
    let depositHash: `0x${string}`;
    let bridgeTxId: string;
    let addressA: string;

    const sentTo = (address: string) => (r: WcRequestLog) =>
      r.method === 'eth_sendTransaction' &&
      (r.params as Array<Record<string, string>>)[0]?.to?.toLowerCase() === address.toLowerCase();
```

with:

```ts
    let depositHash: `0x${string}`;
    let bridgeTxId: string;
    let addressA: string;
    const step = namedSteps(steps);
    const arc: ArcReadDeps = { endpoints: arcEndpoints(process.env.E2E_ARC_RPC_URL) };
    const evidence = newRunEvidence('usdcx-live-ios');
    // evidenceJson refuses to write any of these.
    const secrets: string[] = [evmPrivateKey];
    const depositPhases = new PhaseTimeline('deposit row', DEPOSIT_PHASES);

    const sentTo = (address: string) => (r: WcRequestLog) =>
      r.method === 'eth_sendTransaction' &&
      (r.params as Array<Record<string, string>>)[0]?.to?.toLowerCase() === address.toLowerCase();
    // A failed CDP read (an inspector reattach) is retried, as expect.poll did; a failed row fails at once.
    const depositPhase = async (): Promise<string | undefined> => {
      const raw = await walletA.getBridgeReceiveState(bridgeTxId).catch(() => undefined);
      if (raw === undefined) return undefined;
      const state = parseBridgeReceiveState(raw);
      depositPhases.record(state.phase, Date.now());
      if (state.phase === 'failed') {
        throw new Error(`the deposit row failed: ${state.error ?? state.displayMessage ?? 'no error recorded'}`);
      }
      return state.phase;
    };
```

The hosted Guardian's identity is read in `assert_guardian_account` (Step 14), after the deposit leg: main's deposit does not depend on `/pubkey`, which answered one spike run with a 502 page, and a read before `preflight_arc` would let a Guardian endpoint glitch stop the deposit leg from running at all.

- [ ] **Step 8: Preflight through the shared Arc reads, with a floor of deposit plus gas**

Replace lines 127-167 (the whole `preflight_arc` step, from `    await steps.step('preflight_arc', async () => {` through its closing `    });`) with:

```ts
    await steps.step('preflight_arc', async () => {
      // Fail here, with the cause, instead of after the wallet prompts for a deposit that cannot pass.
      const balance = await readArcUsdc(evmAddress, arc);
      expect(balance, `Arc USDC of ${evmAddress}: the deposit plus its approve and deposit gas`).toBeGreaterThanOrEqual(
        depositUnits + GAS_RESERVE_UNITS
      );
      // Withdrawals are checked before the burn, not here: a pause there must not hide this leg's result.
      const state = await readXReserveDomainState(arc);
      expect(
        { registered: state.registered, paused: state.paused, depositsPaused: state.depositsPaused },
        `xReserve domain ${USDCX_REMOTE_DOMAIN}, read on ${arcHost(state.endpoint)}`
      ).toEqual({ registered: true, paused: false, depositsPaused: false });
    });
```

- [ ] **Step 9: Read the native asset, refuse a deposit the wallet would not claim, and read the account's xReserve recipient, after the wallet exists and inside the try**

Replace lines 169-174:

```ts
    await steps.step('create_wallet', async () => {
      ({ address: addressA } = await walletA.createGuardianWallet());
      await walletB.createNewWallet(); // fixture requires both sims up; B takes no part
    });

    try {
```

with:

```ts
    await steps.step('create_wallet', async () => {
      ({ address: addressA } = await walletA.createGuardianWallet());
      await walletB.createNewWallet(); // fixture requires both sims up; B takes no part
    });

    try {
      // Inside the try, so a failure here still writes the evidence.
      const { native, recipient } = await step('native_asset', BUDGET.nativeAsset, async () => {
        evidence.ids.wallet = addressA;
        const read = await walletA.nativeAsset();
        // The wallet claims a mint unattended only above base fee x 30, and a dispatch sets the amount: a smaller
        // deposit would sit unclaimed until relayer_mints_and_wallet_claims gave up 15 min later.
        if (!isWorthClaiming(depositUnits, read.baseFee)) {
          throw new Error(
            `USDCX_LIVE_DEPOSIT_AMOUNT ${depositAmount} (${depositUnits} base units) does not exceed the wallet's ` +
              `unattended claim floor, base fee ${read.baseFee} x ${CLAIM_COST_FEE_MULTIPLE}`
          );
        }
        // The deposit's remoteRecipient for this account, as the faucet decodes it.
        return { native: read, recipient: midenAccountHexToXReserveRecipient(await accountHex(addressA)) };
      });
      evidence.ids.native = native.tokenId;
```

- [ ] **Step 10: Decode the whole deposit the counterparty signed**

Replace lines 211-215:

```ts
        const [value, remoteDomain, , localToken] = decoded.args;
        expect(value, 'deposit amount').toBe(depositUnits);
        expect(remoteDomain, 'remote domain = Miden').toBe(USDCX_REMOTE_DOMAIN);
        expect(localToken.toLowerCase(), 'deposited token = Arc USDC').toBe(arcUsdc.toLowerCase());
      });
```

with:

```ts
        const [value, remoteDomain, remoteRecipient, localToken, maxFee, hookData] = decoded.args;
        expect(value, 'deposit amount').toBe(depositUnits);
        expect(remoteDomain, 'remote domain = Miden').toBe(USDCX_REMOTE_DOMAIN);
        expect(localToken.toLowerCase(), 'deposited token = Arc USDC').toBe(arcUsdc.toLowerCase());
        // The faucet mints to remoteRecipient, so a wrong one strands the deposit; the wallet pays no fee and no hook.
        expect(
          { remoteRecipient: remoteRecipient.toLowerCase(), maxFee, hookData },
          'the recipient, maxFee and hookData the counterparty signed'
        ).toEqual({ remoteRecipient: recipient, maxFee: 0n, hookData: '0x' });
        evidence.hashes.deposit = depositHash;
      });
```

- [ ] **Step 11: Sample the deposit row's phases and check its recipient**

Replace lines 221-230:

```ts
        const row = await walletA.latestBridgeReceive('usdcx');
        expect(row, 'bridged-receive row created by the UI').not.toBeNull();
        bridgeTxId = row!.id;
        await expect
          .poll(async () => (await walletA.getBridgeReceiveState(bridgeTxId)).phase, {
            timeout: 180_000,
            intervals: [3000]
          })
          .toMatch(/^(delivering|ready|received)$/);
      });
```

with:

```ts
        const row = await walletA.latestBridgeReceive('usdcx');
        expect(row, 'bridged-receive row created by the UI').not.toBeNull();
        bridgeTxId = row!.id;
        evidence.ids.depositRow = bridgeTxId;
        depositPhases.record(row!.phase, Date.now());
        await pollUntil(
          'the deposit row leaving submitting',
          depositPhase,
          phase => phase !== undefined && phase !== 'submitting',
          { timeoutMs: 180_000, intervalMs: 3_000 }
        );
        // The deposit screen wrote the recipient it signed for at the row's first phase write.
        const state = parseBridgeReceiveState(await walletA.getBridgeReceiveState(bridgeTxId));
        expect(state.usdcxRemoteRecipient, "the deposit row's xReserve recipient").toBe(recipient);
      });
```

- [ ] **Step 12: End the deposit phases monotone at received**

Replace lines 249-258:

```ts
        await expect
          .poll(
            async () => {
              localRelayer?.assertRunning();
              return (await walletA.getBridgeReceiveState(bridgeTxId)).phase;
            },
            { timeout: MINT_AND_CLAIM_TIMEOUT_MS, intervals: [5000] }
          )
          .toBe('received');
      });
```

with:

```ts
        await pollUntil(
          'the relayer mint and the wallet claim',
          async () => {
            localRelayer?.assertRunning();
            return depositPhase();
          },
          phase => phase === 'received',
          { timeoutMs: MINT_AND_CLAIM_TIMEOUT_MS, intervalMs: 5_000 }
        );
        depositPhases.assertMonotone();
        evidence.phases.deposit = depositPhases.samples();
      });
```

- [ ] **Step 13: Replace the float balance range with the exact vault**

Replace lines 260-267:

```ts
      await steps.step('assert_balance', async () => {
        // A new wallet starts at zero, and the claim pays its fee in USDCx out of the
        // deposit. The fee is not a fixed number, so the lower bound is half the deposit:
        // a mint of the wrong amount, or no mint, fails it.
        const deposited = Number(depositAmount);
        const balance = await walletA.waitForBalanceAbove(deposited / 2, 180_000, undefined, 'USDCX');
        expect(balance, 'no more than the deposit').toBeLessThanOrEqual(deposited);
      });
```

with:

```ts
      const depositVault = await step('deposit_vault', BUDGET.depositVault, async () => {
        const state = parseBridgeReceiveState(await walletA.getBridgeReceiveState(bridgeTxId));
        const claim = exactlyOne(
          (await walletA.readTransactionRows({ type: 'consume' })).filter(row => row.status === TxStatus.Completed),
          'Completed consume on the fresh wallet, the claim of the minted note',
          describeTransactionRow
        );
        expect(
          state.midenNoteId === undefined || noteIdsOf(claim).includes(state.midenNoteId.toLowerCase()),
          `the claim ${claim.id} consumed the mint note ${state.midenNoteId} the deposit row names`
        ).toBe(true);
        // A new wallet starts at zero, so the vault is the mint less the fee the claim's row recorded.
        const settled = await settleLedger(walletA, native, {
          name: 'f2',
          before: 0n,
          credit: depositUnits,
          debits: 0n,
          row: claim
        });
        evidence.ids.mintNote = state.midenNoteId ?? 'not recorded';
        evidence.ids.mintConsume = claim.id;
        evidence.fees.push(settled.fee);
        return settled.vault;
      });
      evidence.notes.push(`vault after the claim ${depositVault}`);
```

- [ ] **Step 14: Read the hosted Guardian's identity and check the account's commitment against it**

Replace lines 269-276 (the whole `assert_guardian_account` step):

```ts
      await steps.step('assert_guardian_account', async () => {
        // The auth structure shows the deposit landed on, and was claimed by, a Guardian account, not a single-sig
        // one, so this spec cannot quietly go back to testing the single-sig path.
        const auth = await walletA.getGuardianAuthInfo(addressA);
        expect(auth.error, `guardian auth read failed: ${auth.error}`).toBeUndefined();
        expect(auth.signerCommitments.length, 'a fresh Guardian account has 2 signers (hot, cold)').toBe(2);
        expect(auth.procedureThresholds.update_guardian, 'update_guardian is hardened to threshold 2').toBe(2);
      });
```

with:

```ts
      // The identity is read here, after the deposit leg, so a Guardian endpoint glitch cannot stop that leg running.
      await step('assert_guardian_account', BUDGET.guardianAccount, async () => {
        // The auth structure shows the deposit landed on, and was claimed by, a Guardian account, not a single-sig
        // one, so this spec cannot quietly go back to testing the single-sig path.
        const auth = await walletA.getGuardianAuthInfo(addressA);
        expect(auth.error, `guardian auth read failed: ${auth.error}`).toBeUndefined();
        expect(auth.signerCommitments.length, 'a fresh Guardian account has 2 signers (hot, cold)').toBe(2);
        expect(auth.procedureThresholds.update_guardian, 'update_guardian is hardened to threshold 2').toBe(2);
        const hosted = await hostedGuardian(envConfig.guardianUrl);
        evidence.guardian = {
          url: hosted.url,
          version: hosted.version,
          gitCommit: hosted.gitCommit,
          commitment: hosted.commitment
        };
        // The iOS build picks its Guardian itself, so this also proves it is the hosted one the run identified.
        expect(
          `0x${(auth.guardianCommitment ?? '').replace(/^0x/i, '').toLowerCase()}`,
          `the account's Guardian commitment against ${hosted.url}/pubkey`
        ).toBe(hosted.commitment);
      });
```

Task 2 Step 11 makes this step hand `hosted` back as `identity` for the burn half's Guardian failure contexts.

- [ ] **Step 15: Write and attach the evidence on every outcome**

Replace lines 277-282:

```ts
    } finally {
      if (localRelayer) {
        await test.info().attach('usdcx-relayer-log', { body: localRelayer.logs, contentType: 'text/plain' });
      }
      await cp.stop();
    }
```

with:

```ts
    } finally {
      if (localRelayer) {
        await test.info().attach('usdcx-relayer-log', { body: localRelayer.logs, contentType: 'text/plain' });
      }
      await cp.stop();
      // In the run's artifact directory, which the nightly uploads (test-results-ios/).
      const evidencePath = path.join(steps.outputDir, 'usdcx-live-ios-evidence.json');
      fs.mkdirSync(steps.outputDir, { recursive: true });
      fs.writeFileSync(evidencePath, evidenceBody(evidence, secrets));
      await test.info().attach('usdcx-live-ios-evidence.json', { path: evidencePath, contentType: 'application/json' });
    }
```

- [ ] **Step 16: Run the guards to see them pass, and prove the spec still compiles and lists**

```bash
cd /Users/celrisen/miden/wt-usdcx-ios-burn-b
yarn jest playwright/e2e/harness/usdcx-live-spec.test.ts --maxWorkers=2 2>&1 | grep -E '^Tests:'
npx prettier --write playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts playwright/e2e/harness/usdcx-live-spec.test.ts
yarn jest playwright/e2e/harness/usdcx-live-spec.test.ts --maxWorkers=2 2>&1 | grep -E '^Tests:'
npx eslint --max-warnings 0 playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts playwright/e2e/harness/usdcx-live-spec.test.ts; echo "eslint exit $?"
npx playwright test --config playwright.ios.usdcx-live.config.ts --list 2>&1 | tail -2
yarn lint:e2e; echo "lint:e2e exit $?"
```

Expected: `Tests: 3 passed, 3 total` twice (the guards' regexes tolerate prettier's line breaks), `eslint exit 0`, `Total: 1 test in 1 file` (the spec module loads with its new imports; `--list` runs no globalSetup), `lint:e2e exit 0`.

- [ ] **Step 17: Commit**

```bash
cd /Users/celrisen/miden/wt-usdcx-ios-burn-b
git add playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts playwright/e2e/harness/usdcx-live-spec.test.ts
git status --short
git commit -m "test(e2e): harden the live iOS USDCx deposit leg"
```

Expected: exactly the two paths staged; one commit, no trailer.

---

### Task 2: A payout leg for any key, and the burn half gated on Circle's payout and the wallet's confirmation

**Files:**
- Modify: `playwright/e2e/helpers/usdcx-legs.ts:559-560`, `:569`, `:576-577`, `:588-611`, `:635`, `:646-649` (the payout leg)
- Test: `playwright/e2e/helpers/arc-usdcx.test.ts:76` (import), `:861-866` (the end of `describe('harnessPayoutLeg (usdcx-legs.ts)', ...)`)
- Modify: `playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts` (imports, `BUDGET` and the constants after it, the header doc lines 33-35 on main, the test title on main :106, `assert_guardian_account` handing back the identity, and the burn half after it)
- Modify: `playwright.ios.usdcx-live.config.ts:5-20`
- Test: `playwright/e2e/harness/usdcx-live-spec.test.ts` (append)

**Interfaces:**
- Consumes: PR 2a's `burnUsdcxViaSendFlow(opts: UsdcxBurnViaSendOptions)` (with `signal?: AbortSignal`), `waitForBurnCompleted(rowId, timeoutMs, pollMs?): Promise<{ row: BridgedSendRow; stages: BurnStageSample[] }>`, `openTransactionDetails(rowId)`, `transactionDetailsView(rowId): Promise<{ pill: string | null; arcTxLinks: string[] }>`, `readBridgedSendRows`, `readTransactionRows`, `navigateHome`, `delay`, `evalJs`; Task 1's `step`, `arc`, `evidence`, `secrets`, `native`, `depositVault`, `settleLedger`, `noteIdsOf`, `BUDGET`, `VAULT_MS`, and the spec's own `evmPrivateKey` (main :57) and `evmAddress` (main :118); PR 1b: `readArcUsdcSnapshot(address, deps): Promise<ArcUsdcSnapshot>` (arc-usdcx.ts:240), `waitForGatewayPayout` (:577, through the leg), `readArcUsdc`, `readXReserveDomainState` (`registered`, `paused`, `withdrawalsPaused`, `depositor`, `endpoint`), `arcHost`, `takeRunArcKey(env)` (usdcx-run.ts:63), `NamedStep` (:120, which hands each step an `AbortSignal`), `burnCompletionPath`, `burnOutputNoteProblem(path, row, burnNoteId): string | undefined` (:350), `describePage`, `StepContext`, `ConsumedBurn` (usdcx-legs.ts:555), `HARNESS_ARC_KEY_FILE`, `ARC_READ_STEP_BUDGET_MS` (usdcx-constants.ts:61), `GRANT_UNITS` (:37), `burnEvidence(rpcUrl, { faucetBech32, noteId, senderBech32, domain, recipient, amount }): Promise<BurnEvidence>` (usdcx-miden.ts:148), `burnOutputs({ resultBytesBase64, burnNoteId, faucetBech32 }): Promise<BurnOutputs>` (:191), `note(rpcUrl, noteId): Promise<MidenNoteRead>` (:237), `nullifier(rpcUrl, noteId)` (:262), `assertNoGuardianOpInFlight(rows, accountId)` and `guardianFailureContext(identity)` (usdcx-guardian.ts:88, :67), `enText` (bridge.ts:517), `mintFromPublicFaucet(baseUrl, accountId, amount?): Promise<{ noteId: string }>` and `publicFaucetApiUrl(network)` (public-faucet.ts:274, :50), `waitForPublicNoteCommitment(rpcUrl, noteId, timeoutMs?)` (public-note-commitment.ts:32).
- Produces (usdcx-legs.ts):
  - `export interface PayoutKey { key: ArcKey; role: string; label: string }`
  - `export interface PayoutLeg { key: ArcKey; snapshot: ArcUsdcSnapshot; waitForPayout(burn: ConsumedBurn, depositor: Hex): Promise<GatewayPayout> }` (the old `HarnessPayoutLeg`, which nothing outside the file named)
  - `export async function payoutLeg(step: NamedStep, opts: { takeKey: () => PayoutKey; arc: ArcReadDeps; budget: { keySnapshot: number; payout: number }; evidence: RunEvidence; secrets: string[] }): Promise<PayoutLeg>`
  - `harnessPayoutLeg(step, { env, arc, budget, evidence, secrets }): Promise<PayoutLeg>`, signature and behaviour unchanged
- Produces (spec): steps `arc_state`, `grant`, `grant_consumed`, `settle_grant`, `key_snapshot` and `payout` (the leg's), `burn_via_send`, `burn_completed`, `burn_consumed`, `wallet_confirms_payout`; evidence ids `grantNote`, `grantConsume`, `arcKey`, `arcKeyRole` (`deposit`), `arcBalanceBefore`, `arcSnapshotBlock`, `burnRow`, `burnNote`, `walletConfirmedBalance`; hashes `burnTransaction`, `payout`; fees `f0`, `f1`, `s`, `circle payout fee`; latencies `consumeToPayout`, `payoutToWalletConfirmation`; phases `burn`.

- [ ] **Step 1: Write the failing payout-leg test**

In `playwright/e2e/helpers/arc-usdcx.test.ts` replace line 76:

```ts
import { harnessPayoutLeg } from './usdcx-legs';
```

with:

```ts
import { harnessPayoutLeg, payoutLeg } from './usdcx-legs';
```

Then, at the end of `describe('harnessPayoutLeg (usdcx-legs.ts)', ...)`, the anchor is lines 861-866:

```ts
    await expect(failure).rejects.not.toThrow('token-in-path');
    expect(clock.slept).toEqual(Array(PAYOUT_TIMEOUT_MS / 5_000).fill(5_000));
    expect(evidence.hashes).toEqual({});
    expect(evidence.fees).toEqual([]);
  });
});
```

Replace it with:

```ts
    await expect(failure).rejects.not.toThrow('token-in-path');
    expect(clock.slept).toEqual(Array(PAYOUT_TIMEOUT_MS / 5_000).fill(5_000));
    expect(evidence.hashes).toEqual({});
    expect(evidence.fees).toEqual([]);
  });

  // R20: the iOS nightly burns back to its deposit key, which no runner hands out, so the spec names that key itself.
  it('takes any key the run names, records its role and names it by its label when Circle has not paid', async () => {
    const { step, taken } = recordingSteps();
    const evidence = newRunEvidence('usdcx-live-ios');
    const secrets: string[] = [];
    const chain = payoutChain({ balances: [HELD], logs: history });
    const arc = {
      endpoints: ['https://arc.example/v2/token-in-path'],
      publicClient: () => stubClient(chain),
      clock: fakeClock(CONSUME_MS)
    };
    const label = `deposit key ${KEY} (USDCX_LIVE_EVM_PRIVATE_KEY), which Circle pays,`;

    const leg = await payoutLeg(step, {
      takeKey: () => ({ key: { address: KEY, privateKey: ARC_KEY }, role: 'deposit', label }),
      arc,
      budget: BUDGET,
      evidence,
      secrets
    });
    const failure = leg.waitForPayout(burn, depositor);

    await expect(failure).rejects.toThrow(`${label} held ${HELD} at Arc block 66483822 (read on arc.example); `);
    expect(taken).toEqual([
      ['key_snapshot', BUDGET.keySnapshot],
      ['payout', BUDGET.payout]
    ]);
    expect(secrets).toEqual([ARC_KEY]);
    expect(evidence.ids).toMatchObject({ arcKey: KEY, arcKeyRole: 'deposit', arcBalanceBefore: String(HELD) });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `yarn jest playwright/e2e/helpers/arc-usdcx.test.ts --maxWorkers=2 2>&1 | grep -E '^Tests:|is not a function'`
Expected: `Tests: 1 failed, <n> passed, <n + 1> total`, the failure reading `payoutLeg) is not a function` (`<n>` is this file's own count in Setup Step 3's run).

- [ ] **Step 3: Split the harness leg into a leg for any key**

In `playwright/e2e/helpers/usdcx-legs.ts` replace lines 559-560:

```ts
/** Spec 5 step 8 failure body: the harness key and its pre-burn read, the burn's consume and xReserve's pause flags. */
function payoutContext(arc: ArcReadDeps, key: ArcKey, snapshot: ArcUsdcSnapshot, burn: ConsumedBurn): StepContext {
```

with:

```ts
/** Spec 5 step 8 failure body: the payout key and its pre-burn read, the burn's consume and xReserve's pause flags. */
function payoutContext(arc: ArcReadDeps, label: string, snapshot: ArcUsdcSnapshot, burn: ConsumedBurn): StepContext {
```

Replace line 569:

```ts
      `harness key ${key.address} (${HARNESS_ARC_KEY_FILE}) held ${snapshot.balance} at Arc block ` +
```

with:

```ts
      `${label} held ${snapshot.balance} at Arc block ` +
```

Replace lines 576-577:

```ts
/** The harness key and its read right before a burn (R21), and the step that waits for that burn's payout (R22). */
export interface HarnessPayoutLeg {
```

with:

```ts
/** The Arc key a payout leg waits on: the role the evidence records and the label a failure names, never its key. */
export interface PayoutKey {
  key: ArcKey;
  role: string;
  /** The key's address and where it is kept, e.g. `harness key 0x... (~/.miden-e2e/arc-keys/harness.json)`. */
  label: string;
}

/** A payout key and its read right before a burn (R21), and the step that waits for that burn's payout (R22). */
export interface PayoutLeg {
```

Replace lines 588-611:

```ts
/**
 * The payout leg of every burn to the shared harness key: `key_snapshot` reads the key right before the burn, and the
 * test ends only once `waitForPayout` has proven Circle paid exactly that burn, so no payout is left to land in a later
 * run's window (R22). Both steps write their evidence.
 */
export async function harnessPayoutLeg(
  step: NamedStep,
  opts: {
    env: Record<string, string | undefined>;
    arc: ArcReadDeps;
    budget: { keySnapshot: number; payout: number };
    evidence: RunEvidence;
    secrets: string[];
  }
): Promise<HarnessPayoutLeg> {
  const { arc, evidence } = opts;
  const { key, snapshot } = await step('key_snapshot', opts.budget.keySnapshot, async () => {
    const { key, role } = takeRunArcKey(opts.env);
    opts.secrets.push(key.privateKey);
    expect(role, `${evidence.suite} burns to the harness key`).toBe('harness');
    return { key, snapshot: await readArcUsdcSnapshot(key.address, arc) };
  });
  evidence.ids.arcKey = key.address;
  evidence.ids.arcKeyRole = 'harness';
```

with:

```ts
/**
 * The payout leg of a burn to `takeKey`'s key: `key_snapshot` reads the key right before the burn, and the test ends
 * only once `waitForPayout` has proven Circle paid exactly that burn, so no payout is left to land in a later run's
 * window (R22). Both steps write their evidence.
 */
export async function payoutLeg(
  step: NamedStep,
  opts: {
    takeKey: () => PayoutKey;
    arc: ArcReadDeps;
    budget: { keySnapshot: number; payout: number };
    evidence: RunEvidence;
    secrets: string[];
  }
): Promise<PayoutLeg> {
  const { arc, evidence } = opts;
  const { taken, snapshot } = await step('key_snapshot', opts.budget.keySnapshot, async () => {
    const taken = opts.takeKey();
    opts.secrets.push(taken.key.privateKey);
    return { taken, snapshot: await readArcUsdcSnapshot(taken.key.address, arc) };
  });
  const { key } = taken;
  evidence.ids.arcKey = key.address;
  evidence.ids.arcKeyRole = taken.role;
```

Replace line 635:

```ts
      payoutContext(arc, key, snapshot, burn)
```

with:

```ts
      payoutContext(arc, taken.label, snapshot, burn)
```

Replace lines 646-649:

```ts
  return { key, snapshot, waitForPayout };
}

/** Spec 5 step 7: the burn's details read Burn confirmed (or Confirmed once paid), name Arc Testnet and link the key. */
```

with:

```ts
  return { key, snapshot, waitForPayout };
}

/** `payoutLeg` on the harness key `yarn e2e:real` handed the run (R21), which every extension burn pays. */
export async function harnessPayoutLeg(
  step: NamedStep,
  opts: {
    env: Record<string, string | undefined>;
    arc: ArcReadDeps;
    budget: { keySnapshot: number; payout: number };
    evidence: RunEvidence;
    secrets: string[];
  }
): Promise<PayoutLeg> {
  const { env, ...rest } = opts;
  return payoutLeg(step, {
    ...rest,
    takeKey: () => {
      const { key, role } = takeRunArcKey(env);
      expect(role, `${opts.evidence.suite} burns to the harness key`).toBe('harness');
      return { key, role, label: `harness key ${key.address} (${HARNESS_ARC_KEY_FILE})` };
    }
  });
}

/** Spec 5 step 7: the burn's details read Burn confirmed (or Confirmed once paid), name Arc Testnet and link the key. */
```

`HarnessPayoutLeg` had no user outside this file (`git grep -n HarnessPayoutLeg` prints only these lines before the edit, and nothing after it).

- [ ] **Step 4: Run the leg's tests and the directories that import it**

```bash
cd /Users/celrisen/miden/wt-usdcx-ios-burn-b
yarn jest playwright/e2e/helpers/arc-usdcx.test.ts --maxWorkers=2 2>&1 | grep -E '^Tests:'
yarn jest playwright/e2e/helpers playwright/e2e/harness --maxWorkers=2 2>&1 | grep -E '^(Tests|Test Suites):'
git grep -n HarnessPayoutLeg; echo "grep exit $?"
npx prettier --write playwright/e2e/helpers/usdcx-legs.ts playwright/e2e/helpers/arc-usdcx.test.ts
npx eslint --max-warnings 0 playwright/e2e/helpers/usdcx-legs.ts playwright/e2e/helpers/arc-usdcx.test.ts; echo "eslint exit $?"
```

Expected: `Tests: <n + 1> passed, <n + 1> total`; `0 failed` in both directory lines (the two `harnessPayoutLeg` tests, which pin its step names, budgets, evidence and failure text, pass unchanged, and so does `spec-selection.test.ts`'s wiring guard of the two extension specs); `grep exit 1`; `eslint exit 0`.

- [ ] **Step 5: Commit the payout leg**

```bash
cd /Users/celrisen/miden/wt-usdcx-ios-burn-b
git add playwright/e2e/helpers/usdcx-legs.ts playwright/e2e/helpers/arc-usdcx.test.ts
git status --short
git commit -m "test(e2e): payout leg for any Arc key, the harness key's among them"
```

Expected: exactly the two paths staged; one commit, no trailer.

- [ ] **Step 6: Write the failing guard tests of the burn half**

Append to `playwright/e2e/harness/usdcx-live-spec.test.ts`, inside the `describe('the live iOS USDCx spec', ...)` block, after Task 1's last `it` (before the describe's closing `});`):

```ts

  // Circle's Arc payouts have run hours late, so the burn half comes last: it can redden a run only after the deposit
  // leg passed.
  it('burns only after the deposit leg and gates on the payout before the wallet confirmation', () => {
    const markers = [
      "'relayer_mints_and_wallet_claims'",
      "'arc_state'",
      "'grant'",
      'await payoutLeg(step,',
      "'burn_via_send'",
      'await waitForPayout(',
      "'wallet_confirms_payout'"
    ];
    const at = markers.map(marker => spec.indexOf(marker));
    expect(markers.filter((_marker, i) => (at[i] ?? -1) <= (i === 0 ? -1 : (at[i - 1] ?? -1)))).toEqual([]);
  });

  // R20: the payout refills the key the deposit spent, and the gate counts from the leg's read right before the burn.
  it('burns back to the deposit key and holds the wallet to the snapshot the payout gate counts from', () => {
    expect(between('settle_grant', 'burn_via_send')).toMatch(
      /key: \{ address: evmAddress,[\s\S]*takeKey: \(\) => depositKey,/
    );
    expect(between('burn_via_send', 'burn_completed')).toMatch(/destAddress: key\.address,/);
    expect(between('burn_completed', 'burn_consumed')).toMatch(/before: snapshot\.balance\.toString\(\)/);
  });
```

- [ ] **Step 7: Run them to see them fail**

Run: `yarn jest playwright/e2e/harness/usdcx-live-spec.test.ts --maxWorkers=2 2>&1 | grep -E '^Tests:'`
Expected: `Tests: 2 failed, 3 passed, 5 total` (the order test lists every marker from `'arc_state'` on; the delta test throws `the spec has no step 'settle_grant'`).

- [ ] **Step 8: Extend the spec's imports**

Replace the import block Task 1 wrote (from `import fs from 'fs';` through `import { WcCounterparty, type WcRequestLog } from '../helpers/wc-counterparty';`, however prettier wrapped them) with:

```ts
import fs from 'fs';
import path from 'path';
import { decodeFunctionData, formatUnits, isHash, isHex, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { fetchXReserveAttestations, findAttestationForDomain } from '../../../../src/lib/usdcx/attestation';
import {
  CIRCLE_USDC_DECIMALS,
  getUsdcxXReserveSource,
  USDCX_REMOTE_DOMAIN,
  XRESERVE_ABI
} from '../../../../src/lib/usdcx/constant';
import { midenAccountHexToXReserveRecipient } from '../../../../src/lib/usdcx/recipient';
import { ARC_TESTNET } from '../../../../src/lib/walletconnect/config';
import { arcEndpoints, arcHost, readArcUsdc, readXReserveDomainState, type ArcReadDeps } from '../../helpers/arc-usdcx';
import { enText, parseBridgeReceiveState } from '../../helpers/bridge';
import { describeTransactionRow, TxStatus, type TransactionRowSnapshot } from '../../helpers/history';
import { mintFromPublicFaucet, publicFaucetApiUrl } from '../../helpers/public-faucet';
import { waitForPublicNoteCommitment } from '../../helpers/public-note-commitment';
import {
  ARC_CHAIN_ID,
  ARC_CIRCLE_DOMAIN,
  ARC_PUBLIC_URL,
  ARC_READ_STEP_BUDGET_MS,
  BURN_UNITS,
  CLAIM_COST_FEE_MULTIPLE,
  GAS_RESERVE_UNITS,
  GRANT_UNITS,
  isWorthClaiming,
  PAYOUT_TIMEOUT_MS,
  USDCX_DECIMALS,
  WALLET_CONFIRM_TIMEOUT_MS
} from '../../helpers/usdcx-constants';
import {
  assertNoGuardianOpInFlight,
  guardianFailureContext,
  guardianIdentity,
  type GuardianIdentity
} from '../../helpers/usdcx-guardian';
import { payoutLeg, type PayoutKey } from '../../helpers/usdcx-legs';
import { accountHex, boundLandedFee, burnEvidence, burnOutputs, note, nullifier } from '../../helpers/usdcx-miden';
import { readUsdcxRelayerEnv, UsdcxRelayer } from '../../helpers/usdcx-relayer';
import {
  boundedTerm,
  burnCompletionPath,
  burnOutputNoteProblem,
  consumeFeePath,
  describePage,
  errorText,
  evidenceJson,
  exactlyOne,
  ledgerLine,
  namedSteps,
  newRunEvidence,
  PhaseTimeline,
  pollUntil,
  readSettledChange,
  type FeeTerm,
  type RunEvidence,
  type StepContext
} from '../../helpers/usdcx-run';
import { expect, test } from '../fixtures/two-simulators';
import type { IosNativeAsset, IosWalletPage } from '../helpers/ios-wallet-page';
import { WcCounterparty, type WcRequestLog } from '../helpers/wc-counterparty';
```

- [ ] **Step 9: The burn half's budgets and constants**

Replace Task 1's budget block:

```ts
/** Step budgets: each a small multiple of the slowest spike run or CI run 38109117552, floored for chain variance. */
const BUDGET = {
  // spike 0.2 s for the cache, plus the oracle's account-hex read and a store that lands after Ready
  nativeAsset: 90_000,
  // CI 5.2 s for the old balance step (run 38109117552), plus the rows and the Home wait
  depositVault: 120_000,
  // the auth read, then 3 tries of /status and /pubkey at 15 s each: /pubkey answered one spike run with a 502 page
  guardianAccount: 150_000
};
```

with:

```ts
/** Step budgets: each a small multiple of the slowest spike run or CI run 38109117552, floored for chain variance. */
const BUDGET = {
  // spike 0.2 s for the cache, plus the oracle's account-hex read and a store that lands after Ready
  nativeAsset: 90_000,
  // CI 5.2 s for the old balance step (run 38109117552), plus the rows and the Home wait
  depositVault: 120_000,
  // the auth read, then 3 tries of /status and /pubkey at 15 s each: /pubkey answered one spike run with a 502 page
  guardianAccount: 150_000,
  // each Arc read step outlasts a stall on every endpoint before the last one answers (R24)
  arcState: ARC_READ_STEP_BUDGET_MS,
  // spike 1.5 s for PoW and submit; the faucet helper waits out 429s for up to 180 s, then the 120 s commitment
  grant: 360_000,
  // spike 18 s to Completed; floor: a Guardian co-signed consume proved locally on a CI simulator
  grantConsumed: 300_000,
  // the commit lands a block or two after the consume completed, then GUARDIAN_SETTLE_MS
  settle: 120_000,
  keySnapshot: ARC_READ_STEP_BUDGET_MS,
  // spike 4.6 s; holds the driver's 60 s review-ready and 60 s submit polls
  burnViaSend: 240_000,
  // spike 4.8 s; floor: a local prove when the remote prover misses its ~10 s deadline
  burnCompleted: 300_000,
  // spike 14 s from Completed to the faucet's consume; floor: the faucet's network transaction
  burnConsumed: 300_000,
  // D3: the consume plus 10 min, plus the log scan
  payout: PAYOUT_TIMEOUT_MS + 120_000,
  // spike 3.4 s; plus the details page and its receiving-tx link
  walletConfirmed: WALLET_CONFIRM_TIMEOUT_MS + 60_000
};
// A burn skips the wallet's settlement gate (#312) and is not requeued on a 409, so the hosted Guardian must have
// promoted the grant consume's candidate first; it runs a 3 s pass once a transaction commits, and the spike's 20 s
// after the consume gave no 409 on 3 burns.
const GUARDIAN_SETTLE_MS = 20_000;
// consuming lasts about a block and the spike never sampled it, so it is recorded, never required.
const BURN_PHASES = ['pending', 'consuming', 'confirmed'];
const RECEIVING_TX_LINK_MS = 15_000;
```

- [ ] **Step 10: Say what the spec now does**

Replace main's header lines 33-35 (unchanged by Task 1):

```ts
 *      auth structure afterwards.
 *
 * The run spends real Arc Testnet USDC (the deposit and the gas).
```

with:

```ts
 *      auth structure afterwards.
 *   7. Only then the burn: the wallet takes USDCx from the public faucet and burns 1 USDCx through Send, with the
 *      Arc Testnet chip, back to the funded key's own address. The run fails unless Circle pays that key within 10
 *      minutes of the faucet consuming the burn (one GatewayMinter AttestationUsed log that carries the burn note id
 *      and adds exactly its value to the key's balance, read right before the burn) and the wallet confirms the
 *      payout itself: the row's destination balance, then the History pill.
 *
 * The run spends public faucet USDCx and real Arc Testnet USDC (the deposit and the gas). At the default 0.01 USDC
 * deposit the payout of about 0.98 USDC more than refills that, so the funded key needs no top-up
 * (playwright/e2e/docs/e2e-architecture.md, section 8).
```

And replace the test title line (main :106):

```ts
  test('deposit USDC via the real UI, Circle attests, the relayer mints, the Guardian account claims', async ({
```

with:

```ts
  test('deposit USDC through the UI and claim it, then burn USDCx back to the deposit key and Circle pays it', async ({
```

(119 columns: prettier keeps the call on one line, so the body's indentation, which later anchors and mutations quote, does not move.)

- [ ] **Step 11: The burn half**

The anchor is Task 1's `assert_guardian_account` step, from its opening line through the `finally`:

```ts
      await step('assert_guardian_account', BUDGET.guardianAccount, async () => {
```

through

```ts
          `the account's Guardian commitment against ${hosted.url}/pubkey`
        ).toBe(hosted.commitment);
      });
    } finally {
```

Change the opening line to hand the identity back:

```ts
      const identity = await step('assert_guardian_account', BUDGET.guardianAccount, async () => {
```

and replace the closing four lines with:

```ts
          `the account's Guardian commitment against ${hosted.url}/pubkey`
        ).toBe(hosted.commitment);
        return hosted;
      });

      // The burn half comes last: Circle's Arc payouts have run hours late, and this order lets one redden the run only
      // after the deposit leg above passed and was reported.
      const where: StepContext = async () =>
        describePage(await walletA.evalJs<string>('return location.href;'), () =>
          walletA.evalJs<string>('return document.visibilityState;')
        );
      const onGuardian: StepContext = () => guardianFailureContext(identity);
      const faucetUrl = publicFaucetApiUrl(envConfig.name);
      if (!faucetUrl) throw new Error(`no public faucet for ${envConfig.name}`);

      // Before the grant, so a bridge that cannot pay this burn out costs no grant and leaves no deferred payout.
      const xreserve = await step('arc_state', BUDGET.arcState, async () => {
        const state = await readXReserveDomainState(arc);
        expect(
          { registered: state.registered, paused: state.paused, withdrawalsPaused: state.withdrawalsPaused },
          `xReserve domain ${USDCX_REMOTE_DOMAIN} read on ${arcHost(state.endpoint)}`
        ).toEqual({ registered: true, paused: false, withdrawalsPaused: false });
        return state;
      });

      const grant = await step('grant', BUDGET.grant, async () => {
        // R19: one grant from the 10 USDCx tier; asking for no amount gets the largest, 100 USDCx.
        const { noteId } = await mintFromPublicFaucet(faucetUrl, addressA, GRANT_UNITS);
        if (!isHex(noteId)) throw new Error(`the public faucet answered note id ${noteId}`);
        await waitForPublicNoteCommitment(envConfig.rpcUrl, noteId, 120_000);
        const asset = exactlyOne(
          (await note(envConfig.rpcUrl, noteId)).assets,
          'asset in the grant note',
          item => `${item.amount} of ${item.faucetHex}`
        );
        expect(asset.faucetHex.toLowerCase(), 'the grant is the native asset').toBe(
          (await accountHex(native.tokenId)).toLowerCase()
        );
        // An explicit tier is never asked again at a cap, so a faucet that dropped the tier fails here, named.
        expect(asset.amount, 'the faucet granted the tier it was asked for').toBe(GRANT_UNITS);
        return { noteId, units: asset.amount };
      });
      evidence.ids.grantNote = grant.noteId;

      const grantedVault = await step(
        'grant_consumed',
        BUDGET.grantConsumed,
        async () => {
          const claim = await pollUntil(
            'the wallet auto-consuming the grant',
            async () =>
              (await walletA.readTransactionRows({ type: 'consume' })).find(row =>
                noteIdsOf(row).includes(grant.noteId.toLowerCase())
              ),
            row => row?.status === TxStatus.Completed || row?.status === TxStatus.Failed,
            { timeoutMs: BUDGET.grantConsumed - VAULT_MS - 30_000, intervalMs: 3_000, describe: () => where() }
          );
          if (claim?.status !== TxStatus.Completed) {
            throw new Error(`the grant's consume failed: ${claim ? describeTransactionRow(claim) : 'no row'}`);
          }
          const settled = await settleLedger(walletA, native, {
            name: 'f0',
            before: depositVault,
            credit: grant.units,
            debits: 0n,
            row: claim
          });
          evidence.ids.grantConsume = claim.id;
          evidence.fees.push(settled.fee);
          return settled.vault;
        },
        onGuardian
      );

      evidence.settleMs.grant = await step(
        'settle_grant',
        BUDGET.settle,
        async () => {
          const started = Date.now();
          await pollUntil(
            'the grant consume committing',
            () => nullifier(envConfig.rpcUrl, grant.noteId),
            read => read.committed,
            { timeoutMs: BUDGET.settle - GUARDIAN_SETTLE_MS - 10_000, intervalMs: 3_000 }
          );
          await walletA.delay(GUARDIAN_SETTLE_MS);
          assertNoGuardianOpInFlight(await walletA.readTransactionRows(), addressA);
          return Date.now() - started;
        },
        onGuardian
      );

      // R20: the burn pays the deposit key back, so each run refills what its deposit leg spent. The leg reads the key
      // right before the burn, after the deposit's approve and deposit were mined, and its payout gate counts only what
      // this burn adds above that read (R21, R22); the label names the key Circle pays in every payout failure.
      const depositKey: PayoutKey = {
        key: { address: evmAddress, privateKey: `0x${evmPrivateKey.replace(/^0x/i, '')}` },
        role: 'deposit',
        label: `deposit key ${evmAddress} (USDCX_LIVE_EVM_PRIVATE_KEY), which Circle pays,`
      };
      const { key, snapshot, waitForPayout } = await payoutLeg(step, {
        takeKey: () => depositKey,
        arc,
        budget: BUDGET,
        evidence,
        secrets
      });

      const submission = await step(
        'burn_via_send',
        BUDGET.burnViaSend,
        signal =>
          walletA.burnUsdcxViaSendFlow({
            destAddress: key.address,
            amount: formatUnits(BURN_UNITS, USDCX_DECIMALS),
            nativeTokenId: native.tokenId,
            nativeSymbol: native.symbol,
            screenshotDir: path.join(steps.outputDir, 'usdcx-burn'),
            // R26: an overrun step never submits the burn after its test failed.
            signal
          }),
        onGuardian
      );
      evidence.ids.burnRow = submission.rowId;
      evidence.notes.push(
        `review ${submission.reviewRoute}`,
        `generating ${submission.generatingRoute}`,
        `chips pressed before the Arc click: ${submission.defaultPressed.join(', ') || 'none'}`
      );

      const burned = await step(
        'burn_completed',
        BUDGET.burnCompleted,
        async () => {
          const { row, stages } = await walletA.waitForBurnCompleted(submission.rowId, BUDGET.burnCompleted - 15_000);
          const usdcxBurn = row.extraInputs?.usdcxBurn;
          const burnNoteId = usdcxBurn?.noteId ?? '';
          if (!isHex(burnNoteId)) {
            throw new Error(`burn row ${row.id} names no burn note: ${JSON.stringify(row.extraInputs)}`);
          }
          expect(
            {
              provider: row.extraInputs?.provider,
              to: row.extraInputs?.destinationAddress?.toLowerCase(),
              chain: row.extraInputs?.destinationNetwork,
              domain: usdcxBurn?.destinationDomain,
              before: usdcxBurn?.destinationBalanceBefore?.balance
            },
            // Anything that paid into or spent from the key between the two reads breaks the payout's delta.
            `burn row ${row.id}; the leg read ${snapshot.balance} on the key at Arc block ${snapshot.blockNumber} ` +
              'right before the burn'
          ).toEqual({
            provider: 'usdcx',
            to: key.address.toLowerCase(),
            chain: ARC_CHAIN_ID,
            domain: ARC_CIRCLE_DOMAIN,
            // The wallet's own snapshot of the key must be the one the payout gate counts from.
            before: snapshot.balance.toString()
          });
          evidence.notes.push(`burn stages ${JSON.stringify(stages)}`);
          return { row, burnNoteId, arcFromBlock: BigInt(usdcxBurn?.destinationBalanceBefore?.blockNumber ?? '0') };
        },
        onGuardian
      );
      evidence.ids.burnNote = burned.burnNoteId;
      evidence.hashes.burnTransaction = burned.row.transactionId ?? 'none';

      const consumed = await step(
        'burn_consumed',
        BUDGET.burnConsumed,
        async () => {
          // The wallet's watcher moves the phase only while a wallet page is visible, so the run waits on Home.
          await walletA.navigateHome();
          const phases = new PhaseTimeline('burn row', BURN_PHASES);
          await pollUntil(
            'the faucet consuming the burn note',
            async () => {
              const rows = await walletA.readBridgedSendRows();
              const phase = rows.find(row => row.id === burned.row.id)?.extraInputs?.usdcxBurn?.phase;
              phases.record(phase, Date.now());
              if (phase === 'discarded') throw new Error(`the node discarded burn note ${burned.burnNoteId}`);
              return phase;
            },
            phase => phase === 'confirmed',
            { timeoutMs: BUDGET.burnConsumed - VAULT_MS - 60_000, intervalMs: 3_000, describe: () => where() }
          );
          phases.assertMonotone();
          evidence.phases.burn = phases.samples();
          const oracle = await burnEvidence(envConfig.rpcUrl, {
            faucetBech32: native.tokenId,
            noteId: burned.burnNoteId,
            senderBech32: addressA,
            domain: ARC_CIRCLE_DOMAIN,
            recipient: key.address,
            amount: BURN_UNITS
          });
          // A missing fee_schedule entry would read as a zero sponsorship and hide inside a bounded fee.
          if (oracle.sponsorshipUnits <= 0n) {
            throw new Error(`the faucet's fee_schedule names no sponsorship for burn root ${oracle.scriptRoot}`);
          }
          const completion = burnCompletionPath(burned.row);
          if (completion.kind === 'result') {
            const outputs = await burnOutputs({
              resultBytesBase64: completion.resultBytes,
              burnNoteId: burned.burnNoteId,
              faucetBech32: native.tokenId
            });
            const read = ledgerLine([
              ['N', outputs.burn.amount],
              ['s', outputs.sponsorship.amount],
              ['f1', outputs.fee.amount]
            ]);
            const want = ledgerLine([
              ['N', BURN_UNITS],
              ['s', oracle.sponsorshipUnits],
              ['f1', BigInt(burned.row.feeAmount ?? '-1')]
            ]);
            if (read !== want) throw new Error(`the burn's outputs by role read ${read}, expected ${want}`);
          }
          // Only the local completion path lists the burn note; a landed one rests on the oracle above (R24).
          const unlisted = burnOutputNoteProblem(completion, burned.row, burned.burnNoteId);
          if (unlisted !== undefined) throw new Error(unlisted);
          const settled = await settleLedger(walletA, native, {
            name: 'f1',
            before: grantedVault,
            credit: 0n,
            debits: BURN_UNITS + oracle.sponsorshipUnits,
            row: burned.row
          });
          evidence.fees.push(settled.fee, { name: 's', amount: oracle.sponsorshipUnits, kind: 'exact' });
          evidence.notes.push(
            `burn ledger ${ledgerLine([
              ['V1', grantedVault],
              ['N', BURN_UNITS],
              ['s', oracle.sponsorshipUnits],
              [settled.fee.name, settled.fee.amount],
              ['V2', settled.vault]
            ])}`
          );
          return oracle;
        },
        onGuardian
      );

      const consumeTsMs = consumed.consumeTimestampSec * 1_000;
      // D3 in delta mode, a hard gate (the leg's payout step): exactly one AttestationUsed log whose gatewayMint
      // carries the burn note id, by the consume plus 10 min, that adds exactly its value to the key's balance above
      // the snapshot.
      const payout = await waitForPayout({ burnNoteId: burned.burnNoteId, oracle: consumed }, xreserve.depositor);

      // Q6, a hard gate: the wallet's own destination check confirms the payout Circle made.
      const confirmedAt = await step('wallet_confirms_payout', BUDGET.walletConfirmed, async () => {
        await walletA.navigateHome();
        const row = await pollUntil(
          'the wallet confirming the payout',
          async () => (await walletA.readBridgedSendRows()).find(candidate => candidate.id === burned.row.id),
          found => found?.extraInputs?.usdcxBurn?.destinationBalanceConfirmed !== undefined,
          {
            timeoutMs: WALLET_CONFIRM_TIMEOUT_MS,
            intervalMs: 3_000,
            describe: async last => {
              const keyNow = await readArcUsdc(key.address, arc).then(String, errorText);
              const arcIo = await readArcUsdc(key.address, { endpoints: [ARC_PUBLIC_URL] }).then(
                balance => `arc.io reads ${balance}`,
                (error: unknown) => `arc.io failed: ${errorText(error)}`
              );
              return (
                `Circle paid this burn (harness proof) but the wallet never confirmed it; destinationBalanceBefore ` +
                `${JSON.stringify(last?.extraInputs?.usdcxBurn?.destinationBalanceBefore)}, key balance now ` +
                `${keyNow}, ${arcIo}; ${await where()}`
              );
            }
          }
        );
        const at = Date.now();
        const confirmed = row?.extraInputs?.usdcxBurn?.destinationBalanceConfirmed;
        const block = BigInt(confirmed?.blockNumber ?? '0');
        expect(
          {
            balance: confirmed?.balance,
            afterSnapshot: block > burned.arcFromBlock,
            atOrAfterPayout: block >= payout.logBlock
          },
          `confirmation at Arc block ${block}, snapshot ${burned.arcFromBlock}, payout log ${payout.logBlock}, ` +
            `${snapshot.balance} on the key before the burn`
        ).toEqual({ balance: payout.balance.toString(), afterSnapshot: true, atOrAfterPayout: true });
        evidence.ids.walletConfirmedBalance = String(confirmed?.balance);
        await walletA.openTransactionDetails(burned.row.id);
        const pills: string[] = [];
        await pollUntil(
          'the History pill reading Confirmed',
          async () => {
            const { pill } = await walletA.transactionDetailsView(burned.row.id);
            if (pill !== null && pills[pills.length - 1] !== pill) pills.push(pill);
            return pill;
          },
          pill => pill === enText('confirmed'),
          { timeoutMs: 30_000, intervalMs: 1_000 }
        );
        evidence.notes.push(`history pill ${pills.join(' then ')}`);
        // The receiving-tx link is a best-effort RPC match (CLAUDE.md), so only a link to another transaction fails.
        const linkDeadline = Date.now() + RECEIVING_TX_LINK_MS;
        let links = (await walletA.transactionDetailsView(burned.row.id)).arcTxLinks;
        while (links.length === 0 && Date.now() < linkDeadline) {
          await walletA.delay(1_000);
          links = (await walletA.transactionDetailsView(burned.row.id)).arcTxLinks;
        }
        expect(
          links.filter(href => !href.toLowerCase().endsWith(`/tx/${payout.transactionHash.toLowerCase()}`)),
          'receiving-tx links that name another transaction'
        ).toEqual([]);
        evidence.notes.push(
          links.length === 0
            ? 'receiving-tx link did not render within 15 s'
            : 'receiving-tx link is the AttestationUsed transaction'
        );
        await walletA.navigateHome();
        return at;
      });
      evidence.latenciesMs.payoutToWalletConfirmation = confirmedAt - (consumeTsMs + payout.latencyMs);
    } finally {
```

The leg's `payout` step itself checks the payout's domain and that its value plus fee is the whole burn, and records `hashes.payout`, the `circle payout fee` and `latenciesMs.consumeToPayout`.

- [ ] **Step 12: Re-derive the config timeout and fix its stale comment**

In `playwright.ios.usdcx-live.config.ts` replace lines 5-20:

```ts
// Same harness as the iOS E2E config, but runs ONLY the live USDCx bridge-in spec
// (which the base iOS config ignores). The spec deposits real Arc Testnet USDC
// through Circle xReserve and runs a local deposit relayer, so it needs a funded
// EVM key and a funded relayer account that the standard mobile suite does not
// have. It runs in the dedicated USDCx live E2E job. Run with:
// yarn test:e2e:mobile:usdcx-live:run.
//
// The app must be built WITHOUT E2E_EVM_RPC_URL: that flag sends the Arc reads to
// a local Anvil, and this suite needs the real Arc Testnet RPC.
export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: '**/usdcx-live-*.ios.spec.ts',
  // Circle's attestation and the faucet's network transaction set the pace, not the wallet.
  timeout: 3_600_000
});
```

with:

```ts
// Same harness as the iOS E2E config, but runs ONLY the live USDCx spec (which the base
// iOS config ignores). The spec deposits real Arc Testnet USDC through Circle xReserve
// from a funded key (USDCX_LIVE_EVM_PRIVATE_KEY), then burns public faucet USDCx
// through Send back to that key and waits for Circle's payout. It runs in the
// dedicated USDCx live E2E job. Run with: yarn test:e2e:mobile:usdcx-live:run.
//
// The app must be built WITHOUT E2E_EVM_RPC_URL: that flag sends the Arc reads to
// a local Anvil, and this suite needs the real Arc Testnet RPC.
export default defineConfig({
  ...base,
  testIgnore: undefined,
  testMatch: '**/usdcx-live-*.ios.spec.ts',
  // The worst passing run: the 13 min simulator setup cap, Circle's attestation and the relayer's mint at their 20
  // and 15 min caps, the deposit leg's other steps at 5x their CI time (3 min), its new steps at their budgets
  // (6 min) and every burn step at its budget (44.5 min, the payout's 10 min from the consume included): about
  // 102 min, rounded up. With the job's ~21 min of setup and build it fits the nightly's 150 min ceiling.
  timeout: 6_300_000
});
```

- [ ] **Step 13: Run the guards to see them pass, and prove the spec compiles and lists**

```bash
cd /Users/celrisen/miden/wt-usdcx-ios-burn-b
npx prettier --write playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts playwright/e2e/harness/usdcx-live-spec.test.ts playwright.ios.usdcx-live.config.ts
yarn jest playwright/e2e/harness --maxWorkers=2 2>&1 | grep -E '^(Tests|Test Suites):'
npx eslint --max-warnings 0 playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts playwright/e2e/harness/usdcx-live-spec.test.ts playwright.ios.usdcx-live.config.ts; echo "eslint exit $?"
npx playwright test --config playwright.ios.usdcx-live.config.ts --list 2>&1 | tail -2
yarn lint:e2e; echo "lint:e2e exit $?"
```

Expected: the harness directory with `0 failed` (the new file `5 passed`; `usdcx-live-workflow.test.ts` and `linked-pr-injection.test.ts` unchanged and green), `eslint exit 0`, `Total: 1 test in 1 file`, `lint:e2e exit 0`. The type check runs once, in Delivery Step 1.

- [ ] **Step 14: Commit the burn half**

```bash
cd /Users/celrisen/miden/wt-usdcx-ios-burn-b
git add playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts playwright/e2e/harness/usdcx-live-spec.test.ts playwright.ios.usdcx-live.config.ts
git status --short
git commit -m "test(e2e): live iOS USDCx spec burns back to its deposit key and gates on Circle's payout and the wallet's confirmation"
```

Expected: exactly the three paths staged; one commit, no trailer.

---

### Task 3: The nightly's header and R25's key scoping, the stale iOS config comment, the docs and the CHANGELOG

**Files:**
- Modify: `.github/workflows/e2e-usdcx-live.yml:3-6`, `:18-19` (header comment), `:68-71` (job `env`), `:83-84` (the key-check step), `:264-266` (the test step)
- Test: `playwright/e2e/harness/usdcx-live-workflow.test.ts:17-19` (append one test)
- Modify: `playwright.ios.config.ts:18-19`
- Modify: `playwright/e2e/docs/e2e-architecture.md` (the end of section 8, before the `---` that closes it)
- Modify: `CHANGELOG.md` (one line)

**Interfaces:**
- Consumes: the guards that pin the workflow: `playwright/e2e/harness/usdcx-live-workflow.test.ts:11-18` (the key-check step, its place before checkout, its `exit 1`) and `linked-pr-injection.test.ts:355` (150/235); `scripts/check-changelog.sh`.
- Produces: no code.

- [ ] **Step 1: Run the workflow guards before the edit**

Run: `yarn jest playwright/e2e/harness/usdcx-live-workflow.test.ts playwright/e2e/harness/linked-pr-injection.test.ts --maxWorkers=2 2>&1 | grep -E '^(Tests|Test Suites):'`
Expected: `0 failed`; record the totals (`linked-pr-injection.test.ts`'s must not change, and `usdcx-live-workflow.test.ts` gains one test).

- [ ] **Step 2: Write the failing R25 guard**

In `playwright/e2e/harness/usdcx-live-workflow.test.ts` the anchor is lines 17-19:

```ts
    expect(body).toMatch(/if \[ -z "\$USDCX_LIVE_EVM_PRIVATE_KEY" \]; then[\s\S]*::error[\s\S]*exit 1/);
  });
});
```

Replace it with:

```ts
    expect(body).toMatch(/if \[ -z "\$USDCX_LIVE_EVM_PRIVATE_KEY" \]; then[\s\S]*::error[\s\S]*exit 1/);
  });

  // R25: the CLI build, the dependency install and the app build run code this repository does not own.
  it('hands the live Arc Testnet key only to the key check and the test step', () => {
    const jobEnv = workflow.slice(workflow.indexOf('\n    env:\n'), workflow.indexOf('\n    steps:\n'));
    expect(jobEnv).not.toContain('secrets.USDCX_LIVE_EVM_PRIVATE_KEY');
    const holders = workflow
      .slice(workflow.indexOf('\n    steps:\n'))
      .split(/\n(?= {6}- )/)
      .filter(block => block.includes('secrets.USDCX_LIVE_EVM_PRIVATE_KEY'))
      .map(block => /- name: (.+)/.exec(block)?.[1]);
    expect(holders).toEqual(['Require the live Arc Testnet key', 'Run USDCx bridge-IN E2E (mobile, live testnets)']);
  });
});
```

Run: `yarn jest playwright/e2e/harness/usdcx-live-workflow.test.ts --maxWorkers=2 2>&1 | grep -E '^Tests:'`
Expected: `Tests: 1 failed, 1 passed, 2 total` (the job's `env` still holds the secret).

- [ ] **Step 3: The workflow header and R25's scoping**

In `.github/workflows/e2e-usdcx-live.yml` replace lines 3-6:

```yaml
# Runs the USDCx bridge-IN deposit E2E (Arc Testnet -> Miden testnet) against the
# LIVE networks. Nothing on the path is a double: the deposit goes to Circle's real
# xReserve contract, Circle's attestation service signs it, and the deposit relayer
# submits the mint note to the USDCx faucet. The wallet then claims the minted note.
```

with:

```yaml
# Runs the live USDCx E2E on iOS against the LIVE networks (Arc Testnet and Miden
# testnet), one test with two legs. Nothing on the path is a double.
#   1. Bridge-IN: the deposit goes to Circle's real xReserve contract, Circle's
#      attestation service signs it, the deposit relayer submits the mint note to
#      the USDCx faucet, and the Guardian wallet claims the minted note.
#   2. Burn, only once the deposit leg passed: the same wallet takes USDCx from the
#      public faucet and burns 1 USDCx through Send back to the deposit key's Arc
#      address. The run fails unless Circle pays that key within 10 minutes of the
#      faucet consuming the burn and the wallet's own History then reads Confirmed.
#      The payout, about 0.98 USDC, refills what the deposit and its gas spent, so
#      the key funds itself.
```

Replace lines 18-19:

```yaml
# It spends real Arc Testnet USDC on each run, and it depends on Circle's service
# and the relayer, so it is a nightly and on-demand signal, never a per-PR gate.
```

with:

```yaml
# It spends real Arc Testnet USDC and public faucet USDCx on each run, and it depends
# on Circle's service, the relayer and the faucet, so it is a nightly and on-demand
# signal, never a per-PR gate.
```

Replace lines 68-71 (the job's `env`):

```yaml
      E2E_NETWORK: testnet
      # NO E2E_EVM_RPC_URL here: that flag sends the wallet's Arc reads to a local
      # Anvil, and this job needs the real Arc Testnet RPC.
      USDCX_LIVE_EVM_PRIVATE_KEY: ${{ secrets.USDCX_LIVE_EVM_PRIVATE_KEY }}
```

with:

```yaml
      E2E_NETWORK: testnet
      # NO E2E_EVM_RPC_URL here: that flag sends the wallet's Arc reads to a local
      # Anvil, and this job needs the real Arc Testnet RPC.
      # The Arc key is not set here: only the key check and the test step get it,
      # so the CLI build, the dependency install and the app build never see it.
```

Replace lines 83-84 (the key-check step's opening):

```yaml
      - name: Require the live Arc Testnet key
        run: |
```

with:

```yaml
      - name: Require the live Arc Testnet key
        env:
          USDCX_LIVE_EVM_PRIVATE_KEY: ${{ secrets.USDCX_LIVE_EVM_PRIVATE_KEY }}
        run: |
```

Replace lines 264-266 (the test step):

```yaml
      - name: Run USDCx bridge-IN E2E (mobile, live testnets)
        # NO retries: a retry sends a second real deposit. A failed run is read, not repeated.
        run: yarn test:e2e:mobile:usdcx-live:run
```

with:

```yaml
      - name: Run USDCx bridge-IN E2E (mobile, live testnets)
        # NO retries: a retry sends a second real deposit and burn. A failed run is read, not repeated.
        env:
          USDCX_LIVE_EVM_PRIVATE_KEY: ${{ secrets.USDCX_LIVE_EVM_PRIVATE_KEY }}
        run: yarn test:e2e:mobile:usdcx-live:run
```

```bash
cd /Users/celrisen/miden/wt-usdcx-ios-burn-b
git diff -U0 .github/workflows/e2e-usdcx-live.yml | grep -E '^[+-]' | grep -vE '^(\+\+\+|---)' | grep -vE '^[+-] *#'; echo "non-comment changed lines above"
grep -c 'secrets.USDCX_LIVE_EVM_PRIVATE_KEY' .github/workflows/e2e-usdcx-live.yml
yarn jest playwright/e2e/harness/usdcx-live-workflow.test.ts playwright/e2e/harness/linked-pr-injection.test.ts --maxWorkers=2 2>&1 | grep -E '^(Tests|Test Suites):'
```

Expected: exactly these five non-comment changed lines before `non-comment changed lines above`, in this order:

```
-      USDCX_LIVE_EVM_PRIVATE_KEY: ${{ secrets.USDCX_LIVE_EVM_PRIVATE_KEY }}
+        env:
+          USDCX_LIVE_EVM_PRIVATE_KEY: ${{ secrets.USDCX_LIVE_EVM_PRIVATE_KEY }}
+        env:
+          USDCX_LIVE_EVM_PRIVATE_KEY: ${{ secrets.USDCX_LIVE_EVM_PRIVATE_KEY }}
```

then `3` (the header comment's `#   secrets.USDCX_LIVE_EVM_PRIVATE_KEY` line and the two steps' `env`), and `0 failed` with the guard file at `2 passed` and `linked-pr-injection.test.ts`'s total unchanged from Step 1.

- [ ] **Step 4: The stale comment in the base iOS config**

Line 18 of `playwright.ios.config.ts` holds a dash character this plan cannot reproduce, so the replacement goes by line number after checking both lines' prefixes:

```bash
cd /Users/celrisen/miden/wt-usdcx-ios-burn-b
python3 - <<'PY'
p = 'playwright.ios.config.ts'
lines = open(p).read().split('\n')
assert lines[17].startswith('  // The live USDCx spec runs via playwright.ios.usdcx-live.config.ts'), lines[17]
assert lines[18] == '  // Arc Testnet USDC and needs a local deposit relayer.', lines[18]
lines[17:19] = [
    '  // The live USDCx spec runs via playwright.ios.usdcx-live.config.ts: it spends real',
    '  // Arc Testnet USDC and public faucet USDCx in its own nightly job.',
]
open(p, 'w').write('\n'.join(lines))
print('replaced lines 18-19')
PY
git diff --stat playwright.ios.config.ts
```

Expected: `replaced lines 18-19` and `1 file changed, 2 insertions(+), 2 deletions(-)`.

- [ ] **Step 5: The docs subsection on the iOS nightly's key**

PR 1b's section 8 ends with its `### The harness Arc key` subsection, so this inserts at the end of section 8, before the `---` that closes it, whatever its last paragraph now says:

```bash
cd /Users/celrisen/miden/wt-usdcx-ios-burn-b
python3 - <<'PY'
p = 'playwright/e2e/docs/e2e-architecture.md'
text = open(p).read()
assert text.count('\n## 8 ') == 1, text.count('\n## 8 ')
start = text.index('\n## 8 ')
end = text.index('\n---\n', start)
section = (
    "### The iOS nightly's key\n\n"
    '`e2e-usdcx-live.yml` runs `playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts` every night on one Guardian '
    'wallet: the secret-funded key `USDCX_LIVE_EVM_PRIVATE_KEY` deposits 0.01 USDC in, and then the wallet burns 1 USDCx '
    "from a public faucet grant back to that key's own Arc address. Circle's payout of about 0.98 USDC more than "
    'refills the deposit and its gas (about 0.015 USDC), so the key needs no top-up, and the payout gate counts only '
    'what the burn added to its balance since a read taken right before the burn. A late payout from an earlier night, '
    'or any other transfer into or out of the key during a run, fails that gate, and the message says why. The workflow '
    'hands the key only to its key check and its test step, never to the dependency install or the builds.\n\n'
    'Run the spec locally with `USDCX_LIVE_EVM_PRIVATE_KEY` set to the harness key while holding '
    "`~/.miden-e2e/usdcx-run.lock`, never with the nightly's key: a local run cannot see a nightly, and two payouts "
    'into one key fail the gate.\n'
)
open(p, 'w').write(text[:end] + '\n' + section + text[end:])
print('inserted the iOS nightly subsection before line', text[:end].count('\n') + 2)
PY
git diff --stat playwright/e2e/docs/e2e-architecture.md
sed -n "/^### The iOS nightly's key/,/^---$/p" playwright/e2e/docs/e2e-architecture.md
```

Expected: `inserted the iOS nightly subsection before line <n>`, `1 file changed, 6 insertions(+)`, and the subsection printed directly above section 8's closing `---` with one blank line on each side. An assertion error means section 8's heading moved: find it with `grep -n '^## ' playwright/e2e/docs/e2e-architecture.md`, then stop and report.

- [ ] **Step 6: The CHANGELOG line**

```bash
cd /Users/celrisen/miden/wt-usdcx-ios-burn-b
git fetch --tags
LATEST=$(git tag --list 'v*' --sort=-v:refname | grep -v -e '-rc' | head -1); echo "latest release $LATEST"
python3 - "$LATEST" <<'PY'
import re, sys
latest = tuple(int(x) for x in sys.argv[1].lstrip('v').split('.'))
p = 'CHANGELOG.md'
lines = open(p).read().split('\n')
heading = re.compile(r'^## (\d+)\.(\d+)\.(\d+) \(TBD\)$')
target = next(i for i, l in enumerate(lines) if (m := heading.match(l)) and tuple(map(int, m.groups())) > latest)
end = next((i for i in range(target + 1, len(lines)) if lines[i].startswith('## ')), len(lines))
changes = next(i for i in range(target, end) if lines[i] == '### Changes')
assert lines[changes + 1] == '', repr(lines[changes + 1])
entry = (
    "- [CHANGE][ci] The live iOS USDCx E2E (`e2e-usdcx-live.yml`) also burns USDCx: after its deposit leg the "
    "Guardian wallet takes a public faucet grant and burns 1 USDCx through Send, with the Arc Testnet chip, back to "
    "the deposit key, whose payout refills what the deposit spent, and the run fails unless Circle pays that key within "
    "10 minutes of the faucet consuming the burn and the wallet's own History then reads Confirmed; the deposit leg "
    "now also checks the recipient, maxFee and hookData the wallet signed, the deposit row's recipient and phase "
    "order, the exact USDCx balance after the claim's fee, the account's Guardian commitment against the hosted "
    "Guardian's and that the wallet will claim the deposit unattended, and the workflow hands its Arc key only to its "
    "key check and its test step."
)
lines.insert(changes + 2, entry)
open(p, 'w').write('\n'.join(lines))
print('inserted under', lines[target], 'at line', changes + 3)
PY
BASE_REF=main NO_CHANGELOG_LABEL=false bash scripts/check-changelog.sh; echo "changelog exit $?"
```

Expected: `latest release v1.17.1` (or newer), `inserted under ## 1.17.2 (TBD) at line <n>` (or the highest `(TBD)` section above a newer tag), `changelog exit 0`. A `StopIteration` means that section has no `### Changes` heading yet: add `### Changes` and a blank line at the end of the section, then re-run the snippet.

- [ ] **Step 7: The guards after the edit**

Run: `yarn jest playwright/e2e/harness --maxWorkers=2 2>&1 | grep -E '^(Tests|Test Suites):'`
Expected: `0 failed`; `linked-pr-injection.test.ts`'s total as in Step 1, `usdcx-live-workflow.test.ts` at 2, and `usdcx-live-spec.test.ts` at 5.

- [ ] **Step 8: Commit**

```bash
cd /Users/celrisen/miden/wt-usdcx-ios-burn-b
git add .github/workflows/e2e-usdcx-live.yml playwright/e2e/harness/usdcx-live-workflow.test.ts playwright.ios.config.ts playwright/e2e/docs/e2e-architecture.md CHANGELOG.md
git status --short
git commit -m "docs(e2e): live iOS USDCx round trip, its Arc key scoped to two steps, and changelog"
git log --format=%s origin/main..HEAD
```

Expected: the five paths staged; the log shows the four subjects of Task 1, Task 2 (two) and Task 3, newest first.

---

## Delivery

Every command runs from `/Users/celrisen/miden/wt-usdcx-ios-burn-b` with `export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"`.

- [ ] **Step 1: Local gates (only what CI does not run for us, plus the type check once)**

```bash
yarn jest playwright/e2e/ios/helpers playwright/e2e/harness playwright/e2e/helpers --maxWorkers=2 2>&1 | grep -E '^(Tests|Test Suites):'
git diff --name-only -z --diff-filter=ACMR origin/main...HEAD -- '*.ts' | xargs -0 npx prettier --check
git diff --name-only -z --diff-filter=ACMR origin/main...HEAD -- '*.ts' | xargs -0 npx eslint --max-warnings 0; echo "eslint exit $?"
yarn lint:e2e; echo "lint:e2e exit $?"
yarn ts; echo "ts exit $?"
BASE_REF=main NO_CHANGELOG_LABEL=false bash scripts/check-changelog.sh; echo "changelog exit $?"
printf 'a\xe2\x80\x94b\n' | perl -ne 'print "control hit\n" if /\xe2\x80[\x93\x94]/'
git diff -U0 origin/main...HEAD | grep '^+' | perl -ne 'print "DASH: $_" if /\xe2\x80[\x93\x94]/'
git log --format=%B origin/main..HEAD | perl -ne 'print "DASH: $_" if /\xe2\x80[\x93\x94]/'
git log --format=%B origin/main..HEAD | grep -ci -e 'co-authored' -e 'generated with' -e 'claude' -e 'cursor' -e 'codex'
git diff -U0 origin/main...HEAD | grep '^+' | grep -nE 'burns? 10 USDCx|9\.98|9\.9 USDC|fresh (per-run )?Arc key|stranded|strands its'
```

Expected: both jest lines `0 failed` (the baseline totals plus 7 tests); `All matched files use Prettier code style!`; `eslint exit 0`; `lint:e2e exit 0`; `ts exit 0` (tsconfig.json includes `playwright/**/*.ts` and `playwright*.config.ts` with `noUnusedLocals` and `noUncheckedIndexedAccess`); `changelog exit 0`; exactly one `control hit` and no `DASH:` line; `0`; nothing from the last grep (R19's amounts and R20's destination everywhere). A `ts` error is fixed in a new commit, never by `as` or `any`.

- [ ] **Step 2: Mutation checks**

Each mutation backs the file up, mutates it, asserts the mutation applied (`! cmp -s`, a silent no-op proves nothing), runs the suite and restores, all in one command. Write the prediction down before each run, then record predicted against observed. A mutation that fails no test means the test is inert: fix the test, in a new commit, before review.

```bash
mut() { cp "$1" "$1.mutbak" && perl -0pi -e "$2" "$1" && ! cmp -s "$1" "$1.mutbak" && { yarn jest "$3" --maxWorkers=2 2>&1 | grep -E '^Tests:|●'; }; mv "$1.mutbak" "$1"; }
S=playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts; G=playwright/e2e/harness/usdcx-live-spec.test.ts
L=playwright/e2e/helpers/usdcx-legs.ts; A=playwright/e2e/helpers/arc-usdcx.test.ts
W=.github/workflows/e2e-usdcx-live.yml; WT=playwright/e2e/harness/usdcx-live-workflow.test.ts
mut $S "s/maxFee: 0n, hookData: '0x' \}/maxFee, hookData }/" $G
mut $S 's/if \(!isWorthClaiming\(depositUnits, read\.baseFee\)\)/if (false)/' $G
mut $S 's/read on \$\{arcHost\(state\.endpoint\)\}/read on \$\{state.endpoint\}/' $G
mut $S 's/before: snapshot\.balance\.toString\(\)/before: usdcxBurn?.destinationBalanceBefore?.balance/' $G
mut $S 's/const payout = await waitForPayout\(/const payout = await waitForPayoutLater(/' $G
mut $L 's/\$\{label\} held \$\{snapshot\.balance\}/harness key held \$\{snapshot.balance\}/' $A
mut $L 's/evidence\.ids\.arcKeyRole = taken\.role;/evidence.ids.arcKeyRole = "harness";/' $A
mut $W 's/(      E2E_NETWORK: testnet\n)/$1      USDCX_LIVE_EVM_PRIVATE_KEY: \$\{\{ secrets.USDCX_LIVE_EVM_PRIVATE_KEY \}\}\n/' $WT
git status --short | grep -c mutbak
```

| # | Mutation | Predicted failing test(s) |
|---|---|---|
| 1 | the deposit's maxFee and hookData go unchecked | `checks what the counterparty signed and the row's recipient before it waits on Circle` |
| 2 | the claim floor is never checked | `refuses a deposit the wallet would leave unclaimed before it pairs the counterparty` |
| 3 | the preflight names the whole endpoint URL | `names Arc endpoints by host and writes the evidence only through its refusal of secrets` |
| 4 | the wallet's saved balance is checked against itself | `burns back to the deposit key and holds the wallet to the snapshot the payout gate counts from` |
| 5 | the payout gate is not awaited where the order guard looks | `burns only after the deposit leg and gates on the payout before the wallet confirmation` |
| 6 | the payout failure drops the key's label | `takes any key the run names, records its role and names it by its label when Circle has not paid` and `fails the payout step at the consume's deadline, naming the key's pre-burn read by host` |
| 7 | every key is recorded as the harness key | `takes any key the run names, records its role and names it by its label when Circle has not paid` |
| 8 | the Arc key goes back to the job's env | `hands the live Arc Testnet key only to the key check and the test step` |

Expected: each run prints one `Tests:` line with `1 failed` (2 for row 6) and one `●` line per predicted title (Jest prints no per-test lines in this shell, only the failure headers `● <describe> › <title>`); the last line prints `0`.

- [ ] **Step 3: Internal whole-branch review**

A fresh reviewer on the most capable model reviews `git diff $(git merge-base origin/main HEAD)...HEAD` (no review-council). Give it this plan's Global Constraints and Review Focus, and ask specifically about: the order of the spec (burn half after the deposit leg, the Guardian identity read only after it, `arc_state` before the grant, the payout gate before the wallet confirmation); the burn back to the deposit key in R20's delta mode (the leg's snapshot right before the burn, the row's saved balance against it, the confirmation reading `payout.balance`); `payoutLeg` leaving `harnessPayoutLeg`'s behaviour, step names, evidence and failure text unchanged for the extension specs; every long poll's tolerance of one failed CDP read; every path by which the Arc private key or the onboarding password could reach `cdp.eval`, a log, a screenshot name, an environment of a build step or the evidence; every Arc endpoint named by host only; the deposit leg's outcome being unchanged apart from the added checks; R25's scoping against every step that reads the key; and the config timeout arithmetic against the workflow's 150 minute schedule ceiling. Fix each actionable P0-P2 finding with its own new commit (never amend), re-run that file's suite and every test file in its directory, and give each fix a scoped re-review. P3 findings are neither fixed nor filed.

- [ ] **Step 4: One local live run of the extended spec on testnet**

Build the testnet E2E app in this worktree and verify it:

```bash
unset E2E_EVM_RPC_URL MIDEN_REMOTE_CONFIG_URL
BUILD_LOG=$(mktemp -t usdcx-ios-build)
E2E_NETWORK=testnet yarn test:e2e:mobile:build > "$BUILD_LOG" 2>&1; echo "build exit $?"
grep -c 'error:' "$BUILD_LOG"; grep -c '\*\* BUILD SUCCEEDED \*\*' "$BUILD_LOG"
test -d ios/App/build/Build/Products/Debug-iphonesimulator/App.app && echo app-ok
```

Expected: `build exit 0`, `0` error lines, `1` success line, `app-ok` (about 2 min on this machine, spike section 1).

The two-simulator fixture resolves the pinned CLI before every test and builds it with cargo when it is missing (`resolveCliPath`, miden-cli.ts:116, through `scripts/install-pinned-miden-cli.cjs`). Install it now, while no key is in any environment, so the run itself builds nothing with the key in its environment:

```bash
env -u USDCX_LIVE_EVM_PRIVATE_KEY -u E2E_ARC_PRIVATE_KEY node scripts/install-pinned-miden-cli.cjs install | tail -1
```

Expected: one path to a `miden-client` binary (a cold cache builds for up to 35 min, once).

Give the run a dedicated simulator pair. The fixture's recovery runs `xcrun simctl shutdown all` on a setup hang, so check first:

```bash
xcrun simctl list devices booted
```

If any device is `Booted`, stop and ask before going on (another session's simulators would be shut down by a hang). Otherwise:

```bash
RUNTIME=$(xcrun simctl list runtimes -j | node -e 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")).runtimes.filter(x=>x.isAvailable&&x.platform==="iOS").pop();process.stdout.write(r.identifier)')
A=$(xcrun simctl create usdcx-burn-A com.apple.CoreSimulator.SimDeviceType.iPhone-17 "$RUNTIME")
B=$(xcrun simctl create usdcx-burn-B com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro "$RUNTIME")
mkdir -p test-results-ios && printf '{"udidA":"%s","udidB":"%s"}\n' "$A" "$B" > test-results-ios/.device-pair.json
```

Expected: two UDIDs written. Simulator.app need not be opened: CDP attached headless in every spike run.

The run's key is the harness key (`HARNESS_ARC_KEY_FILE`, role `harness`), never the CI key `~/arc_testnet_usdcx_ci_key.txt`: the nightly owns that one, and a local run can neither see a nightly in flight nor stop two payouts landing on one key. The spec burns back to whichever key deposits, so the harness key gets its payout back. The blocks below share `HARNESS`, `LOCK`, `RUN_LOG`, `A` and `B`: run them in one shell, or set those again at the top of each later block.

```bash
HARNESS="$HOME/.miden-e2e/arc-keys/harness.json"; LOCK="$HOME/.miden-e2e/usdcx-run.lock"
stat -f '%Lp %N' "$HARNESS" "$(dirname "$HARNESS")"
node -e 'const k = require(process.argv[1]); process.exit(k.role === "harness" && /^0x[0-9a-fA-F]{64}$/.test(k.privateKey) ? 0 : 1)' "$HARNESS" && echo harness-key-ok
test -e "$LOCK" && echo "LOCK HELD: $(cat "$LOCK")" || echo lock-free
```

Expected: `600` for the key file and `700` for its directory, `harness-key-ok` (the key itself is never printed) and `lock-free`. A held lock means a usdcx suite is running against the harness key: stop and ask. Then the run, which takes the lock in the same command in the runner's own format (`{ pid, suite, startedAt }`, scripts/e2e-real.mjs `acquireUsdcxRunLock`, so a `yarn e2e:real` usdcx run refuses while this shell is alive) and releases it after. The key goes from the key file into the environment of the one command, never onto the screen or a command line, and appium's debug output goes to the log file:

```bash
RUN_LOG=$(mktemp -t usdcx-ios-run); echo "$RUN_LOG"
if (set -C; printf '{"pid":%s,"suite":"ios usdcx-live (local)","startedAt":"%s"}\n' "$$" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$LOCK") 2>/dev/null; then
  E2E_NETWORK=testnet USDCX_LIVE_EVM_PRIVATE_KEY="$(node -e 'process.stdout.write(require(process.argv[1]).privateKey)' "$HARNESS")" yarn test:e2e:mobile:usdcx-live:run > "$RUN_LOG" 2>&1; echo "run exit $?"
  rm -f "$LOCK"
else
  echo "LOCK HELD: $(cat "$LOCK")"
fi
grep -E '^\s+(✓|✘)|[0-9]+ (passed|failed)' "$RUN_LOG" | tail -5
```

Expected: `run exit 0` and `1 passed`. Expected live time from the spike and CI: about 2 min of setup, 4-6 min of deposit leg, about 2 min of burn half. A red `payout` step whose message ends with the late-payout note can be Circle's doing (spec section 12): report it with the evidence rather than retrying blindly; any other red step is a defect to fix in a new commit and re-run once.

Check the evidence and the logs for secrets without printing them:

```bash
EVIDENCE=$(find test-results-ios -name usdcx-live-ios-evidence.json -newer "$RUN_LOG" | head -1); echo "$EVIDENCE"
node -e '
const fs = require("fs");
const keys = [require(process.argv[1]).privateKey, fs.readFileSync(process.argv[2], "utf8").trim()].map(k => k.replace(/^0x/i, "").toLowerCase());
for (const file of process.argv.slice(3)) {
  const text = fs.readFileSync(file, "utf8").toLowerCase();
  console.log(file.split("/").pop(), keys.some(k => text.includes(k)) ? "KEY LEAK" : "no key", /[?&]password=/.test(text) ? "PASSWORD" : "");
}' "$HARNESS" ~/arc_testnet_usdcx_ci_key.txt "$EVIDENCE" "$RUN_LOG"
node -e '
const e = require(process.argv[1]);
const { arcKey, arcKeyRole, arcBalanceBefore, arcSnapshotBlock, walletConfirmedBalance } = e.ids;
console.log(JSON.stringify({ arcKey, arcKeyRole, arcBalanceBefore, arcSnapshotBlock, walletConfirmedBalance, fees: e.fees, latenciesMs: e.latenciesMs, phases: Object.fromEntries(Object.entries(e.phases).map(([k, v]) => [k, v.map(s => s.phase)])), hashes: e.hashes, notes: e.notes }, null, 2));' "$(pwd)/$EVIDENCE"
```

Expected: `no key` for the evidence and the run log, and no `PASSWORD` for the evidence (the run log may show `password=` in appium's own eval logging of `location.href` reads; it is the public default test password and the log is never attached); `arcKey` the harness key's address with `arcKeyRole` `deposit`; `walletConfirmedBalance` equal to `arcBalanceBefore` plus the payout (983600 so far); fees `f2`, `f0`, `f1` `exact` (133 each in the spike and the small-burn probe), `s` 119, `circle payout fee` 16400 so far (flat at 1 and 10 USDCx); `phases.deposit` ending `received` and `phases.burn` ending `confirmed`; `history pill ... Confirmed`. Read any screenshot only after `sips -Z 1800 <file>`.

Clean up only this run's devices:

```bash
xcrun simctl shutdown "$A"; xcrun simctl shutdown "$B"; xcrun simctl delete "$A"; xcrun simctl delete "$B"
rm test-results-ios/.device-pair.json
```

The payout (983600 base units so far) went back to the harness key, which the deposit leg spent about 0.015 USDC from.

- [ ] **Step 5: Push and open the PR**

Write the body, then fill its one placeholder from Step 4's output by script (no editor: the agent shell has no terminal), and open the PR only when no placeholder and no dash is left:

```bash
git push -u origin wiktor/usdcx-ios-burn-b
BODY=$(mktemp -t usdcx-pr2b-body); echo "$BODY"
cat > "$BODY" <<'EOF'
The live iOS USDCx E2E now burns USDCx after its deposit leg and fails unless Circle pays the burn and the wallet confirms that payout itself, so the Send-UI burn to Arc, Circle's payout and the wallet's `Confirmed` are tested on iOS every night.

- The deposit leg runs first and passes or fails as before, with more checks: the recipient, maxFee and hookData the counterparty signed, the row's xReserve recipient, phases monotone within submitting, delivering, ready, received, the exact USDCx balance after the claim's fee, the Guardian commitment against the hosted Guardian's, and a deposit amount the wallet will claim unattended.
- Then a public faucet grant (the 10 USDCx tier), a burn of 1 USDCx through Send with the Arc Testnet chip back to the deposit key, the faucet's consume, Circle's payout (one `AttestationUsed` log carrying the burn note id within 10 min of the consume, adding exactly its value to the key's balance read right before the burn) and the wallet's `destinationBalanceConfirmed` and History pill `Confirmed`.
- The payout (about 0.98 USDC) refills what the deposit and its gas spend (about 0.015 USDC), so the nightly's key funds itself.
- The extension's payout leg (`harnessPayoutLeg`) now wraps `payoutLeg`, which takes any key, so the extension suites and this spec share one payout wiring; the extension's behaviour is unchanged.
- The nightly hands `USDCX_LIVE_EVM_PRIVATE_KEY` only to its key check and its test step, so the CLI build, the dependency install and the app build never see it; every other step, env, permission and ceiling stays.
- Live E2E (local): <result line from Delivery Step 4>.

<details><summary>Design notes, budgets and evidence</summary>

- Order: a late Circle payout (Arc payouts have run hours late) can only redden a run after the deposit leg passed, and the hosted Guardian's identity is read only after it too.
- Budgets: each a small multiple of the iOS spike's slowest of 3 runs, floored for chain variance; each Arc read step outlasts a stall on every endpoint. The config timeout of 105 min is the worst passing run (13 min setup cap, 35 min of Circle and relayer caps, the deposit leg's other steps, 44.5 min of burn budgets) and fits the 150 min schedule ceiling.
- A failed CDP read (an inspector reattach, the bridge's 30 s eval cap) is asked again twice before a long poll fails on it.
- Evidence: `usdcx-live-ios-evidence.json` in the uploaded artifacts; it never holds a key or the onboarding password, and names Arc endpoints by host only.
- A late payout from an earlier night that lands during a run fails the payout gate, naming the transfer.

</details>

**Reviewers:** the spec's order and its delta-mode payout gate (the leg's snapshot right before the burn, the wallet's saved balance against it, the payout gate before the wallet confirmation) and `payoutLeg` keeping the extension's payout step unchanged are the parts worth your time.
EOF
RESULT='pass, <total> min; fees f2/f0/f1/s <f2>/<f0>/<f1>/<s>; Circle fee <fee>; consume to payout <n> s; payout to wallet confirmation <n> s'
python3 - "$BODY" "$RESULT" <<'PY'
import sys
path, result = sys.argv[1], sys.argv[2]
text = open(path).read()
marker = '<result line from Delivery Step 4>'
assert text.count(marker) == 1, text.count(marker)
open(path, 'w').write(text.replace(marker, result))
PY
if grep -n '<' "$BODY" | grep -Ev '<details>|</details>|<summary>'; then
  echo 'STOP: a placeholder is left'
elif ! perl -ne 'exit 1 if /\xe2\x80[\x93\x94]/' "$BODY"; then
  echo 'STOP: a dash is in the body'
else
  gh pr create --repo 0xMiden/wallet --base main --head wiktor/usdcx-ios-burn-b --title "The live iOS USDCx E2E never burns USDCx, so Circle's payout and the wallet's payout confirmation go untested on iOS" --body-file "$BODY" && gh pr view --repo 0xMiden/wallet --json number,body --jq '.number, .body'
fi
```

Expected: the push succeeds; `RESULT` holds Step 4's numbers in place of every `<...>` before the block runs (the gate refuses any `<` left outside the `details` tags); no `STOP:` line; the PR is created and its body reads back as written. No tool attribution anywhere in the title or body. Record the PR number as `PR2B`.

- [ ] **Step 6: CI on the pushed head, by SHA**

```bash
gh api "repos/0xMiden/wallet/actions/runs?head_sha=$(git rev-parse HEAD)" --jq '.total_count, (.workflow_runs[] | "\(.name) | \(.status) | \(.conclusion)")'
```

Expected: `total_count` above 0 (a push can create no runs: KB `github-actions-push-sometimes-creates-no-runs`; if 0 after 5 minutes, push an empty fix commit only after checking by SHA again). Watch the checks that cover this change: the jest job or shards (the ios-wallet-page, harness, helpers and workflow guard suites), `lint:e2e`, the type check, the changelog check and the linked-PR injection guard. Report each failure as it lands and fix it with a new commit, unsquashed, never force-pushed.

- [ ] **Step 7: Dispatch the nightly on the branch**

```bash
gh workflow run e2e-usdcx-live.yml --repo 0xMiden/wallet --ref wiktor/usdcx-ios-burn-b
gh run list --repo 0xMiden/wallet --workflow e2e-usdcx-live.yml --branch wiktor/usdcx-ios-burn-b --event workflow_dispatch --limit 1 --json databaseId,status,headSha --jq '.[0]'
```

The run can take a few seconds to appear: if the list prints `null` or an older head, ask again after about 20 s (the Bash tool refuses a foreground `sleep`). Then watch that run id (`gh run watch <id> --repo 0xMiden/wallet --exit-status`; the dispatch ceiling is 235 min, a typical job about 25 min). The workflow's concurrency group queues this run behind a nightly in flight, so the two never share the CI key's window. Expected: the key-check step passes (the secret reaches it through the step's own `env`), the build passes, and `Run USDCx bridge-IN E2E (mobile, live testnets)` reports `1 passed`. Download the artifact (`gh run download <id> --repo 0xMiden/wallet --name usdcx-live-e2e-<id> --dir "$(mktemp -d)"`) and run Step 4's secret check on its `usdcx-live-ios-evidence.json` against the CI key `~/arc_testnet_usdcx_ci_key.txt`, the run's only key (`evidenceJson` refused it in the run), and confirm `ids.arcKey` is that key's address and `ids.arcKeyRole` is `deposit`. Add the dispatch run's link and result to the PR body's Live E2E bullet (`gh pr edit "$PR2B" --body-file` with the edited copy, dash-checked as in Step 5). A red payout step is reported with its evidence, not retried blindly.

- [ ] **Step 8: Admin squash-merge**

Once every relevant check and the dispatched run are green:

```bash
gh pr merge "$PR2B" --repo 0xMiden/wallet --squash --admin --body "The live iOS USDCx E2E burns 1 USDCx through Send back to its deposit key after the deposit leg and gates on Circle's payout and the wallet's confirmation; the nightly hands its Arc key only to its key check and test step."
gh pr view "$PR2B" --repo 0xMiden/wallet --json state,mergeCommit --jq '"\(.state) \(.mergeCommit.oid)"'
gh api "repos/0xMiden/wallet/actions/runs?head_sha=$(gh pr view "$PR2B" --repo 0xMiden/wallet --json mergeCommit --jq .mergeCommit.oid)" --jq '.total_count'
```

Expected: `MERGED <sha>`, and main's push runs exist for that SHA. `--body` sets the squash commit's message (KB `github-squash-merge-body-replaces-commit-messages`). The next scheduled nightly (03:17 UTC) runs the burn from main; report its result when it lands.

## Self-Review

1. **Spec coverage.** Decision 1: deposit leg kept and first (Task 1 leaves its steps in place), recipient/maxFee/hookData (Task 1 Step 10), preflight floor deposit plus gas (Step 8), row `usdcxRemoteRecipient` (Step 11), exact vault with f2 from the consume row (Step 13), Guardian commitment (Step 14), phases monotone ending `received` with `ready` optional (Steps 7, 11, 12); burn half after the deposit leg (Task 2 Step 11): withdrawal flags before the grant, grant of the 10 USDCx tier, Arc-chip Send burn of 1 USDCx (PR 2a's driver, with the step's signal), the hard payout gate through `payoutLeg` with deadline consume + 10 min and a failure naming the key Circle pays, the hard wallet confirmation (`destinationBalanceConfirmed` reading `payout.balance`, and the pill). Decision 2 (R20): the burn goes back to `evmAddress` as a `PayoutKey`, the row's saved balance is checked against the leg's snapshot (guard test), the key stays in `secrets` and out of every eval. R19's amounts (Setup Step 2, Task 2, Delivery Step 1's grep). R20's claim floor (Task 1 Step 9 and its guard). R21's harness key and lock for the local run (Delivery Step 4). R22/R23: the one payout leg, waited on in the same test. R24: no key flag, `burnOutputNoteProblem` (Task 2 Step 11), `ARC_READ_STEP_BUDGET_MS` for both Arc read steps, `arcHost` in every message (guard test), the CLI installed before the key enters an environment (Delivery Step 4). R25 (Task 3 Steps 2-3). R26 (the signal into the driver). Decision 3: PR 1b's modules imported and the payout wiring shared, not copied (Setup Step 2 checks them). One CHANGELOG line (Task 3 Step 6). Docs paragraph (Task 3 Step 5). Budgets from the spike (Task 1 Step 4, Task 2 Step 9) and the timeout derivation (Task 2 Step 12). Delivery: gates, mutations, internal review, one live run, push, PR, CI, dispatch, merge.
2. **Placeholder scan.** The angle-bracket fields left for the executor are filled from earlier output: Step 5's `RESULT` numbers from Step 4, and the PR number from Step 5. Step 5 refuses to open the PR while any `<...>` is left in the body.
3. **Type consistency.** PR 2a's `IosNativeAsset`, `readTransactionRows`, `readBridgedSendRows`, `nativeAsset`, `readVaultBaseUnits`, `homeVaultBaseUnits(faucetId, holds, timeoutMs, want)`, `burnUsdcxViaSendFlow(UsdcxBurnViaSendOptions)` with `signal?`, `waitForBurnCompleted(rowId, timeoutMs, pollMs?)`, `openTransactionDetails`, `transactionDetailsView` are used with their merged signatures (Setup Step 2 greps them); `payoutLeg(step, { takeKey, arc, budget, evidence, secrets })`, `PayoutKey { key, role, label }` and `PayoutLeg { key, snapshot, waitForPayout(burn, depositor) }` are defined in Task 2 Step 3 and used in Task 2 Step 11; `waitForPayout`'s `ConsumedBurn` takes the burn's `Hash` note id and the oracle's `BurnEvidence`; `settleLedger`'s row type accepts both `TransactionRowSnapshot` and `BridgedSendRow`.
4. **Review Focus.** Each of the five lines has its test in the owning task (Tasks 1, 2, 3), and line 4 is checked again on live evidence (Delivery Step 4).
5. **Size.** About 700 added lines (see File Structure), the unsplit plan's commits 2-4 plus R25, `payoutLeg` and the claim-floor and host-only checks.

## Plan critique log (history: the unsplit plan of 2026-10-11, kept as written)

Task, step and commit numbers below are the unsplit plan's (its Tasks 1-2 are PR 2a's Tasks 1-2, its Tasks 3-5 are PR 2b's Tasks 1-3). Both open questions at its end are resolved: the user kept R20 (question 1) and chose the split, option (a) (question 2). The Refresh log below says what changed since.

Two critic lists reviewed this plan: list A (six findings) and list B (four), each id prefixed with its list. Every claim was checked against the source first (`progress.md`, PR 1b at `f161768b1`, main at `8e7ae1630`, the probe reports).

- A-F1 (blocking, R20 fresh key vs CI key): applied. R20 in `progress.md` is a later user ruling that names and supersedes the fresh-key decision for iOS (written after this plan's first draft), and the re-scope's option (b) already described it. The burn now goes back to `evmAddress`; `burn_destination` replaces `fresh_key`; no `newArcKey`, `recordArcKey`, ledger write or "strands" text; `balanceBefore` (the row's snapshot, checked against the run's own read) feeds the payout gate; the confirmation must read `balanceBefore + payout.value`; the guard markers and mutation 12 now pin the delta mode. Open question 1 asks the user to confirm.
- A-F2 (blocking, R19 amounts and grant tier): applied. The grant passes R19's `GRANT_UNITS` (10 USDCx tier) instead of no amount (100 USDCx); every comment, header, docs, CHANGELOG and PR-body amount says 1 USDCx and about 0.98 USDC; Setup Step 2 now prints `BURN_UNITS` and the grant amount and stops unless R19/R20's follow-up has landed; Delivery Step 1 greps the added lines for a stale amount. The unit tests keep the 10 USDCx spike's recorded DOM values, which stay self-consistent.
- A-F3 (local run signs with the CI key): applied in part. The local run now uses R21's harness key, read from the ledger by its role, and holds R21's run lock for the run (stops if it is held), and the leak check scans for both keys. Rejected: the `gh run list` in-progress/queued check, because once the local run no longer touches the CI key a nightly cannot collide with it; the collision that remains (a usdcx `e2e:real` run on the harness key) is what the lock covers.
- A-F4 (size about twice the expectation): applied as asked: the measured size (about 1,550 added) is restated in File Structure and Self-Review, and the choice goes to the user as open question 2. No optional cut was applied unasked; the candidates, with sizes, are there.
- A-F5 (Guardian identity before the deposit; native asset outside the try): applied. `hostedGuardian` now runs inside `assert_guardian_account`, after the deposit row reached `received`, and that step hands the identity to the burn half (Task 4 Step 6 adds the `const identity =` and `return hosted;`, so commit 2 has no unused binding); `native_asset` is the first step inside the `try`, so its failure still writes the evidence. Verified: `/pubkey` answered a spike run with a 502 page, and main's deposit leg never reads it.
- A-F6 (one failed CDP eval fails a minutes-long poll): applied, in the readers rather than per poll. Verified: `pollUntil` fails on a failed read at once, `stashAndPoll` rethrows, and `cdp.eval` rejects after 30 s. A module `ridingOut` (3 attempts, 1 s apart, the third failure in a row throws) wraps `readTransactionRows`, `readVaultBaseUnits`, the generating page's hash read and `transactionDetailsView`, which covers every poll the finding lists (`waitForBurnCompleted`, `homeVaultBaseUnits`, `settleLedger`'s `readSettledChange`, the three burn-half `pollUntil`s and the pill poll) without changing `pollUntil`. Three tests (one per reader shape) and mutation 14 pin it; Task 2 Step 4 re-anchors after `ridingOut`.
- B-F1 (same as A-F1, with R21 re-anchoring of docs section 8): applied with A-F1; the docs step no longer anchors on section 8's wording, which R21 rewrites, but inserts a subsection before the `---` that closes section 8 (checked on a copy of PR 1b's doc: 6 lines, one blank line on each side).
- B-F2 (mutation 5 fails 2 tests): applied. Verified on the stub: with bytes read every poll the 409 test's Failed round is never read, so it resolves. Row 5 now predicts both titles; the new ride-out test for `waitForBurnCompleted` asserts the read count only, so mutation 5 does not fail it.
- B-F3 (`✕` never prints in the agent shell): applied on the critic's observed run (not re-run here: the failure headers print with or without per-test lines, so the fix holds either way). `mut()` greps `^Tests:|●` and the Expected line asks for one `●` failure header per predicted title.
- B-F4 (`$EDITOR` in a non-TTY shell, no gate before `gh pr create`): applied. The body's one placeholder is filled by script from a `RESULT` line, and `gh pr create` runs only when no `<...>` and no dash is left.
- Also fixed while editing: Delivery Step 7 no longer runs a foreground `sleep` (the Bash tool refuses one); it lists the dispatch run and asks again after about 20 s.

### Open questions for the user (resolved)

1. **Burn destination: R20 or the brief's fresh key?** The plan now follows R20 (burn back to the deposit key, delta-mode payout gate). Recommended: keep R20. It is the user's later, explicit ruling for iOS, it makes the nightly self-funding, and its one new risk (a late payout from an earlier night landing mid-run reads as a Circle red) is rare and named in the failure. If the fresh key is reaffirmed, A-F1 and B-F1 are undone: a `fresh_key` step (`newArcKey`, its private key into `secrets`, `recordArcKey`, a zero balance) replaces `burn_destination`, the payout gate drops `balanceBefore` and the confirmation expects `payout.value`, the guards pin `recordArcKey(` before the burn and one `.privateKey`, and the docs, header and PR body describe the stranded payout.
2. **Size: about 1,550 added lines against 650-800 expected.** Options: (a) split PR 2 at commit 1, the `IosWalletPage` readers, driver and 23 tests (about 865) as their own PR, then the spec, config, workflow, docs and CHANGELOG (about 700) stacked on it; (b) keep one PR of four commits; (c) on either, cut what no decision requires, about 100 lines: the two-chain Preferences refusal and its test (about 25; the Preferences read itself stays, it is the only source of `baseFee`), the bridged-send typing test (about 25), the receiving-tx link check (about 20), the light and dark review screenshots (about 6), and `routeOf` with its test (about 12, which then needs the review's query read from `location.hash` some other way). Recommended: (a), the split, as on PR 1 and the fund-faucet PR: each half reviews on its own, and nothing is cut from the checks the user asked for; (b) is close behind, since the commits already split by layer.


## Refresh log (2026-10-11, this split)

Every change against the unsplit plan `2026-10-11-usdcx-ios-burn-plan.md`, and why.

1. **Split.** This plan holds the old Tasks 3-5, renumbered 1-3, on main after PR 2a merged (the user's choice of old open question 2, option (a)). Worktree `wt-usdcx-ios-burn-b`, branch `wiktor/usdcx-ios-burn-b`; Setup Step 1 now waits for PR 2a, not PR 1b; the old Tasks 1-2 are PR 2a's.
2. **Base re-verified at PR 1b's final head.** PR 1b merged as #1421 (`20949e612`), tree equal to `d8345cbd4` except main's #1420 files. Every before-snippet of the spec (lines 1-17, 52-55, 70-85, 106-110, 119-125, 127-167, 169-174, 211-215, 221-230, 249-258, 260-267, 269-276, 277-282), `playwright.ios.usdcx-live.config.ts:5-20`, `playwright.ios.config.ts:18-19` and the workflow (lines 3-6, 18-19, 68-71, 83-84, 264-266) matched `d8345cbd4` verbatim: PR 1b never touched them. Setup Step 2 now proves the same with `git diff d8345cbd4 HEAD`, and its R19/R20 stop conditions are gone: both landed (`BURN_UNITS 1_000_000n`, `GRANT_UNITS 10_000_000n`, `balanceBefore` in `GatewayPayoutArgs`).
3. **Exports and cites.** Re-checked at `d8345cbd4`; fixed: `GAS_RESERVE_UNITS` is usdcx-constants.ts:33 (was cited :27); `GRANT_UNITS` is an export (Setup's fallback for an inline grant amount is gone); new names used: `arcHost` (arc-usdcx.ts:152), `readArcUsdcSnapshot` (:240, inside the leg), `PREFUNDED_KEY_NOTE` (:105, in the gate's failures), `ARC_READ_STEP_BUDGET_MS`, `HARNESS_ARC_KEY_FILE`, `isWorthClaiming` and `CLAIM_COST_FEE_MULTIPLE` (usdcx-constants.ts), `burnOutputNoteProblem` (usdcx-run.ts:350), `takeRunArcKey` (:63, inside `harnessPayoutLeg`), `harnessPayoutLeg` and `ConsumedBurn` (usdcx-legs.ts:593, :555). `NamedStep` now hands each step an `AbortSignal` (usdcx-run.ts:120), which the burn step passes to PR 2a's driver. `keylessEnv` is private to `scripts/e2e-real.mjs` and already strips `USDCX_LIVE_EVM_PRIVATE_KEY` from the runner's children; this spec does not run under that runner, so its equivalent is Delivery Step 4's keyless CLI install and R25.
4. **The payout gate is PR 1b's payout leg, not a third copy.** `harnessPayoutLeg` takes its key from `takeRunArcKey` and asserts the role `harness` with a failure context naming `harness.json`, so the iOS deposit key cannot use it as is; it is not bound to the extension page. Task 2 Steps 1-5 split it into `payoutLeg(step, { takeKey, ... })`, which the extension's `harnessPayoutLeg` now wraps with its key, role and label, unchanged in behaviour (its two unit tests and spec-selection's wiring guard stay green), and one new unit test pins a key the run names itself. The spec drops the unsplit plan's `burn_destination` step, its `circlePayoutContext` and its own `waitForGatewayPayout` call, expects and evidence writes: the leg does all of it (R23). The iOS label names the key Circle pays, which keeps decision 1's "failure text naming Circle" without changing the extension's text.
5. **Delta mode as the extension does it.** The gate's `fromBlock` and `balanceBefore` now come from the leg's one `readArcUsdcSnapshot` read right before the burn, not from the wallet's own saved block and balance; the wallet's saved balance must equal the snapshot (as `confirmBurn`'s `keySnapshot` check does), and the confirmation must read `payout.balance`, recorded as `walletConfirmedBalance`. The evidence records the key as `arcKey` with role `deposit` (Delivery Steps 4 and 7 read those, not `burnDestination`).
6. **`arc_state` before the grant.** xReserve's registration and withdrawal flags are read in their own step before the grant, as the extension's specs do (spec-selection's `USDCX_PAYOUT_PRECHECK` shape), so a bridge that cannot pay costs no grant; both Arc read steps take `ARC_READ_STEP_BUDGET_MS` (R24's budget rule) instead of the old combined 120 s step.
7. **R24 folded in.** Arc endpoints appear in messages as `arcHost(...)` (the preflight and `arc_state`), pinned by a guard; `burnOutputNoteProblem` checks `outputNoteIds` only when the burn completed locally; the oracle's sponsorship must be above zero (as `confirmBurn` requires, so a missing fee schedule cannot hide in a bounded fee); keys only from the environment, and the local run installs the pinned CLI before the key enters any environment.
8. **R25 folded in.** Task 3 moves `USDCX_LIVE_EVM_PRIVATE_KEY` from the job's `env` to the key-check step's and the test step's own `env`, with a red-first guard test in `usdcx-live-workflow.test.ts` and mutation 8; the "every changed line is a comment" check became "every changed non-comment line is that scoping". #1402's key-check test and the injection guard's 150/235 ceilings stay green.
9. **R20's claim floor.** The `native_asset` step refuses a deposit at or below the wallet's unattended claim floor before the counterparty is paired, since `deposit_amount` is a dispatch input; pinned by a guard and mutation 2.
10. **R26.** The burn step hands its abort signal to PR 2a's driver, which never clicks submit once it fired.
11. **The grant asks for and checks the exact tier.** `asset.amount` must equal `GRANT_UNITS`, as PR 1b's `fundFromPublicFaucet` checks, instead of at least `BURN_UNITS + GRANT_MARGIN_UNITS`; `GRANT_MARGIN_UNITS` is no longer imported.
12. **Config timeout recomputed.** The burn half's budgets now sum to 44.5 min (two 75 s Arc read steps in place of one 120 s step), and the deposit leg's new steps to 6 min (the unsplit plan's 5.5 was an arithmetic slip): about 102 min, still `6_300_000` (105 min) and inside the 150 min ceiling with the job's ~21 min of setup.
13. **Local live run.** The harness key and the lock come from their fixed paths (`HARNESS_ARC_KEY_FILE`, `USDCX_RUN_LOCK`) instead of a role search; the hand-taken lock is written in the runner's own JSON shape so `yarn e2e:real` refuses while it is held; the evidence is found with `find -newer` instead of a guessed directory.
14. **Text.** The docs subsection, the workflow header, the CHANGELOG line and the PR body say how a stray transfer fails (named) and that the key reaches only the two steps; the commit and step names follow the leg (`key_snapshot`, `payout`) instead of `burn_destination` and `circle_pays_burn`.

## Open questions for the user

1. **Share the payout wiring by generalizing `harnessPayoutLeg` (Task 2 Steps 1-5), or mirror it in the iOS spec?** Recommended: generalize. One wiring for all three live specs is what R23 asked for, the extension's behaviour and text stay byte for byte, and the cost is about 30 changed lines in `usdcx-legs.ts` and one unit test. Mirroring leaves PR 1b's files untouched but brings back the copy R23(b) removed (the snapshot step, the gate call, its two expects and three evidence writes, about 45 lines).
2. **Keep the claim-floor refusal for a dispatched `deposit_amount` (Task 1 Step 9)?** Recommended: keep (about 8 lines and a guard). Without it a dispatch of 0.0002 USDC sends a real deposit and then times out 15 minutes later on a mint the wallet will not claim.
3. **The test step's own children still inherit the key** (the fixture's CLI check, appium, the Node oracle): R25 keeps it out of every other step, CI installs the CLI in an earlier step and the local run installs it first, so no build runs with it. Recommended: accept. Deleting it from `process.env` in a `beforeAll` would also hide it from the fixture's children, but the spec reads it at module load and its `test.skip` depends on it, so that change needs its own proof.
