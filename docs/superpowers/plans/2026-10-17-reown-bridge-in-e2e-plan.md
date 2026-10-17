# iOS Bridge-IN E2E: UI-only specs, live executor-route deposits from three chains, a blocking suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the iOS bridge-in E2E a CI signal that can fail and that tests only routes production uses: retire the two specs that do not (the AggLayer receive spec, whose row an E2E hook makes, and the Sepolia-fork USDCx spec), add a live executor-route deposit from Base Sepolia, Arbitrum Sepolia and Ethereum Sepolia through the real deposit screen and a real Reown pairing, and make E2E Bridge-IN fail its run when a spec fails.

**Architecture:** The receive spec goes, since the AggLayer deposit spec already checks everything it did on a row the deposit screen makes, and the E2E hook that made its row now makes USDCx rows only, for the Chrome suites that cannot pair with Reown. A matrix job in `e2e-usdcx-live.yml`, after the Arc job, runs one test per executor source chain: the iOS key deposits through the real UI, its headless Reown counterparty approves that chain alone and signs through a local-nonce sender pinned after the approve (the #1504 lesson) and tip-capped on Ethereum Sepolia (#1508), and every hop is gated with the extension suite's executor proofs; the burn half the Arc spec already runs moves into a shared helper and pays the key back on each source chain. The bridge-in suite gets its counterparty isolation and Epoch race fixes, runs every spec (`maxFailures: 0`), proves itself at `--retries=0`, and then loses `continue-on-error`. The Reown project id stays the built-in default, which is the paid project.

**Tech Stack:** TypeScript, Playwright 1.61 on iOS simulators over CDP, Jest (`@swc/jest`, jsdom by default, `@jest-environment node` per file), viem 2.55.4, `@walletconnect/sign-client` and `@walletconnect/utils` 2.23.7 (Reown), GitHub Actions on `macos-26-xlarge`.

**Spec:** the user request relayed by the workflow harness ("work autonomously, open a pr and babysit it to green. everything that you can run in ci, run in ci (ideally all the simulators too)") as narrowed by the user's decisions of 2026-10-17, which bind this revision and win wherever the two differ: `/private/tmp/claude-501/-Users-celrisen/db8fab66-f5d7-4097-9a35-f658575da152/scratchpad/reown-plan-revision.md`. Evidence, read in full for this plan:
- `/private/tmp/claude-501/-Users-celrisen/db8fab66-f5d7-4097-9a35-f658575da152/scratchpad/reown-scout-receive.md`
- `/private/tmp/claude-501/-Users-celrisen/db8fab66-f5d7-4097-9a35-f658575da152/scratchpad/reown-scout-usdcx-ios.md`
- `/private/tmp/claude-501/-Users-celrisen/db8fab66-f5d7-4097-9a35-f658575da152/scratchpad/reown-scout-reown-id.md` (now only the project id facts)
- `/private/tmp/claude-501/-Users-celrisen/db8fab66-f5d7-4097-9a35-f658575da152/scratchpad/reown-scout-suite.md`
- `/private/tmp/claude-501/-Users-celrisen/db8fab66-f5d7-4097-9a35-f658575da152/scratchpad/reown-preflight.md` (the pre-flight review of the first version of this plan)

Every file:line below was re-read in `/Users/celrisen/miden/wt-reown-bridge-in` at `fd614122d` (branch `wiktor/reown-bridge-in-e2e`). `origin/main` has since moved to `3e7219941` (#1494, #1430, #1511, #1510, #1488); of the files this plan edits only `CHANGELOG.md` changed there, inside the same `## 1.17.5 (TBD)` section, where main's new `### Fixes` lines sit mid-list and a second `### Changes` follows the list, so a line appended at the end of `### Fixes` merges without a conflict (`git merge-file`, 0 conflicts). Facts are cited; inferences are marked **[I]**.

## Size

| # | Task | Part | Touches the product (`src/`) | Lines (approx., tests included) |
|---|---|---|---|---|
| 1 | Retire the receive spec; the E2E hook makes USDCx rows only | 1 UI-only | E2E-only hook (installed only under `MIDEN_E2E_TEST`) | +20 / -125 |
| 2 | Counterparty: own Core per instance, silent once stopped, session chains, guarded send hook | 2 and 3 | No | +330 / -60 |
| 3 | Test id on the deposit amount step's network row | 2 live | Yes: one `data-testid` attribute | +10 |
| 4 | The hook and the harness parser report the forwarded CCTP leg | 2 live | E2E-only hook | +45 / -2 |
| 5 | L2 sender: one write endpoint, local nonce, each send pinned after the previous one, the chain's tip cap | 2 live | No | +290 |
| 6 | Executor request gates, a narrower burn-proof input, the key's own refill hint, the Sepolia payout-key check | 2 live | No | +400 / -6 |
| 7 | iOS page object: network picker, route timeout, a burn to any payout chain | 2 live | No | +170 / -40 |
| 8 | Share the live burn half between the iOS specs (Arc spec refactor) | 2 live | No | +610 / -545 |
| 9 | The live executor-route spec, one test per source chain, and its pins | 2 live | No | +540 |
| 10 | E2E USDCx live: the executor matrix job after the Arc job, docs, CHANGELOG | 2 live | No | +240 / -25 |
| 11 | Retire the Sepolia-fork USDCx spec | 1 UI-only | No | +16 / -440 |
| 12 | Bridge-IN stabilisation: Epoch poll, every spec runs, dispatchable retries | 3 blocking | No | +40 / -25 |
| 13 | E2E Bridge-IN fails its run when a spec fails | 3 blocking | No | +50 / -15 |

One PR. About 4,050 changed lines: about 2,760 added, about 1,200 of them tests, and about 1,290 removed, of which the two retired specs and their helpers are about 530 (`bridge-in-receive.ios.spec.ts` 90, `createBridgeReceive` 16, `bridge-in-deposit-usdcx.ios.spec.ts` 206, `xreserve-fork.ts` 217); the Arc spec refactor (Task 8) moves about 390 lines (the burn half's 314 and the helpers' 73) without changing what they check.

## Global Constraints

- Where checks run (binding, the user's decision 4 of 2026-10-17): everything runs in CI: builds, simulators, `tsc` (`yarn ts`), lint (`yarn lint`, `yarn lint:e2e`, `yarn lint:i18n`), full jest and coverage. Locally only jest on the changed test files and their directories at `--maxWorkers=1`, plus `yarn prettier --check` and `yarn eslint --max-warnings 0` on the changed files. Every `yarn jest` line in the steps below names such files or directories and ends in `--maxWorkers=1`; a mutation check is one of those runs. Reads stay local too: `actionlint -oneline` on a changed workflow file, the dash check, `git grep`, read-only `gh` and public-RPC reads, and Task 8's checked cut script. Never locally: `yarn test` or any jest run wider than the changed test files' directories, coverage, `yarn ts` or `tsc`, `yarn lint`, `yarn lint:e2e`, `yarn lint:i18n`, any build, any simulator, any E2E suite, `yarn e2e:real`.
- After each push, CI runs the rest: `pr.yml`'s `Unit tests` (ESLint, TypeScript Check, jest), its three coverage shards and their gate, `lint:i18n`, `lint:e2e` and mock-e2e, `pr-compile-surfaces.yml`, the five `pr-e2e-*` suites and `changelog.yml`. Find the run of the pushed head by its SHA, not the branch, while the next task is written (`gh run list --repo 0xMiden/wallet --workflow pr.yml --commit "$(git rev-parse HEAD)" --json databaseId,status,conclusion`; no run after 10 minutes: close and reopen the PR, agentic-kb `github-actions-push-sometimes-creates-no-runs`), and fix a red check with a new commit as soon as it reports. `pr.yml` cancels a PR's in-progress run when a newer commit arrives (`concurrency` `cancel-in-progress: true`), so only the newest head's run counts, and a push never goes out while a run whose result is still needed is pending (Task 2 Step 3).
- One deliberate red push (the user's red-before rule): Task 2 Step 3 pushes Task 1's commit and Task 2's failing tests, nothing else, and opens the draft PR saying its first run is expected to fail. Task 1 adds no test that fails on today's code (it deletes a spec and narrows a hook's argument type, which the hook's own suite and CI's `tsc` check), so the red push goes to Task 2, the first task whose new tests fail at `fd614122d`. Every other task's red-before is its local `yarn jest ... --maxWorkers=1` run.
- Workflow lint: every task that edits a file under `.github/workflows/` runs `actionlint -oneline <that file>` before its commit and adds no finding. At `fd614122d` neither `e2e-bridge-in.yml` nor `e2e-usdcx-live.yml` has one, and no CI job lints workflows (`git grep actionlint -- .github` finds only a comment at `pr.yml:51`).
- Every shell command starts with `cd /Users/celrisen/miden/wt-reown-bridge-in && export PATH="$HOME/.nvm/versions/node/v22.22.0/bin:$PATH"`. The shell is zsh: quote globs.
- Never read or print a private key. Off limits: `~/.miden-e2e/**`, `~/arc_testnet_usdcx_ci_key.txt` and every other key file; `gh secret` values cannot be read and are never echoed. Public keys and addresses in this plan are fine to print. Test vectors already in the repo (for example the jest key `0x59c6...690d` in `usdcx-l2-deposit.test.ts`) are fine to reuse in tests.
- No em dash (U+2014) and no en dash (U+2013) anywhere: code, comments, docs, workflow text, CHANGELOG, commit messages, PR text. A file the task creates is checked whole: `perl -CSD -ne 'print "$ARGV:$.: $_" if /[\x{2013}\x{2014}]/' <new files>` (macOS grep has no `-P`) prints nothing. A tracked file is checked on its added lines only, before staging: `git diff -U0 HEAD -- <files> | perl -CSD -ne 'print if /^\+.*[\x{2013}\x{2014}]/'` prints nothing. The whole-file `perl` lines in the task steps below are shorthand for this rule: eight tracked files they name already hold dashes at `fd614122d` (bridge-in-test-hooks.ts 2, ios-wallet-page.ts 29, SelectAmount.tsx 8, SelectAmount.test.tsx 4, bridge.ts 12, e2e-bridge-in.yml 5, e2e-usdcx-live.yml 1, bridge-in-deposit-epoch.ios.spec.ts 7, besides CHANGELOG.md and e2e-architecture.md), and a whole-file run prints those. Existing dashes in lines a task does not touch stay.
- `yarn prettier --check` failing on a changed file is fixed with `yarn prettier --write` on that file (the plan's code blocks are not guaranteed to be Prettier's exact line breaks), and `yarn eslint --max-warnings 0` reporting only `import/order` or `prettier/prettier` is fixed by the same command with `--fix`; then check again. CI lints only `src` with the main config (`package.json` `lint`), and `playwright/**` with the harness ratchet (`yarn lint:e2e`, run in CI only), so a playwright file's local eslint run is a style aid, while `src` files must be clean.
- Reown in prose (comments, docs, CHANGELOG, PR text); code names stay as they are (`WcCounterparty`, `wc-counterparty.ts`, `WALLETCONNECT_PROJECT_ID`, `__TEST_REOWN_*`, `@walletconnect/*`).
- Comment density: match the file. Measured at `fd614122d`: `playwright/e2e/ios` 19%, `playwright/e2e/helpers` 17%, `src/lib/miden/activity` 18%, `wc-counterparty.ts` 18%, `usdcx-live-deposit.ios.spec.ts` 14%, `usdcx-l2-deposit.ts` 10%, the two live workflows 32%. Comments say why, never what. The code blocks below are already at that density; do not add narration.
- Code style (CLAUDE.md "Code style"): Prettier 120 columns, single quotes, semicolons; no `any`; no type assertions in source except where a neighbouring test already uses the same `as unknown as` fake pattern; `tsconfig.json` has `noUnusedLocals`, `noUncheckedIndexedAccess` and covers `playwright/**/*.ts`, so remove every import a change leaves unused.
- Commit messages: one lower-case line, no trailers (no `Co-Authored-By`, no "Generated with"), no tool name. The harness reminder that asks for attribution lines is overridden by the user's own rule. Never amend; never force-push.
- Stage explicit paths only (`git add <paths>`, `git rm <paths>`). Never `git add -A` or `git add .`: `docs/superpowers/` is excluded through `.git/info/exclude`, and this plan file is never committed.
- CHANGELOG: entries go under `## 1.17.5 (TBD)` -> `### Fixes`, appended at the end of that list. `git tag --list 'v*' --sort=-v:refname` shows `v1.17.4` as the latest release at `fd614122d`; run `git fetch --tags` and re-check before Task 1's commit.
- No test is skipped or removed to go green; a red test is fixed in the code or the test. Task 1 and Task 11 retire two E2E specs by the user's decision of 2026-10-17 (they do not take a production route), not to go green.
- Funding is not a task, and it is never done by moving another key: no transfer can be signed without reading a private key, which the rule above forbids. A read-only read on 2026-10-17 shows the iOS key already holding ETH and USDC on all three source chains (section "What the key needs"); the controller repeats that read before the first live dispatch and asks the user only for what it shows missing. `USDCX_HARNESS_ARC_KEY` (0x4D4A180C637a71FCB9b5BD1186C8ce23C40EBa81) is never moved by this work on any chain: `usdcx-burn-l2` proves its balances as exact deltas, and a push to main can start an E2E USDCx run at any moment.
- `@playwright/test` `test.skip` stays the way the live Arc spec uses it: a spec skips without its key, and the workflow's guard step is what makes a missing key red. The executor spec defines only the source chain `USDCX_LIVE_SOURCE` names (all three when it is unset), and fails at load when it names none, so a typo can never read green.

## Decisions taken

| Question | Taken | Why |
|---|---|---|
| Reown project id (user, 2026-10-17) | Reown project id: the built-in default is the paid project (user, 2026-10-17); no secret, nothing wired | A read-only probe on 2026-10-17 shows Reown's RPC answering Sepolia, Base Sepolia, Arbitrum Sepolia, Arc Testnet and mainnet with it (`DEFAULT_WC_PROJECT_ID`, `src/lib/walletconnect/config.ts:31`). |
| Specs that skip the production route (user, 2026-10-17: "All the bridge-in specs should use the proper UI route") | Retire `bridge-in-receive.ios.spec.ts` (Task 1) and the Sepolia-fork `bridge-in-deposit-usdcx.ios.spec.ts` (Task 11); no spec makes a bridge row through an E2E hook or deposits through a route production does not use | The receive spec made its AggLayer row through `__TEST_CREATE_BRIDGE_RECEIVE__`; the AggLayer deposit spec makes its row through the real UI and a real Reown pairing and asserts everything the receive spec did (Task 1's comparison), so nothing moves. The fork spec registered Miden on Sepolia's xReserve itself, a route production does not have (Task 11). |
| The Chrome `usdcx`, `usdcx-in` and `usdcx-in-l2` Node-signed suites (`usdcx-roundtrip.spec.ts:193, :202`, which hosts the round trip and `usdcx-in`, and `usdcx-in-l2.spec.ts:188`) | Out of scope and unchanged; the hook keeps making their `usdcx` rows | The extension cannot pair with Reown: the COEP isolation its threaded WASM needs blocks the Reown relay (agentic-kb `walletconnect-blocked-by-coep-isolation`), so their deposit has no UI route to take. The iOS executor spec (Task 9) is that route's E2E. |
| The hook once the receive spec is gone | `__TEST_CREATE_BRIDGE_RECEIVE__` drops its `provider` argument and the fields no remaining caller passes, and makes `usdcx` rows only; `__TEST_SET_AGGLAYER_SENDER__`, the Reown hooks and the state reads stay | Its only callers left are the Chrome `createUsdcxBridgeReceive` (always `usdcx`, `playwright/e2e/helpers/bridge.ts:560-572`) and its own unit tests; the AggLayer deposit spec still points the sender match at its solver faucet (`bridge-in-deposit.ios.spec.ts:90-95`). |
| Live leg host (usdcx-ios scout 2.1) | `e2e-usdcx-live.yml`, a matrix job beside the Arc job | The only iOS workflow with no `E2E_EVM_RPC_URL`, no served config, the iOS key, queued runs and no retries (`e2e-usdcx-live.yml:61-65, :78-92, :279-284`). |
| Executor chains (user, 2026-10-17) | All three the wallet offers on testnet: Base Sepolia, Arbitrum Sepolia and Ethereum Sepolia (wallet-config `testnet.json` version 10, `supportedEvmChains.{base-sepolia,arbitrum-sepolia,sepolia}.bridges.usdcx`, route `executor`), one matrix entry each, `fail-fast: false`, the entries in parallel | Each entry reads and refills only its own chain's balance of the key and has its own nonce there, so parallel entries cannot break each other's exact-delta gates, while serial ones would hold the workflow's one concurrency slot for up to about 8 hours. `fail-fast` would cancel the other chains mid-deposit, and a cancelled run can leave a deposit no relayer mints (`e2e-usdcx-live.yml:63-64`). |
| Parallel with or after the Arc job (usdcx-ios scout recommends parallel) | **After** it: `needs: mobile-usdcx-live`, `if: ${{ !cancelled() && inputs.legs != 'arc' }}` | Departs from the scout. A forwarded burn's hook names the key as the executor's recovery address on Arc (`src/lib/usdcx/executor.ts:94-116`), so a deposit the executor cannot finish can pay the key on Arc **[I]**, inside the Arc job's payout window, which counts every credit to the key (`playwright/e2e/docs/e2e-architecture.md`, "Circle's payout is a hard gate"). `e2e-usdcx.yml:161-168` orders its own Arc and L2 jobs the same way. |
| Selecting a chain (user, 2026-10-17) | The executor spec defines one test per source (a loop over `L2_BRIDGE_IN_SOURCES`, as `usdcx-in-l2.spec.ts` does) and, when `USDCX_LIVE_SOURCE` is set, only the one it names by its wallet-config slug, which each matrix entry sets; a slug that names no source fails the file at load. The spec file is `usdcx-live-executor-deposit.ios.spec.ts`, which the Arc job's filter `usdcx-live-deposit.ios` does not match. The dispatch input `legs` is `all`, `arc`, `base-sepolia`, `arbitrum-sepolia` or `sepolia` | A branch dispatch spends only what it tests; no other chain's preflight reads the key in a job; a typo fails loudly, naming the slug, instead of running nothing. |
| Signing key | `USDCX_LIVE_EVM_PRIVATE_KEY` (0x9336e3F0B913C4316Fc75918fDb88aA5e1fe49Dc) | The CI harness key's L2 balances are delta-proved by `usdcx-burn-l2` under another concurrency group and the docs forbid sharing it with the iOS job (`e2e-usdcx.yml:19-20`). |
| Full or lean scope | Full: the deposit leg plus the burn half back to the key on each source chain (2 USDCx to Ethereum Sepolia, whose 1.5 USDC payout fee allowance takes 1 USDCx whole, `usdcx-constants.ts:222-234`) | The decision profile records "build the live bridge-in suite at FULL scope ... over the lean cut" (2026-10-16), and each burn refills the key's USDC on its chain every green run. |
| Session chains (user, 2026-10-17) | Each counterparty approves its source chain alone: `eip155:84532`, `eip155:421614` or `eip155:11155111` | `prepareNativeSessionChain` passes on its first read (`src/lib/walletconnect/native.ts:268-271`), and the Sign SDK refuses a request for any other chain before the key sees it. The add/switch-chain path stays untested (usdcx-ios scout 2.4). |
| Ethereum Sepolia (user, 2026-10-17) | The counterparty's sender signs through `sendSigned`, which holds the tip to `ETHEREUM_SEPOLIA_PAYOUT.maxPriorityFeeCap` (0.01 gwei, `capPriorityFee`), as the Chrome sender does (#1508); the executor spec's preflight refuses a key with no Sepolia USDC, naming Circle's fixed mint gas limit, as the Chrome runner's `probeSepoliaPayoutKey` does | Sepolia's tip oracle follows signers who bid up to 1.5 gwei (`usdcx-constants.ts:222-234`); Circle's forwarder mints a Sepolia payout under a fixed 250,000 gas limit, which a mint to an address with no USDC exceeds (`scripts/e2e-real.mjs:1488-1516`). |
| Product flag `MIDEN_E2E_USDCX_CHAIN` | Kept; only the fork spec, its helper and the workflow env lines go | Five vite defines, `constant.ts:18` and the runner's refusal stay harmless; removing them is product churn this PR does not need (usdcx-ios scout section 7, open decision 4). |
| Where checks run (user, 2026-10-17) | Global Constraints, first line | The user's rule, written as given. |
| Review | Superpowers per-task and final reviews only | The decision profile records "dont run council. just merge it" for a harness PR (2026-10-16); the controller decides whether a review-council pass runs before the merge. |

## Review Focus

1. A Reown session that approves one source chain while the deposit screen still points at Arc Testnet (its testnet default, `src/lib/usdcx/constant.ts:225-240`): the network pick must be proven before the amount step by the row naming the chain exactly, since "Sepolia" is part of "Base Sepolia" and "Arbitrum Sepolia", or `prepareNativeSessionChain` refuses with the reconnect message and the run reads as a wallet failure. Pinned by Task 7's `selectBridgeNetwork` and `networkRowNames` tests.
2. A load-balanced RPC answering the burn's gas estimate from a node behind the approve, or a stale `pending` nonce for the burn: the sender must count the nonce locally and simulate and estimate the second send at or after the first one's block. Pinned by Task 5's tests (one nonce read, nonces 7 and 8, the second call at the pin, the pin at the receipt block when the head lags).
3. Ethereum Sepolia's tip oracle bidding up to 1.5 gwei: the counterparty's sender must hold the tip to the chain's 0.01 gwei cap, as the Chrome sender does, or each run costs about 0.0013 ETH (`usdcx-constants.ts:222-227`) of a key that holds 0.0005 ETH there. Pinned by Task 5's tip cases.
4. A key with no Ethereum Sepolia USDC: Circle's forwarder can never mint the burn half's payout to it, so the run must refuse before it spends anything, naming why and not suggesting that a green run refills it. Pinned by Task 6's `payoutKeyProblem` tests and Task 9's preflight pin.
5. A finished test's counterparty still attached to a shared Reown Core and answering the next test's app (the bridge-in "retry-only pass" flake, suite scout 4.2). Pinned by Task 2's tests (distinct `customStoragePrefix`, no answer and no listener once stopped).

---

## File Structure

| File | Task | Responsibility |
|---|---|---|
| `playwright/e2e/ios/tests/bridge-in-receive.ios.spec.ts` (delete) | 1 | Retired: its row came from an E2E hook |
| `src/lib/miden/activity/bridge-in-test-hooks.ts` (modify) | 1, 4 | The hook makes USDCx rows only; state reads report the forwarded CCTP leg |
| `src/lib/miden/activity/bridge-in-test-hooks.test.ts` (modify) | 1, 4 | Callers pass no provider; CCTP leg reported |
| `playwright/e2e/ios/helpers/ios-wallet-page.ts` (modify) | 1, 7 | `createBridgeReceive` gone; network picker; payout-chain burn; details links |
| `playwright/e2e/docs/e2e-architecture.md` (modify) | 1, 10, 13 | The iOS group's list; the executor jobs and the iOS key on three chains; Bridge-IN status |
| `CHANGELOG.md` (modify) | 1, 10, 11, 13 | One `[FIX][ci]` line per part, folded into one at Delivery D6a |
| `playwright/e2e/ios/helpers/wc-counterparty-request.ts` (create) | 2 | Pure: parse and guard one `eth_sendTransaction`; session namespaces |
| `playwright/e2e/ios/helpers/wc-counterparty-request.test.ts` (create) | 2 | Guard and namespace tests |
| `playwright/e2e/ios/helpers/wc-counterparty.ts` (modify) | 2 | Own Core per instance, stopped means silent, session chains, send hook |
| `playwright/e2e/ios/helpers/wc-counterparty.test.ts` (create) | 2 | Isolation, stop and send-hook tests with a fake SignClient |
| `src/screens/send-flow/SelectAmount.tsx` (modify), `SelectAmount.test.tsx` (modify) | 3 | `data-testid="bridge-network-selector"` |
| `playwright/e2e/helpers/bridge.ts` (modify), `bridge.test.ts` (modify) | 4 | Parser keeps `cctpForwarded`, `cctpForwardFee` |
| `playwright/e2e/helpers/l2-sender.ts` (create), `l2-sender.test.ts` (create) | 5 | Counterparty-side sender on an executor source chain, tip held to the chain's cap |
| `playwright/e2e/helpers/usdcx-executor-requests.ts` (create), `.test.ts` (create) | 6 | Gates on what the wallet asked the key to sign, on any source chain |
| `playwright/e2e/helpers/usdcx-cctp-proof.ts` (modify) | 6 | `confirmL2Burn` takes the four fields it reads |
| `playwright/e2e/helpers/usdcx-l2-deposit.ts` (modify), `.test.ts` (modify) | 6 | `l2KeyShortfall` takes the key's own refill hint; `payoutKeyProblem` refuses a key Circle cannot pay on Ethereum Sepolia |
| `playwright/e2e/ios/helpers/ios-wallet-page.test.ts` (modify) | 7 | Network picker, `networkRowNames`, payout-chain burn, details links |
| `playwright/e2e/ios/helpers/usdcx-live.ts` (create) | 8 | Shared iOS live pieces: ledger read, Guardian check, evidence, the burn half |
| `playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts` (modify) | 7, 8 | `txLinks`; calls the shared helper; deposit leg unchanged |
| `playwright/e2e/harness/usdcx-live-spec.test.ts` (modify) | 8, 9 | Pins for the Arc spec, the shared burn half and the executor spec |
| `playwright/e2e/ios/tests/usdcx-live-executor-deposit.ios.spec.ts` (create) | 9 | One live executor-route deposit and burn back per source chain |
| `.github/workflows/e2e-usdcx-live.yml` (modify) | 10 | Executor matrix job, `legs` input, per-job spec filters |
| `playwright/e2e/harness/usdcx-live-workflow.test.ts` (modify) | 10 | Both guards, the key-reading steps, order, the matrix against `L2_BRIDGE_IN_SOURCES`, filters |
| `playwright/e2e/harness/linked-pr-injection.test.ts` (modify) | 10 | The executor job's ceiling line |
| `playwright.ios.usdcx-live.config.ts` (modify) | 10 | Comment: two specs, each in jobs of its own |
| `playwright/e2e/ios/tests/bridge-in-deposit-usdcx.ios.spec.ts`, `playwright/e2e/ios/helpers/xreserve-fork.ts` (delete) | 11 | Retired fork spec |
| `.github/workflows/e2e-bridge-in.yml` (modify) | 11, 12, 13 | Header, fork env gone, retries input, blocking |
| `playwright/e2e/ios/tests/bridge-in-deposit-epoch.ios.spec.ts` (modify) | 12 | Polls the Compact deposit count |
| `playwright.ios.bridge-in.config.ts` (modify) | 12 | `maxFailures: 0` |
| `playwright/e2e/harness/bridge-in-workflow.test.ts` (create) | 12, 13 | Retries input, every spec runs, then blocking |

---

### Task 1: Retire the AggLayer receive spec; the E2E hook makes USDCx rows only

**Why:** the user's rule of 2026-10-17: every bridge-in spec takes the UI route production uses, and none makes a bridge row through an E2E hook. `bridge-in-receive.ios.spec.ts` makes its AggLayer row through `__TEST_CREATE_BRIDGE_RECEIVE__` (`:53-67`), which has thrown `AggLayer recovery values are required` on every attempt since #1453 made a route required (`src/lib/miden/transaction/initiate.ts:828-831`; receive scout, CI history, 16 of 16). The AggLayer deposit spec makes the same kind of row through the real deposit screen and a real Reown pairing, then the wallet consumes a real Miden note and reconciles the row to `received`, and it already asserts everything the receive spec does:

| The receive spec checks | The deposit spec checks it on a UI-made row |
|---|---|
| A tracking row exists (`bridge-in-receive.ios.spec.ts:66`) | `bridge-in-deposit.ios.spec.ts:149-150`: `latestBridgeReceive('agglayer')` is not null |
| The row is `delivering` before the note arrives (the hook moves it there, `bridge-in-test-hooks.ts:118-124`) | `:155-160`: polled to `delivering` after the real receipt |
| The solver's note of the tracked wei scaled by `TEST_NATIVE_ETH_SCALE` is claimed through Claim-All (`:69-77`) | `:152-153, :163-170`: the row's amount, the same scale, the same mint and Claim-All |
| The row reaches `received` within 120 s and reads `Bridged from EVM` (`:79-88`) | `:172-181`: the same poll and the same tag |

So nothing moves into the deposit spec, which also decodes the `bridgeAsset` calldata and proves the stub executed it (`:117-144`). Without the receive spec the hook's only callers are the Chrome `createUsdcxBridgeReceive` (`playwright/e2e/helpers/bridge.ts:560-572`, always `provider: 'usdcx'`, used by `usdcx-in-l2.spec.ts:188` and `usdcx-roundtrip.spec.ts:193, :202`) and the hook's own unit tests, all USDCx (`git grep` at `fd614122d`, Android harness included), so its `provider` argument and the `outputAmount` and `outputSymbol` that no remaining caller passes go, and `sourceChainId`, which every remaining caller passes, becomes required. The Chrome suites stay as they are (Decisions: the extension cannot pair with Reown).

**Files:**
- Delete: `playwright/e2e/ios/tests/bridge-in-receive.ios.spec.ts`
- Modify: `playwright/e2e/ios/helpers/ios-wallet-page.ts:411-426` (delete `createBridgeReceive` and the blank line after it)
- Modify: `src/lib/miden/activity/bridge-in-test-hooks.ts:10-22` (module doc), `:24-44` (argument type), `:70` (global type), `:111-117` (hook argument type and body)
- Test: `src/lib/miden/activity/bridge-in-test-hooks.test.ts:90, :165` (the two `provider: 'usdcx',` lines)
- Modify: `playwright/e2e/docs/e2e-architecture.md:345`
- Modify: `CHANGELOG.md` (append under `## 1.17.5 (TBD)` -> `### Fixes`)

**Interfaces:**
- Produces: `__TEST_CREATE_BRIDGE_RECEIVE__(args: CreateUsdcxBridgeReceiveArgs): Promise<string>`, with `CreateUsdcxBridgeReceiveArgs` = `{ accountId: string; amount: string; faucetId: string; sourceChainId: number; sourceAddress: string; sourceAmount: string; sourceSymbol: string; evmTxHash: string; usdcxRemoteRecipient?: string; cctp?: Pick<IUsdcxCctpLeg, 'sourceDomain' | 'forwarded' | 'forwardFee'> }`; the row is always `provider: 'usdcx'`. After this task `BridgeReceiveDepositFields` is at `bridge-in-test-hooks.ts:41-51` and `depositFields` at `:85-95` (Task 4 edits both).
- Removes: `IosWalletPage.createBridgeReceive`. The page object loses 16 lines at `:411-426`, so every `ios-wallet-page.ts` line at or after `:427` that Task 7 names is given after this deletion.

No new test: this task deletes a spec and narrows an argument type. The hook's suite passes as before once its two callers drop `provider`, and CI's `tsc` checks every typed caller; Chrome's helper reaches the hook through `evaluate`, untyped, and keeps working because the hook sets the provider itself. So the deliberate red push is Task 2's (Global Constraints).

- [ ] **Step 1: Confirm the callers**

Run: `git grep -n -w -e '__TEST_CREATE_BRIDGE_RECEIVE__' -e 'createBridgeReceive' -e 'bridge-in-receive' -- . ':!docs/superpowers'`
Expected (at `fd614122d`): `playwright/e2e/helpers/bridge.ts:557, :562, :564, :569` (`createUsdcxBridgeReceive`), `playwright/e2e/ios/helpers/ios-wallet-page.ts:412, :424`, `playwright/e2e/ios/tests/bridge-in-receive.ios.spec.ts:54`, `src/lib/miden/activity/bridge-in-test-hooks.test.ts:86, :161` and `src/lib/miden/activity/bridge-in-test-hooks.ts:70, :106`, nothing else. Any other hit stops the task: read it and fold its change into this task.

- [ ] **Step 2: Delete the spec and its page helper**

```bash
git rm playwright/e2e/ios/tests/bridge-in-receive.ios.spec.ts
```

In `playwright/e2e/ios/helpers/ios-wallet-page.ts`, delete `:411-426`: the doc comment that starts `/** Create a`, the method `createBridgeReceive` through its closing `  }`, and the blank line after it, so the doc comment of `getBridgeReceiveState` follows `hexToBech32Faucet`'s closing `  }` after one blank line. `stashAndPoll`, `hexToBech32Faucet` and `setAgglayerSender` stay: the AggLayer and Epoch deposit specs use them.

- [ ] **Step 3: Narrow the hook to USDCx rows**

Line numbers in this step are the file's at `fd614122d`, before any edit here; each edit also names its text, so apply them from the bottom up or by the text (the first two replacements move every later line up 6).

In `src/lib/miden/activity/bridge-in-test-hooks.ts`, replace the module doc comment `:10-22` (from `/**` above `* E2E-only service-worker hooks for the bridge-IN localnet harness.` through its ` */`) with:

```ts
/**
 * E2E-only hooks for the bridge-IN harnesses, installed ONLY under `MIDEN_E2E_TEST` (the extension's service worker
 * from `back/main.ts`, the mobile app from `intercom/mobile-adapter.ts`), so this whole module (and the globals it
 * defines) is dead-stripped from production builds.
 *
 * Every iOS bridge-in row comes from the real deposit screen. These hooks supply what a spec cannot reach through the
 * UI: a `usdcx` tracking row for the Chrome USDCx suites, which sign their deposit in Node because the extension cannot
 * pair with Reown under its cross-origin isolation; the AggLayer sender-match pointed at a runtime-created solver
 * account; the Reown pairing URI and state; and reads of a row's state.
 */
```

Replace `interface CreateBridgeReceiveArgs { ... }` (`:24-44`) with:

```ts
interface CreateUsdcxBridgeReceiveArgs {
  accountId: string;
  amount: string; // base units (bigint as string across the evaluate boundary)
  faucetId: string;
  /** Stored on the row, which reads its USDCx route and Miden domain for this chain. */
  sourceChainId: number;
  sourceAddress: string;
  sourceAmount: string;
  sourceSymbol: string;
  /** The deposit's EVM hash; the row is moved to `delivering` with it, as the deposit screen does after its EVM tx. */
  evmTxHash: string;
  /**
   * An executor-route deposit signed outside the deposit screen: what runUsdcxExecutorDeposit (usdcx/executor.ts) wrote on
   * its `submitting` step. Without the forwarded CCTP leg the reconciler never asks Circle about the burn.
   */
  usdcxRemoteRecipient?: string;
  cctp?: Pick<IUsdcxCctpLeg, 'sourceDomain' | 'forwarded' | 'forwardFee'>;
}
```

At `:70`, change `(args: CreateBridgeReceiveArgs) => Promise<string>` to `(args: CreateUsdcxBridgeReceiveArgs) => Promise<string>`.

At `:111`, change `}: CreateBridgeReceiveArgs) => {` to `}: CreateUsdcxBridgeReceiveArgs) => {`, and replace `:112-117` (from `    // A USDCx row reads the document's source route and Miden domain. A profile that never stored a document has` through `      () => initiateBridgedReceiveTransaction({ ...args, amount: BigInt(args.amount) }),`) with:

```ts
    // The row reads the document's source route and Miden domain. A profile that never stored a document has nothing
    // to hydrate, and initBridgeConfig never waits for the network, so this waits for the first document.
    await ensureBridgeConfig();
    let advanced: Promise<void> | undefined;
    const txId = await startBridgeReceiveSubmission(
      // A USDCx row whatever the caller sends: every other provider's row comes from the deposit screen alone.
      () => initiateBridgedReceiveTransaction({ ...args, provider: 'usdcx', amount: BigInt(args.amount) }),
```

`IBridgeProvider` stays imported: `__TEST_LATEST_BRIDGE_RECEIVE__` filters by it.

In `src/lib/miden/activity/bridge-in-test-hooks.test.ts`, delete the line `    provider: 'usdcx',` in `createArcReceive` (`:90`) and in `createExecutorReceive` (`:165`): the argument type no longer has the field, and an object literal with it is a TypeScript error.

- [ ] **Step 4: Docs and CHANGELOG**

In `playwright/e2e/docs/e2e-architecture.md`, replace line `:345` (`Bridge-in via the two routes, a WalletConnect-pairing-only check, a delivery-only check, and the guardian flow` ...) with:

```markdown
Bridge-in via the two routes through the real deposit screen, a Reown-pairing-only check, and the guardian flow, all on iPhone. (An Android two-emulator harness also exists in the codebase, not yet wired into CI.)
```

Append to the end of `### Fixes` under `## 1.17.5 (TBD)` in `CHANGELOG.md`:

```markdown
- [FIX][ci] E2E Bridge-IN no longer runs its AggLayer receive spec, which made its tracking row through an E2E hook and had failed every run since #1453; the AggLayer deposit spec checks everything it did on a row the real deposit screen makes, and the hook now makes only the USDCx rows the extension's Node-signed suites need.
```

- [ ] **Step 5: Run the hook's suite and its directory**

Run: `yarn jest src/lib/miden/activity/bridge-in-test-hooks.test.ts --maxWorkers=1`
Expected: PASS, 6 tests.
Then run: `yarn jest src/lib/miden/activity --maxWorkers=1`
Expected: PASS.
Run again: `git grep -n -w -e '__TEST_CREATE_BRIDGE_RECEIVE__' -e 'createBridgeReceive' -e 'bridge-in-receive' -- . ':!docs/superpowers'`
Expected: only `playwright/e2e/helpers/bridge.ts` and the hook and its test.

- [ ] **Step 6: Format, lint, dash check, commit (no push: Task 2 Step 3 pushes it with the red-before)**

```bash
F="src/lib/miden/activity/bridge-in-test-hooks.ts src/lib/miden/activity/bridge-in-test-hooks.test.ts playwright/e2e/ios/helpers/ios-wallet-page.ts"
git fetch --tags && git tag --list 'v*' --sort=-v:refname | grep -v rc | head -1   # expect v1.17.4
yarn prettier --check ${=F}
yarn eslint --max-warnings 0 ${=F}
git diff -U0 HEAD -- ${=F} CHANGELOG.md playwright/e2e/docs/e2e-architecture.md | perl -CSD -ne 'print if /^\+.*[\x{2013}\x{2014}]/'
git add ${=F} CHANGELOG.md playwright/e2e/docs/e2e-architecture.md
git commit -m "bridge-in e2e: retire the hook-made receive spec, the hook makes usdcx rows only"
```

(`${=F}` splits the list in zsh; `git rm` in Step 2 already staged the deletion.) Expected: prettier and eslint clean, no dash output (the old line `:345` carried an em dash; the new one does not).

---

### Task 2: Counterparty: its own Reown Core, silent once stopped, chosen session chains, a guarded send hook

**Why:** `WcCounterparty.start()` calls `SignClient.init` with no `customStoragePrefix` (`playwright/e2e/ios/helpers/wc-counterparty.ts:105-114`). In `@walletconnect/core` 2.23.7 a second Core in one process reuses the global one cached under `_walletConnectCore_${customStoragePrefix || ''}` (checked in `node_modules/@walletconnect/core/dist/index.cjs`), and `stop()` never removes the listeners (`:256-268`). Suite scout 4.2: outside the #1453 window, the first counterparty in a worker failed 0 of 22 attempts and later ones 22 of 41, and in two inspected attempts the app got a hash while the new instance logged nothing. **[I]** The previous test's instance answered. The live executor jobs also need the counterparty to approve their source chain alone and to hand each transaction to a sender that checks chain and `from` (usdcx-ios scout section 4). This task carries the deliberate red push (Global Constraints): its tests are the first that fail at `fd614122d`.

**Files:**
- Create: `playwright/e2e/ios/helpers/wc-counterparty-request.ts`
- Create: `playwright/e2e/ios/helpers/wc-counterparty-request.test.ts`
- Modify (whole file below): `playwright/e2e/ios/helpers/wc-counterparty.ts`
- Create: `playwright/e2e/ios/helpers/wc-counterparty.test.ts`

**Interfaces:**
- Produces: `interface CounterpartyTransaction { to: Address; data: Hex; value: bigint }`; `parseSendRequest(request: { chainId?: string; params: unknown }, expected: { chainId: number; from: Address }): CounterpartyTransaction` (throws a message ending in `refused`); `sessionNamespaces(chainIds: readonly number[], address: Address)`.
- Produces: `WcCounterpartyOptions` gains `sessionChainIds?: readonly number[]` (default `[11155111, 5042002]`, as today) and `send?: (tx: CounterpartyTransaction, signal: AbortSignal) => Promise<Hash>`. `WcRequestLog` gains `chainId?: string`. Default behaviour for the Anvil specs is unchanged apart from the isolation.

- [ ] **Step 1: Write the failing tests for the pure request module**

Create `playwright/e2e/ios/helpers/wc-counterparty-request.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { privateKeyToAccount } from 'viem/accounts';

import { parseSendRequest, sessionNamespaces } from './wc-counterparty-request';

const { address: KEY_ADDRESS } = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
);
const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const EXPECTED = { chainId: 84532, from: KEY_ADDRESS };
const send = (chainId: string | undefined, tx: Record<string, unknown>) => ({ chainId, params: [tx] });

describe('parseSendRequest', () => {
  it('takes a transaction for its chain from its key, in any address case, with the value as a bigint', () => {
    expect(
      parseSendRequest(
        send('eip155:84532', { from: KEY_ADDRESS.toLowerCase(), to: BASE_USDC, data: '0x095ea7b3', value: '0x0' }),
        EXPECTED
      )
    ).toEqual({ to: BASE_USDC, data: '0x095ea7b3', value: 0n });
  });

  it('reads a missing value as zero', () => {
    expect(parseSendRequest(send('eip155:84532', { from: KEY_ADDRESS, to: BASE_USDC, data: '0x01' }), EXPECTED)).toEqual(
      { to: BASE_USDC, data: '0x01', value: 0n }
    );
  });

  it.each([
    ['another chain', send('eip155:5042002', { from: KEY_ADDRESS, to: BASE_USDC, data: '0x01' }), 'eip155:5042002'],
    ['no chain', send(undefined, { from: KEY_ADDRESS, to: BASE_USDC, data: '0x01' }), 'no chain'],
    [
      'another sender',
      send('eip155:84532', { from: '0x000000000000000000000000000000000000dEaD', to: BASE_USDC, data: '0x01' }),
      'from 0x000000000000000000000000000000000000dEaD'
    ],
    ['no target', send('eip155:84532', { from: KEY_ADDRESS, data: '0x01' }), 'to undefined'],
    ['no calldata', send('eip155:84532', { from: KEY_ADDRESS, to: BASE_USDC, data: '0x' }), 'without calldata'],
    ['a value that is not hex', send('eip155:84532', { from: KEY_ADDRESS, to: BASE_USDC, data: '0x01', value: 5 }), 'value 5']
  ])('refuses %s, naming it', (_case, request, named) => {
    expect(() => parseSendRequest(request, EXPECTED)).toThrow(named);
    expect(() => parseSendRequest(request, EXPECTED)).toThrow(/refused$/);
  });
});

describe('sessionNamespaces', () => {
  it('approves exactly the chains given, for the key', () => {
    expect(sessionNamespaces([84532], KEY_ADDRESS)).toEqual({
      eip155: {
        chains: ['eip155:84532'],
        methods: ['eth_sendTransaction', 'personal_sign', 'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v4'],
        events: ['chainChanged', 'accountsChanged'],
        accounts: [`eip155:84532:${KEY_ADDRESS}`]
      }
    });
  });
});
```

- [ ] **Step 2: Write the failing tests for the counterparty**

Create `playwright/e2e/ios/helpers/wc-counterparty.test.ts`:

```ts
/**
 * @jest-environment node
 */
import type { Hash } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { WcCounterparty } from './wc-counterparty';

type Listener = (event: unknown) => Promise<void> | void;

interface FakeClient {
  options: Record<string, unknown>;
  listeners: Map<string, Set<Listener>>;
  approvals: unknown[];
  responses: unknown[];
}

const mockClients: FakeClient[] = [];

// The real SignClient opens a relay socket; this one records what the counterparty asks of it.
jest.mock('@walletconnect/sign-client', () => ({
  __esModule: true,
  default: {
    init: async (options: Record<string, unknown>) => {
      const fake: FakeClient = { options, listeners: new Map(), approvals: [], responses: [] };
      mockClients.push(fake);
      return {
        on: (event: string, listener: Listener) => {
          const set = fake.listeners.get(event) ?? new Set<Listener>();
          set.add(listener);
          fake.listeners.set(event, set);
        },
        off: (event: string, listener: Listener) => {
          fake.listeners.get(event)?.delete(listener);
        },
        approve: async (args: unknown) => {
          fake.approvals.push(args);
          return { topic: 'topic-1', acknowledged: async () => undefined };
        },
        respond: async (args: unknown) => {
          fake.responses.push(args);
        },
        pair: async () => undefined,
        disconnect: async () => undefined,
        core: { relayer: { transportClose: async () => undefined } }
      };
    }
  }
}));

// The real builder intersects the app's proposal with what the counterparty supports; what it supports is under test.
jest.mock('@walletconnect/utils', () => ({
  buildApprovedNamespaces: ({ supportedNamespaces }: { supportedNamespaces: unknown }) => supportedNamespaces
}));

const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const { address: KEY_ADDRESS } = privateKeyToAccount(KEY);
const BASE_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const HASH: Hash = `0x${'ab'.repeat(32)}`;

const request = (chainId: string, method: string, params: unknown, id = 1) => ({
  topic: 'topic-1',
  id,
  params: { chainId, request: { method, params } }
});

async function emit(client: FakeClient | undefined, event: string, payload: unknown): Promise<void> {
  for (const listener of [...(client?.listeners.get(event) ?? [])]) await listener(payload);
}

beforeEach(() => {
  mockClients.length = 0;
});

it('gives each counterparty a Reown Core of its own', async () => {
  await new WcCounterparty().start();
  await new WcCounterparty().start();

  const prefixes = mockClients.map(client => String(client.options.customStoragePrefix));
  expect(new Set(prefixes).size).toBe(2);
  for (const prefix of prefixes) expect(prefix).toMatch(/^wc-counterparty-[0-9a-f-]{36}$/);
});

it("answers nothing once stopped, so a finished test's counterparty never answers the next test's app", async () => {
  const cp = new WcCounterparty();
  await cp.start();
  const [client] = mockClients;
  const handlers = [...(client?.listeners.get('session_request') ?? [])];

  await cp.stop();
  for (const handler of handlers) await handler(request('eip155:11155111', 'personal_sign', ['0x68656c6c6f', KEY_ADDRESS]));

  expect(client?.listeners.get('session_request')?.size ?? 0).toBe(0);
  expect(client?.listeners.get('session_proposal')?.size ?? 0).toBe(0);
  expect(client?.responses).toEqual([]);
  expect(cp.requests).toEqual([]);
});

it('approves only the session chains it was given', async () => {
  const cp = new WcCounterparty({ privateKey: KEY, chainId: 84532, rpcUrl: 'https://l2.example', sessionChainIds: [84532] });
  await cp.start();

  await emit(mockClients[0], 'session_proposal', { id: 7, params: {} });

  expect(mockClients[0]?.approvals).toEqual([
    {
      id: 7,
      namespaces: {
        eip155: expect.objectContaining({ chains: ['eip155:84532'], accounts: [`eip155:84532:${KEY_ADDRESS}`] })
      }
    }
  ]);
});

describe('with a send hook', () => {
  const setUp = async () => {
    const send = jest.fn(async () => HASH);
    const cp = new WcCounterparty({
      privateKey: KEY,
      chainId: 84532,
      rpcUrl: 'https://l2.example',
      sessionChainIds: [84532],
      send
    });
    await cp.start();
    return { cp, send, client: mockClients[0] };
  };

  it('sends a transaction for its own chain and key and answers with the hash', async () => {
    const { cp, send, client } = await setUp();

    await emit(
      client,
      'session_request',
      request('eip155:84532', 'eth_sendTransaction', [
        { from: KEY_ADDRESS.toLowerCase(), to: BASE_USDC, data: '0x095ea7b3', value: '0x0' }
      ])
    );

    expect(send).toHaveBeenCalledWith({ to: BASE_USDC, data: '0x095ea7b3', value: 0n }, expect.any(AbortSignal));
    expect(client?.responses).toEqual([{ topic: 'topic-1', response: { id: 1, jsonrpc: '2.0', result: HASH } }]);
    expect(cp.requests).toEqual([
      expect.objectContaining({ method: 'eth_sendTransaction', chainId: 'eip155:84532', result: HASH })
    ]);
  });

  it.each([
    [
      'a transaction for another chain',
      request('eip155:5042002', 'eth_sendTransaction', [{ from: KEY_ADDRESS, to: BASE_USDC, data: '0x01' }]),
      'not eip155:84532'
    ],
    ['a message to sign', request('eip155:84532', 'personal_sign', ['0x68656c6c6f', KEY_ADDRESS]), 'signs no message']
  ])('refuses %s without sending, and says why', async (_case, event, why) => {
    const { cp, send, client } = await setUp();

    await emit(client, 'session_request', event);

    expect(send).not.toHaveBeenCalled();
    expect(client?.responses).toEqual([
      { topic: 'topic-1', response: { id: 1, jsonrpc: '2.0', error: { code: 5000, message: expect.stringContaining(why) } } }
    ]);
    expect(cp.requests[0]?.error).toContain(why);
  });
});
```

- [ ] **Step 3: Run them to verify they fail, then make the deliberate red push**

Run: `yarn jest playwright/e2e/ios/helpers/wc-counterparty-request.test.ts playwright/e2e/ios/helpers/wc-counterparty.test.ts --maxWorkers=1`
Expected: FAIL. The request test cannot resolve `./wc-counterparty-request`; in the counterparty test the isolation case reads `undefined` prefixes, the stop case finds both listeners still registered, the session case approves two chains, and the send-hook cases call the viem wallet client instead.

Commit the tests alone and push them with Task 1's commit; the push opens the PR:

```bash
F="playwright/e2e/ios/helpers/wc-counterparty-request.test.ts playwright/e2e/ios/helpers/wc-counterparty.test.ts"
yarn prettier --check ${=F}
perl -CSD -ne 'print "$ARGV:$.: $_" if /[\x{2013}\x{2014}]/' ${=F}
git add ${=F}
git commit -m "reown counterparty tests: own core, silent once stopped, session chains, send hook (expected to fail)"
git push -u origin wiktor/reown-bridge-in-e2e
gh pr create --repo 0xMiden/wallet --draft --base main --head wiktor/reown-bridge-in-e2e \
  --title "iOS bridge-in E2E: UI-only specs, live executor-route deposits from three chains, blocking suite" \
  --body "Draft. The first CI run is expected to fail in the two new Reown counterparty test files (red-before); the next commit makes them pass."
```

This is the one deliberate red push (the user's red-before rule). Record the PR number for the Delivery section. pr.yml cancels a PR's in-progress run when a newer commit arrives, so Step 8's push waits until this run has reported; Steps 4 and 5 are written meanwhile. Find and read the run by the commit, not the branch (agentic-kb `github-actions-push-sometimes-creates-no-runs`):

```bash
RED=$(git rev-parse HEAD)
gh run list --repo 0xMiden/wallet --workflow pr.yml --commit "$RED" --json databaseId,status,conclusion
# no run after 10 minutes: `gh pr close <n> --repo 0xMiden/wallet && gh pr reopen <n> --repo 0xMiden/wallet` re-fires pull_request
gh run watch <databaseId> --repo 0xMiden/wallet --exit-status; echo "exit $?"
gh run view <databaseId> --repo 0xMiden/wallet --log-failed | grep -E 'FAIL |Tests:|error TS|Cannot find module' | head -40
```

Expected: a non-zero exit. `Unit tests` stops at its TypeScript Check on `Cannot find module './wc-counterparty-request'` (TS2307) and on the `sessionChainIds` and `send` options `wc-counterparty.test.ts` passes, which `WcCounterpartyOptions` does not have yet (TS2353), and the `Coverage shard n/3` jobs, which run jest without `tsc`, show `FAIL` for exactly `wc-counterparty-request.test.ts` and `wc-counterparty.test.ts`, with the causes above; `yarn lint:e2e` may report the same unresolved import. No other suite fails, and `changelog.yml` is green (Task 1 added its line). Keep the run URL for the PR body (Delivery D1).

- [ ] **Step 4: Write the pure request module**

Create `playwright/e2e/ios/helpers/wc-counterparty-request.ts`:

```ts
import { hexToBigInt, isAddress, isAddressEqual, isHex, type Address, type Hex } from 'viem';

/** One transaction a counterparty was asked to sign, once parseSendRequest accepted it. */
export interface CounterpartyTransaction {
  to: Address;
  data: Hex;
  value: bigint;
}

/**
 * The transaction in an `eth_sendTransaction` session request, or an error naming why the key will not sign it: another
 * chain than the counterparty's, another sender, no target, no calldata or a value that is not hex. The address case
 * the app sends is not the checksum's, so addresses are compared without it.
 */
export function parseSendRequest(
  request: { chainId?: string; params: unknown },
  expected: { chainId: number; from: Address }
): CounterpartyTransaction {
  const chain = `eip155:${expected.chainId}`;
  if (request.chainId !== chain) {
    throw new Error(`eth_sendTransaction on ${request.chainId ?? 'no chain'}, not ${chain}: refused`);
  }
  const [tx] = Array.isArray(request.params) ? request.params : [];
  const field = (key: string): unknown => (tx !== null && typeof tx === 'object' ? Reflect.get(tx, key) : undefined);
  const from = field('from');
  const to = field('to');
  const data = field('data');
  const value = field('value');
  if (typeof from !== 'string' || !isAddress(from, { strict: false }) || !isAddressEqual(from, expected.from)) {
    throw new Error(`eth_sendTransaction from ${String(from)}, not the counterparty's ${expected.from}: refused`);
  }
  if (typeof to !== 'string' || !isAddress(to, { strict: false })) {
    throw new Error(`eth_sendTransaction to ${String(to)}: refused`);
  }
  if (!isHex(data) || data === '0x') throw new Error('eth_sendTransaction without calldata: refused');
  if (value !== undefined && !isHex(value)) throw new Error(`eth_sendTransaction value ${String(value)}: refused`);
  return { to, data, value: value === undefined ? 0n : hexToBigInt(value) };
}

/** The namespaces a counterparty approves: every chain in `chainIds` for `address`, with the methods it answers. */
export function sessionNamespaces(chainIds: readonly number[], address: Address) {
  return {
    eip155: {
      chains: chainIds.map(id => `eip155:${id}`),
      methods: ['eth_sendTransaction', 'personal_sign', 'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v4'],
      events: ['chainChanged', 'accountsChanged'],
      accounts: chainIds.map(id => `eip155:${id}:${address}`)
    }
  };
}
```

- [ ] **Step 5: Replace the counterparty**

Replace the whole of `playwright/e2e/ios/helpers/wc-counterparty.ts` with:

```ts
import SignClient from '@walletconnect/sign-client';
import { buildApprovedNamespaces } from '@walletconnect/utils';
import { randomUUID } from 'node:crypto';
import { type Chain, createWalletClient, defineChain, type Hash, http, numberToHex, type WalletClient } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';

import { resolveCounterpartyEnv } from './wc-counterparty-env';
import { parseSendRequest, sessionNamespaces, type CounterpartyTransaction } from './wc-counterparty-request';

/**
 * Headless Reown (WalletConnect v2) counterparty wallet for the iOS bridge-in harnesses.
 *
 * It plays the wallet side of the real handshake the app's native Reown starts: it
 * pairs off the `wc:` URI from the app's `connectUri` hook, approves a session for
 * a viem local account, and answers the app's `eth_sendTransaction`,
 * `personal_sign` and `eth_signTypedData` requests. By default it signs for and
 * broadcasts to a LOCAL Anvil; a live run passes its own chain, RPC and a `send`
 * that signs on that chain. The handshake and the signing are real; only the URI
 * delivery is local.
 *
 * Pairing rides the public relay (relay.walletconnect.org), using the
 * counterparty's own project id when WC_COUNTERPARTY_PROJECT_ID is set, else
 * config.ts's resolution of the test process's own env, so it is NOT hermetic
 * on the connection layer (by design: the same external dependency class as
 * bridge-out's hosted services).
 */

// The counterparty authenticates its OWN relay connection, independent of the
// app's: peers don't need to share a project id. A dedicated one
// (WC_COUNTERPARTY_PROJECT_ID) halves the per-project relay load; the trimmed,
// empty-as-unset resolution (and the RELAY_URL / ANVIL_RPC defaults) live in
// wc-counterparty-env.ts.
const { relayUrl: RELAY_URL, projectId: PROJECT_ID, anvilRpc: ANVIL_RPC } = resolveCounterpartyEnv();
const CHAIN_ID = 11155111;
// The app proposes every chain in SUPPORTED_CHAINS (src/lib/walletconnect/config.ts), so by default the session
// approves Arc Testnet too. Every request is still signed for and broadcast to the one local Anvil.
const ARC_TESTNET_CHAIN_ID = 5042002;
const DEFAULT_SESSION_CHAIN_IDS: readonly number[] = [CHAIN_ID, ARC_TESTNET_CHAIN_ID];
// Anvil's first deterministic dev account (pre-funded with 10000 ETH).
const DEFAULT_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const anvilChain = defineChain({
  id: CHAIN_ID,
  name: 'anvil-sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_RPC] } }
});

export interface WcRequestLog {
  method: string;
  /** The chain the app asked for, `eip155:<id>`. */
  chainId?: string;
  params: unknown;
  result?: unknown;
  error?: string;
}

export interface WcCounterpartyOptions {
  privateKey?: `0x${string}`;
  rpcUrl?: string;
  /**
   * The chain id of the node at `rpcUrl`, which every transaction is signed for.
   * Defaults to the local Anvil's (Sepolia's id). A live run passes its chain's id with that chain's RPC URL.
   */
  chainId?: number;
  /** The chains the session approves, of those the app proposes. Defaults to Sepolia and Arc Testnet. */
  sessionChainIds?: readonly number[];
  /**
   * Sends each transaction in place of the viem wallet client, once parseSendRequest accepted it for `chainId` and
   * the key. With it set every other method is refused, so a live key signs no message.
   */
  send?: (tx: CounterpartyTransaction, signal: AbortSignal) => Promise<Hash>;
}

type SessionProposal = { id: number; params: Parameters<typeof buildApprovedNamespaces>[0]['proposal'] };
type SessionRequest = {
  topic: string;
  id: number;
  params: { chainId: string; request: { method: string; params: unknown } };
};

export class WcCounterparty {
  readonly account: PrivateKeyAccount;
  private client?: Awaited<ReturnType<typeof SignClient.init>>;
  private wallet: WalletClient;
  private readonly chain: Chain;
  private readonly sessionChainIds: readonly number[];
  private readonly send?: WcCounterpartyOptions['send'];
  private readonly stopping = new AbortController();
  private stopped = false;
  private topic?: string;
  private connectedResolve!: () => void;
  /** Resolves once a session is approved (the app reports connected). */
  readonly connected: Promise<void>;
  /** Every session_request handled, for assertions. */
  readonly requests: WcRequestLog[] = [];

  constructor(opts: WcCounterpartyOptions = {}) {
    this.account = privateKeyToAccount(opts.privateKey ?? (DEFAULT_KEY as `0x${string}`));
    const rpcUrl = opts.rpcUrl ?? ANVIL_RPC;
    this.chain =
      opts.chainId === undefined
        ? anvilChain
        : defineChain({
            id: opts.chainId,
            name: `counterparty-${opts.chainId}`,
            nativeCurrency: { name: 'Native', symbol: 'NATIVE', decimals: 18 },
            rpcUrls: { default: { http: [rpcUrl] } }
          });
    this.wallet = createWalletClient({
      account: this.account,
      chain: this.chain,
      transport: http(rpcUrl)
    });
    this.sessionChainIds = opts.sessionChainIds ?? DEFAULT_SESSION_CHAIN_IDS;
    this.send = opts.send;
    this.connected = new Promise<void>(res => {
      this.connectedResolve = res;
    });
  }

  get address(): `0x${string}` {
    return this.account.address;
  }

  async start(): Promise<void> {
    if (this.client) return; // idempotent: connectWithRetry may call this too
    this.client = await SignClient.init({
      projectId: PROJECT_ID,
      relayUrl: RELAY_URL,
      // A Core of its own: without a prefix a second SignClient in one process reuses the first one's cached Core, and
      // a finished test's counterparty answered the next test's requests (E2E Bridge-IN's retry-only passes).
      customStoragePrefix: `wc-counterparty-${randomUUID()}`,
      metadata: {
        name: 'Bridge-in E2E Wallet',
        description: 'Headless Reown counterparty for the bridge-in harness',
        url: 'https://miden.io',
        icons: []
      }
    });
    this.client.on('session_proposal', this.onProposal);
    this.client.on('session_request', this.onRequest);
  }

  async pair(uri: string): Promise<void> {
    if (!this.client) throw new Error('the counterparty pairs only after start()');
    await this.client.pair({ uri });
  }

  /**
   * Robust connect: run the full Reown handshake (fetch a fresh `wc:` URI from the
   * app, pair, wait for the session to be approved, and confirm the app reports
   * connected) and retry the WHOLE handshake with backoff.
   *
   * The public relay rate-limits connection bursts and its subscribe can time out
   * ("Subscribing to <topic> failed, please try again"), which can hit the URI
   * fetch OR the pair/approve step. Retrying only the URI fetch left the subscribe
   * timeout fatal. A dedicated `WC_COUNTERPARTY_PROJECT_ID` (see the note at the
   * top of this file) is optional per-project load relief, never the fix; this
   * retry is what keeps the handshake resilient.
   */
  async connectWithRetry(
    getUri: () => Promise<string>,
    verifyAppConnected: () => Promise<boolean>,
    opts: { attempts?: number; backoffMs?: number; sessionTimeoutMs?: number } = {}
  ): Promise<void> {
    const { attempts = 5, backoffMs = 15_000, sessionTimeoutMs = 45_000 } = opts;
    await this.start();
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const uri = await getUri();
        if (!uri.startsWith('wc:')) throw new Error(`expected a wc: pairing URI, got "${uri}"`);
        await this.pair(uri);
        // The relay subscribe inside pair/approve can stall without erroring;
        // bound the wait so a stall triggers a retry instead of hanging.
        await Promise.race([
          this.connected,
          new Promise<never>((_, reject) =>
            setTimeout(
              () =>
                reject(new Error(`WC session not approved within ${sessionTimeoutMs}ms (relay subscribe timeout?)`)),
              sessionTimeoutMs
            )
          )
        ]);
        for (let poll = 0; poll < 30; poll++) {
          if (await verifyAppConnected()) return;
          await this.sleep(2000);
        }
        throw new Error('WC session approved but the app never reported connected');
      } catch (err) {
        lastErr = err;
        if (attempt === attempts) {
          throw new Error(
            `WalletConnect handshake failed after ${attempts} attempts (public relay subscribe/rate-limit): ${String(lastErr)}`
          );
        }
        await this.sleep(backoffMs);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private readonly onProposal = async (proposal: SessionProposal): Promise<void> => {
    const client = this.client;
    if (this.stopped || !client) return;
    try {
      const namespaces = buildApprovedNamespaces({
        proposal: proposal.params,
        supportedNamespaces: sessionNamespaces(this.sessionChainIds, this.account.address)
      });
      const { topic, acknowledged } = await client.approve({ id: proposal.id, namespaces });
      this.topic = topic;
      await acknowledged();
      this.connectedResolve();
    } catch (err) {
      console.error('[wc-counterparty] approve failed', err);
    }
  };

  private readonly onRequest = async (event: SessionRequest): Promise<void> => {
    const client = this.client;
    // A stopped counterparty answers nothing: the app's request belongs to whichever counterparty the test runs now.
    if (this.stopped || !client) return;
    const { topic, id, params } = event;
    const { method, params: rpcParams } = params.request;
    const log: WcRequestLog = { method, chainId: params.chainId, params: rpcParams };
    try {
      const result = await this.answer(method, params.chainId, rpcParams);
      log.result = result;
      this.requests.push(log);
      await client.respond({ topic, response: { id, jsonrpc: '2.0', result } });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error = message;
      this.requests.push(log);
      await client.respond({
        topic,
        response: { id, jsonrpc: '2.0', error: { code: 5000, message } }
      });
    }
  };

  private async answer(method: string, chainId: string, rpcParams: unknown): Promise<string> {
    if (this.send) {
      if (method !== 'eth_sendTransaction') throw new Error(`${method}: this counterparty signs no message`);
      const tx = parseSendRequest({ chainId, params: rpcParams }, { chainId: this.chain.id, from: this.account.address });
      return this.send(tx, this.stopping.signal);
    }
    if (method === 'eth_sendTransaction') {
      const tx = (rpcParams as Array<Record<string, string>>)[0];
      if (!tx) throw new Error('eth_sendTransaction: missing tx params');
      return this.wallet.sendTransaction({
        account: this.account,
        chain: this.chain,
        to: tx.to as `0x${string}`,
        data: (tx.data as `0x${string}`) ?? undefined,
        value: tx.value ? BigInt(tx.value) : undefined,
        gas: tx.gas ? BigInt(tx.gas) : undefined
      });
    }
    if (method === 'personal_sign' || method === 'eth_sign') {
      const arr = rpcParams as string[];
      const raw = (method === 'personal_sign' ? arr[0] : arr[1]) as `0x${string}`;
      return this.account.signMessage({ message: { raw } });
    }
    if (method.startsWith('eth_signTypedData')) {
      const arr = rpcParams as string[];
      const typed = typeof arr[1] === 'string' ? JSON.parse(arr[1]) : arr[1];
      return this.account.signTypedData(typed);
    }
    throw new Error(`unsupported method ${method}`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopping.abort(new Error('the counterparty stopped'));
    const client = this.client;
    if (!client) return;
    client.off('session_proposal', this.onProposal);
    client.off('session_request', this.onRequest);
    try {
      if (this.topic) {
        await client.disconnect({
          topic: this.topic,
          reason: { code: 6000, message: 'test complete' }
        });
      }
      await client.core.relayer.transportClose();
    } catch {
      /* best-effort cleanup */
    }
  }

  // Marker so `numberToHex` is retained for chainId responses if needed later.
  static chainIdHex = numberToHex(CHAIN_ID);
}
```

The `as` casts inside `answer` for the Anvil path are the file's own at `fd614122d` (`:221-238`), moved unchanged; no new assertion is added.

- [ ] **Step 6: Run them and their directory to verify they pass**

Run: `yarn jest playwright/e2e/ios/helpers --maxWorkers=1`
Expected: PASS, the two new files included, and `wc-counterparty-env.test.ts`, `ios-wallet-page.test.ts`, `evm-doubles.test.ts`, `fake-epoch-allocator.test.ts`, `system-alerts.test.ts` unchanged and PASS.

- [ ] **Step 7: Mutation checks**

One at a time, rerun `yarn jest playwright/e2e/ios/helpers/wc-counterparty.test.ts --maxWorkers=1` and restore after each:
1. Delete the `customStoragePrefix` line: the isolation case fails.
2. Delete `if (this.stopped || !client) return;` in `onRequest` and replace it with `if (!client) return;`: the stop case fails (a response is recorded).
3. Delete the two `client.off(...)` lines: the stop case fails (listener counts are 1).
4. In `answer`, delete the `if (method !== 'eth_sendTransaction') throw ...` line: the `a message to sign` case fails.

- [ ] **Step 8: Format, lint, dash check, commit, push**

```bash
F="playwright/e2e/ios/helpers/wc-counterparty.ts playwright/e2e/ios/helpers/wc-counterparty.test.ts playwright/e2e/ios/helpers/wc-counterparty-request.ts playwright/e2e/ios/helpers/wc-counterparty-request.test.ts"
yarn prettier --check ${=F}
yarn eslint --max-warnings 0 ${=F}
perl -CSD -ne 'print "$ARGV:$.: $_" if /[\x{2013}\x{2014}]/' ${=F}
git add ${=F}
git commit -m "reown counterparty: own core per instance, silent once stopped, session chains and a guarded send hook"
git push   # only once Step 3's red run has reported
```

(`${=F}` splits the list in zsh.) CI's run of this push must show the two new suites passing and `Unit tests` (ESLint, TypeScript Check, jest) green; that run is also the first `tsc` over Task 1.

---

### Task 3: Test id on the deposit amount step's network row

**Why:** the button that opens the bridge network drawer has no test id (`src/screens/send-flow/SelectAmount.tsx:192-197`), and the iOS page object has no way to pick a source chain (`playwright/e2e/ios/helpers/ios-wallet-page.ts:477-541`). The drawer's rows already carry `bridge-network-<slug>` (`src/app/templates/EvmConnectModal/EvmBridgeNetworkDrawer.tsx:49`).

**Files:**
- Modify: `src/screens/send-flow/SelectAmount.tsx:192-193`
- Test: `src/screens/send-flow/SelectAmount.test.tsx` (inside `describe('bridge variant', ...)` at `:539`)

**Interfaces:**
- Produces: `data-testid="bridge-network-selector"` on the network row of the bridge selector. Task 7 clicks it.

- [ ] **Step 1: Write the failing test**

In `src/screens/send-flow/SelectAmount.test.tsx`, after the test `'tolerates a missing network handler'` inside `describe('bridge variant', ...)`, add:

```tsx
    it('opens the network picker from its own test id', () => {
      const onSelectNetwork = jest.fn();
      renderComponent({ isBridge: true, network: sepolia, onSelectNetwork });

      fireEvent.click(screen.getByTestId('bridge-network-selector'));

      expect(onSelectNetwork).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('bridge-network-selector')).toHaveTextContent('Sepolia');
    });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `yarn jest src/screens/send-flow/SelectAmount.test.tsx -t 'opens the network picker from its own test id' --maxWorkers=1`
Expected: FAIL with `Unable to find an element by: [data-testid="bridge-network-selector"]`.

- [ ] **Step 3: Add the test id**

In `src/screens/send-flow/SelectAmount.tsx`, in the second `<button type="button"` of `bridgeSelector` (the one whose `onClick` calls `onSelectNetwork?.()`, `:192`), add the attribute right after `type="button"`:

```tsx
        data-testid="bridge-network-selector"
```

- [ ] **Step 4: Run the directory's tests**

Run: `yarn jest src/screens/send-flow --maxWorkers=1`
Expected: PASS.

- [ ] **Step 5: Format, lint, dash check, commit, push**

```bash
yarn prettier --check src/screens/send-flow/SelectAmount.tsx src/screens/send-flow/SelectAmount.test.tsx
yarn eslint --max-warnings 0 src/screens/send-flow/SelectAmount.tsx src/screens/send-flow/SelectAmount.test.tsx
perl -CSD -ne 'print "$ARGV:$.: $_" if /[\x{2013}\x{2014}]/' src/screens/send-flow/SelectAmount.tsx src/screens/send-flow/SelectAmount.test.tsx
git add src/screens/send-flow/SelectAmount.tsx src/screens/send-flow/SelectAmount.test.tsx
git commit -m "deposit amount step: test id on the network row"
git push
```

---

### Task 4: The hook and the harness parser report the forwarded CCTP leg

**Why:** the live gates need the fee the burn paid (`confirmL2Burn` checks a USDC debit of the amount plus that fee, `playwright/e2e/helpers/usdcx-cctp-proof.ts:168`), and on iOS the harness never sees the wallet's quote. `runUsdcxExecutorDeposit` records it on the row as `cctp.forwardFee` with `forwarded: true` (`src/lib/usdcx/executor.ts:353-357`), but the hook's state reads drop it (`src/lib/miden/activity/bridge-in-test-hooks.ts:91-101`) and so does the parser (`playwright/e2e/helpers/bridge.ts:601-635`).

**Files:**
- Modify: `src/lib/miden/activity/bridge-in-test-hooks.ts:41-51` (`BridgeReceiveDepositFields`), `:85-95` (`depositFields`), both after Task 1
- Test: `src/lib/miden/activity/bridge-in-test-hooks.test.ts` (append)
- Modify: `playwright/e2e/helpers/bridge.ts:576-635` (`BridgeReceiveStateSnapshot` `:576-592`, `parseBridgeReceiveState` `:601-635`)
- Test: `playwright/e2e/helpers/bridge.test.ts:139-172`

**Interfaces:**
- Produces: `__TEST_BRIDGE_RECEIVE_STATE__` and `__TEST_LATEST_BRIDGE_RECEIVE__` add `cctpForwarded?: boolean` and `cctpForwardFee?: string`; `BridgeReceiveStateSnapshot` adds the same two fields. Task 9 reads them.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/miden/activity/bridge-in-test-hooks.test.ts`:

```ts
it("reports an executor deposit's forwarded leg and the fee it paid", async () => {
  installBridgeInTestHooks();

  const id = await createExecutorReceive();

  expect(await globalThis.__TEST_BRIDGE_RECEIVE_STATE__(id)).toMatchObject({
    cctpForwarded: true,
    cctpForwardFee: SUBMITTED.cctp.forwardFee
  });
  expect(await globalThis.__TEST_LATEST_BRIDGE_RECEIVE__('usdcx')).toMatchObject({
    id,
    cctpForwarded: true,
    cctpForwardFee: SUBMITTED.cctp.forwardFee
  });
});
```

In `playwright/e2e/helpers/bridge.test.ts`, in `it('keeps every field the hook returns, typed', ...)`, add these two properties to BOTH the input object and the expected object, after `readyAt: 1791663100`:

```ts
        cctpForwarded: true,
        cctpForwardFee: '22404'
```

(remember the comma after `readyAt: 1791663100`).

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn jest src/lib/miden/activity/bridge-in-test-hooks.test.ts playwright/e2e/helpers/bridge.test.ts --maxWorkers=1`
Expected: FAIL. The hook case reads no `cctpForwarded`; the parser case returns an object without the two fields.

- [ ] **Step 3: Implement**

In `src/lib/miden/activity/bridge-in-test-hooks.ts`, add to `BridgeReceiveDepositFields` after `usdcxExecuteTxHash?: string;`:

```ts
  /** Whether the burn paid Circle's forward fee: what an executor-route deposit writes on its `submitting` step. */
  cctpForwarded?: boolean;
  /** The quoted fee that burn paid on top of the amount, in source USDC base units. */
  cctpForwardFee?: string;
```

and in `depositFields`, after `usdcxExecuteTxHash: inputs?.cctp?.executeTxHash`:

```ts
    usdcxExecuteTxHash: inputs?.cctp?.executeTxHash,
    cctpForwarded: inputs?.cctp?.forwarded,
    cctpForwardFee: inputs?.cctp?.forwardFee
```

In `playwright/e2e/helpers/bridge.ts`, add to `BridgeReceiveStateSnapshot` after `readyAt?: number;`:

```ts
  /** Whether the burn paid Circle's forward fee: an executor-route deposit's forwarded CCTP leg. */
  cctpForwarded?: boolean;
  /** The quoted fee that burn paid on top of the amount, source USDC base units. */
  cctpForwardFee?: string;
```

In `parseBridgeReceiveState`, after the `count` helper, add:

```ts
  const flag = (key: string): boolean | undefined => {
    const item = field(key);
    return typeof item === 'boolean' ? item : undefined;
  };
```

and in its returned object, after `readyAt: count('readyAt')`:

```ts
    readyAt: count('readyAt'),
    cctpForwarded: flag('cctpForwarded'),
    cctpForwardFee: text('cctpForwardFee')
```

- [ ] **Step 4: Run them and the hook's directory to verify they pass**

Run: `yarn jest src/lib/miden/activity playwright/e2e/helpers/bridge.test.ts --maxWorkers=1`
Expected: PASS.

- [ ] **Step 5: Format, lint, dash check, commit, push**

```bash
F="src/lib/miden/activity/bridge-in-test-hooks.ts src/lib/miden/activity/bridge-in-test-hooks.test.ts playwright/e2e/helpers/bridge.ts playwright/e2e/helpers/bridge.test.ts"
yarn prettier --check ${=F}
yarn eslint --max-warnings 0 ${=F}
perl -CSD -ne 'print "$ARGV:$.: $_" if /[\x{2013}\x{2014}]/' ${=F}
git add ${=F}
git commit -m "bridge-in e2e hook reports the forwarded cctp leg and its fee"
git push
```

---

### Task 5: L2 sender: one write endpoint, a local nonce, each send pinned after the previous one, the chain's tip cap

**Why:** today the counterparty signs every request through a viem wallet client on one URL, which reads the `pending` nonce and estimates gas and fees there for each send (`playwright/e2e/ios/helpers/wc-counterparty.ts:77-93, :220-230`). On the executor route the wallet asks for an approve, waits for its receipt on its own RPC, then asks for the burn (`src/lib/usdcx/executor.ts:339-352`). PR #1504's first live run had a load-balanced public RPC answer the burn's estimate from a node behind the approve (its body, line 8; run 38959825478), fixed by pinning the burn's simulation and estimate at or after the approve's block (run 38965349679). The extension harness has the primitives (`playwright/e2e/helpers/arc-usdcx.ts:710-727, :772-786, :794-815, :820-829, :859-917, :919-959`) and a pattern (`playwright/e2e/helpers/usdcx-l2-deposit.ts:146-155, :179-206`), but `submitL2Deposit` drives the product itself, so the counterparty needs its own sender. Keep `submitL2Deposit` untouched: the green Chrome suites use it. On Ethereum Sepolia the sender must also hold the tip to the chain's cap, as the Chrome sender does since #1508: Sepolia's tip oracle follows signers who bid up to 1.5 gwei, which would cost about 0.0013 ETH a run of a key that holds 0.0005 ETH there (`ETHEREUM_SEPOLIA_PAYOUT.maxPriorityFeeCap`, 0.01 gwei, `playwright/e2e/helpers/usdcx-constants.ts:222-234`). `sendSigned` already caps the tip it signs with at `chainOf(deps).maxPriorityFeeCap` through `capPriorityFee` (`arc-usdcx.ts:838-876`), and `l2Reads` names the source chain as `payoutChain` (`usdcx-l2-deposit.ts:39-44`), so a sender that signs through `sendSigned` on `l2Reads` gets the cap; the tip cases below pin that.

**Files:**
- Create: `playwright/e2e/helpers/l2-sender.ts`
- Create: `playwright/e2e/helpers/l2-sender.test.ts`

**Interfaces:**
- Consumes: `l2Reads(l2, overrides)` (`usdcx-l2-deposit.ts:39-44`), `pickWriteEndpoint`, `startingAt`, `chainRead`, `simulate`, `pinAfterApprove`, `sendSigned`, `waitForReceipt` (all exported from `arc-usdcx.ts`).
- Produces: `interface L2Transaction { to: Address; data: Hex; value: bigint }`; `interface L2Sender { readonly endpoint: string; readonly sent: readonly Hash[]; send(tx: L2Transaction, signal?: AbortSignal): Promise<Hash> }`; `createL2Sender(args: { privateKey: Hex; l2: L2BridgeInSource; allowedTargets: readonly Address[] }, deps?: Pick<ArcReadDeps, 'publicClient' | 'clock'>): Promise<L2Sender>`. Task 9 wires `send` into the counterparty and reads `endpoint`.

- [ ] **Step 1: Write the failing tests**

Create `playwright/e2e/helpers/l2-sender.test.ts`:

```ts
/**
 * @jest-environment node
 */
import {
  createPublicClient,
  custom,
  hexToBigInt,
  isHex,
  keccak256,
  parseTransaction,
  RpcRequestError,
  toHex,
  type Hex,
  type PublicClient
} from 'viem';

import arcVectors from './arc-usdcx.vectors.json';
import { createL2Sender, type L2Transaction } from './l2-sender';
import { L2_BRIDGE_IN_SOURCES, type L2BridgeInSource } from './usdcx-constants';

const KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const RECEIPT_BLOCK = 48_206_800n;
const clock = { now: () => 0, sleep: async () => undefined };

function l2On(chainId: number): L2BridgeInSource {
  const found = L2_BRIDGE_IN_SOURCES.find(l2 => l2.payout.chainId === chainId);
  if (!found) throw new Error(`L2_BRIDGE_IN_SOURCES lost chain ${chainId}`);
  return found;
}

/** The block a call ran at, or `unpinned` when it named none (viem then sends `latest` or no block). */
function blockOf(params: readonly unknown[]): string {
  const [, block] = params;
  return isHex(block) ? hexToBigInt(block).toString() : 'unpinned';
}

/**
 * One L2 behind a stub EIP-1193 provider: viem's own signing and encoding run, the answers are canned. `calls` lists
 * each nonce read and each eth_call and eth_estimateGas with the block it ran at. Every receipt is in RECEIPT_BLOCK and
 * the head is `head`; `revertCall` makes that eth_call (0 for the first) revert; `priorityFee` is the tip oracle's bid.
 */
function l2Chain(
  on: L2BridgeInSource,
  opts: { head?: bigint; servedChainId?: number; revertCall?: number; priorityFee?: bigint } = {}
) {
  const sent: Hex[] = [];
  const calls: string[] = [];
  let callIndex = 0;
  const rpc = (method: string, params: readonly unknown[]): unknown => {
    switch (method) {
      case 'eth_chainId':
        return toHex(opts.servedChainId ?? on.payout.chainId);
      case 'eth_getTransactionCount':
        calls.push(method);
        return '0x7';
      case 'eth_blockNumber':
        return toHex(opts.head ?? RECEIPT_BLOCK + 3n);
      case 'eth_call':
        calls.push(`eth_call ${blockOf(params)}`);
        if (callIndex++ === opts.revertCall) {
          throw new RpcRequestError({ body: {}, error: { code: 3, message: 'execution reverted' }, url: 'https://l2.example' });
        }
        return '0x';
      case 'eth_estimateGas':
        calls.push(`eth_estimateGas ${blockOf(params)}`);
        return '0xaae60';
      case 'eth_maxPriorityFeePerGas':
        return toHex(opts.priorityFee ?? 1_000_000n);
      case 'eth_getBlockByNumber':
        return {
          number: '0x10',
          hash: `0x${'11'.repeat(32)}`,
          timestamp: '0x6a87a0a0',
          baseFeePerGas: '0x5b8d80',
          transactions: []
        };
      case 'eth_sendRawTransaction': {
        const [raw] = params;
        if (raw === '0x00') throw Object.assign(new Error('failed to decode signed transaction'), { code: -32602 });
        if (!isHex(raw)) throw new Error('raw transaction is not hex');
        sent.push(raw);
        return keccak256(raw);
      }
      case 'eth_getTransactionReceipt':
        return {
          ...arcVectors.deposit.receipt,
          transactionHash: params[0],
          blockNumber: toHex(RECEIPT_BLOCK),
          logs: [],
          status: '0x1'
        };
      default:
        throw new Error(`unexpected ${method}`);
    }
  };
  const client: PublicClient = createPublicClient({
    chain: on.payout.chain,
    cacheTime: 0,
    transport: custom(
      {
        async request({ method, params }: { method: string; params?: unknown }) {
          return rpc(method, Array.isArray(params) ? params : []);
        }
      },
      { retryCount: 0 }
    )
  });
  return { sent, calls, publicClient: () => client };
}

const l2 = l2On(84532);
const APPROVE: L2Transaction = { to: l2.source.usdc, data: '0x095ea7b3', value: 0n };
const BURN: L2Transaction = { to: l2.source.tokenMessengerWithFees, data: '0xabcdef01', value: 0n };

const senderOn = (chain: ReturnType<typeof l2Chain>) =>
  createL2Sender(
    { privateKey: KEY, l2, allowedTargets: [l2.source.usdc, l2.source.tokenMessengerWithFees] },
    { publicClient: chain.publicClient, clock }
  );

describe('createL2Sender', () => {
  it("reads the nonce once, counts it locally, and runs the second send at the head past the first one's block", async () => {
    const chain = l2Chain(l2);
    const sender = await senderOn(chain);

    const approve = await sender.send(APPROVE);
    const burn = await sender.send(BURN);

    const [first, second] = chain.sent.map(raw => parseTransaction(raw));
    expect([first?.chainId, first?.nonce, second?.nonce]).toEqual([84532, 7, 8]);
    expect([first?.to, second?.to]).toEqual([APPROVE.to.toLowerCase(), BURN.to.toLowerCase()]);
    expect(sender.sent).toEqual([approve, burn]);
    expect(sender.sent).toEqual(chain.sent.map(raw => keccak256(raw)));
    const head = String(RECEIPT_BLOCK + 3n);
    expect(chain.calls).toEqual([
      'eth_getTransactionCount',
      'eth_call unpinned',
      'eth_estimateGas unpinned',
      `eth_call ${head}`,
      `eth_estimateGas ${head}`
    ]);
    expect(sender.endpoint).toBe(l2.payout.rpcUrls[0]);
  });

  it("pins the second send at the first one's block when the write endpoint's head is behind it", async () => {
    const chain = l2Chain(l2, { head: RECEIPT_BLOCK - 2n });
    const sender = await senderOn(chain);

    await sender.send(APPROVE);
    await sender.send(BURN);

    expect(chain.calls.slice(-2)).toEqual([`eth_call ${RECEIPT_BLOCK}`, `eth_estimateGas ${RECEIPT_BLOCK}`]);
  });

  it('gives two sends asked at once consecutive nonces', async () => {
    const chain = l2Chain(l2);
    const sender = await senderOn(chain);

    await Promise.all([sender.send(APPROVE), sender.send(BURN)]);

    expect(chain.sent.map(raw => parseTransaction(raw).nonce)).toEqual([7, 8]);
  });

  it('sends nothing when the second call would revert at its pin, and names the block', async () => {
    const chain = l2Chain(l2, { revertCall: 1 });
    const sender = await senderOn(chain);

    await sender.send(APPROVE);
    await expect(sender.send(BURN)).rejects.toThrow(`would revert at block ${RECEIPT_BLOCK + 3n}`);
    expect(chain.sent).toHaveLength(1);
  });

  it('refuses a target it was not given, sending nothing', async () => {
    const chain = l2Chain(l2);
    const sender = await senderOn(chain);

    await expect(sender.send({ ...APPROVE, to: '0x000000000000000000000000000000000000dEaD' })).rejects.toThrow(
      'refused: the key sends only to'
    );
    expect(chain.sent).toEqual([]);
  });

  it('refuses a transaction that carries ETH, sending nothing', async () => {
    const chain = l2Chain(l2);
    const sender = await senderOn(chain);

    await expect(sender.send({ ...APPROVE, value: 1n })).rejects.toThrow('refused: it carries 1 wei');
    expect(chain.sent).toEqual([]);
  });

  it('sends nothing once its signal is aborted', async () => {
    const chain = l2Chain(l2);
    const sender = await senderOn(chain);
    const stopping = new AbortController();
    stopping.abort(new Error('the counterparty stopped'));

    await expect(sender.send(APPROVE, stopping.signal)).rejects.toThrow('not sent: the counterparty stopped');
    expect(chain.sent).toEqual([]);
  });

  it('refuses an endpoint that serves another chain', async () => {
    await expect(senderOn(l2Chain(l2, { servedChainId: 1 }))).rejects.toThrow('no Base Sepolia endpoint takes writes');
  });

  // Sepolia's tip oracle follows signers who bid up to 1.5 gwei; its sends tip at most 0.01 gwei, as the Chrome
  // sender's do (#1508).
  it.each([
    ['Ethereum Sepolia with its cap', 11155111, 10_000_000n],
    ['Base Sepolia, which has no cap, with the oracle tip', 84532, 1_500_000_000n]
  ])('tips on %s when the oracle bids 1.5 gwei', async (_on, chainId, tip) => {
    const on = l2On(chainId);
    const chain = l2Chain(on, { priorityFee: 1_500_000_000n });
    const sender = await createL2Sender(
      { privateKey: KEY, l2: on, allowedTargets: [on.source.usdc] },
      { publicClient: chain.publicClient, clock }
    );

    await sender.send({ to: on.source.usdc, data: '0x095ea7b3', value: 0n });

    // viem's max fee: the 0.006 gwei base fee at 1.2x, plus the tip bid.
    const [sent] = chain.sent.map(raw => parseTransaction(raw));
    expect([sent?.chainId, sent?.maxPriorityFeePerGas, sent?.maxFeePerGas]).toEqual([chainId, tip, 7_200_000n + tip]);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn jest playwright/e2e/helpers/l2-sender.test.ts --maxWorkers=1`
Expected: FAIL with `Cannot find module './l2-sender'`.

- [ ] **Step 3: Write the sender**

Create `playwright/e2e/helpers/l2-sender.ts`:

```ts
/**
 * The source-chain sender behind a headless Reown counterparty on an executor-route source chain, for a deposit the
 * wallet's own deposit screen drives (usdcx-live-executor-deposit.ios.spec.ts). It sends as submitL2Deposit sends the
 * harness key's deposit: one write endpoint that takes raw transactions, a nonce read once and counted locally, the tip
 * held to the chain's cap (sendSigned), and every send after the first simulated and estimated at the later of the
 * previous send's block and the write endpoint's head, since load-balanced public RPCs served a burn the state from
 * before its approve (#1504). A send that would revert there, a target it was not given, a value and anything after its
 * signal aborted are refused unsent.
 */
import { isAddressEqual, type Address, type Hash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  chainRead,
  pickWriteEndpoint,
  pinAfterApprove,
  sendSigned,
  simulate,
  startingAt,
  waitForReceipt,
  type ArcReadDeps
} from './arc-usdcx';
import type { L2BridgeInSource } from './usdcx-constants';
import { l2Reads } from './usdcx-l2-deposit';

export interface L2Transaction {
  to: Address;
  data: Hex;
  value: bigint;
}

export interface L2Sender {
  /** The endpoint that takes the writes; a proof of what was sent reads there first. */
  readonly endpoint: string;
  /** Every hash sent, in order. */
  readonly sent: readonly Hash[];
  send(tx: L2Transaction, signal?: AbortSignal): Promise<Hash>;
}

export async function createL2Sender(
  args: { privateKey: Hex; l2: L2BridgeInSource; allowedTargets: readonly Address[] },
  deps: Pick<ArcReadDeps, 'publicClient' | 'clock'> = {}
): Promise<L2Sender> {
  const { l2 } = args;
  const reads = l2Reads(l2, deps);
  const account = privateKeyToAccount(args.privateKey);
  const endpoint = await pickWriteEndpoint(reads);
  const endpoints = { write: endpoint, reads: startingAt(reads.endpoints, endpoint) };
  const sent: Hash[] = [];
  let nonce: number | undefined;
  const sendOne = async (tx: L2Transaction, signal: AbortSignal | undefined): Promise<Hash> => {
    const what = `transaction ${sent.length + 1} to ${tx.to} on ${l2.payout.label}`;
    if (!args.allowedTargets.some(target => isAddressEqual(target, tx.to))) {
      throw new Error(`${what} refused: the key sends only to ${args.allowedTargets.join(', ')}`);
    }
    if (tx.value !== 0n) throw new Error(`${what} refused: it carries ${tx.value} wei`);
    nonce ??= await chainRead(`${l2.payout.label} nonce`, endpoints.reads, reads, client =>
      client.getTransactionCount({ address: account.address, blockTag: 'pending' })
    );
    const previous = sent.at(-1);
    const previousBlock =
      previous === undefined ? undefined : (await waitForReceipt(endpoints.reads, reads, previous)).blockNumber;
    const atBlock = await pinAfterApprove(endpoint, reads, previousBlock);
    await simulate(
      what,
      endpoint,
      reads,
      (client, blockNumber) => client.call({ account: account.address, to: tx.to, data: tx.data, blockNumber }),
      atBlock
    );
    const hash = await sendSigned(reads, endpoints, account, { what, to: tx.to, data: tx.data, nonce, atBlock }, signal);
    nonce += 1;
    sent.push(hash);
    return hash;
  };
  // The app waits for each receipt before its next prompt; the queue keeps two requests from sharing a nonce anyway.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    endpoint,
    sent,
    send(tx, signal) {
      const next = queue.then(() => sendOne(tx, signal));
      queue = next.catch(() => undefined);
      return next;
    }
  };
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `yarn jest playwright/e2e/helpers/l2-sender.test.ts --maxWorkers=1`
Expected: PASS, 10 tests. If viem 2.55.4 sends a block argument on an unpinned `eth_call` other than `latest` or none, `blockOf` still reads it as `unpinned` only when it is not hex; a hex there would be a real pin and is a bug in the sender, not in the test.

- [ ] **Step 5: Mutation checks**

One at a time, rerun `yarn jest playwright/e2e/helpers/l2-sender.test.ts --maxWorkers=1` and restore after each:
1. Replace `nonce ??= await chainRead(` with `nonce = await chainRead(`: the first case fails (two `eth_getTransactionCount` reads).
2. Replace `const atBlock = await pinAfterApprove(endpoint, reads, previousBlock);` with `const atBlock = undefined;`: the first two cases fail (the second call is `unpinned`).
3. Delete the `if (!args.allowedTargets.some(...))` block: the target case fails.
4. Replace `const reads = l2Reads(l2, deps);` with `const reads = { ...l2Reads(l2, deps), payoutChain: { ...l2.payout, maxPriorityFeeCap: undefined } };`: the Ethereum Sepolia tip case fails (it signs a 1.5 gwei tip).

- [ ] **Step 6: Run the directory's other tests**

Run: `yarn jest playwright/e2e/helpers --maxWorkers=1`
Expected: PASS (about 45 suites, the arc, cctp, l2-deposit, run and bridge ones among them; none changes behaviour here).

- [ ] **Step 7: Format, lint, dash check, commit, push**

```bash
F="playwright/e2e/helpers/l2-sender.ts playwright/e2e/helpers/l2-sender.test.ts"
yarn prettier --check ${=F}
yarn eslint --max-warnings 0 ${=F}
perl -CSD -ne 'print "$ARGV:$.: $_" if /[\x{2013}\x{2014}]/' ${=F}
git add ${=F}
git commit -m "l2 sender for a headless counterparty: local nonce, each send pinned after the previous one, tip capped"
git push
```

---

### Task 6: Executor request gates, a narrower burn-proof input, the key's own refill hint and the Sepolia payout-key check

**Why:** the Chrome suite checks what its own Node signer built (`usdcx-l2-deposit.ts:250-265`); on iOS the wallet builds the requests, so the harness must check what the wallet asked the key to sign before it waits on Circle: the chain, the sender, at most one approve of the fee entry point for the amount plus twice a quoted fee and only when the allowance was short (`src/lib/usdcx/executor.ts:330-345`), and exactly one forwarded burn whose arguments other than Circle's signed quote are rebuilt with the product's own `buildExecutorBurnIntent` (`executor.ts:206-221, :236-251`). `confirmL2Burn` reads only `endpoint`, `burnHash`, `signed.hookData` and `burnQuote.feeTotalAmount` (`usdcx-cctp-proof.ts:140-177`) but is typed on the whole `L2DepositSubmission`, which the iOS spec cannot build. `l2KeyShortfall`'s USDC message names `usdcx-burn-l2` as the refill (`usdcx-l2-deposit.ts:102-104`), which is the CI harness key's, not the iOS key's. On Ethereum Sepolia a key with no USDC can never be paid the burn half's payout: Circle's forwarder sends `gatewayMint` with a fixed 250,000 gas limit, and a mint to an address that never held Sepolia USDC needs about 346,000, so it reverts on every retry; the Chrome runner refuses such a key before its build for that reason (`probeSepoliaPayoutKey`, `scripts/e2e-real.mjs:1488-1516`), and the iOS executor spec's preflight must too (the user's decision 3). The gates are chain-generic, so one case runs them on Ethereum Sepolia.

**Files:**
- Create: `playwright/e2e/helpers/usdcx-executor-requests.ts`
- Create: `playwright/e2e/helpers/usdcx-executor-requests.test.ts`
- Modify: `playwright/e2e/helpers/usdcx-cctp-proof.ts:31` (import), `:127-144` (new input type, signature)
- Modify: `playwright/e2e/helpers/usdcx-l2-deposit.ts:24` (import), `:77-108` (`l2KeyShortfall`), and a new `payoutKeyProblem` after it
- Test: `playwright/e2e/helpers/usdcx-l2-deposit.test.ts:25-26` (imports), `:531-552` (`l2KeyShortfall`), and a new describe at the end

**Interfaces:**
- Produces: `interface SignedRequest { method: string; chainId?: string; params: unknown; result?: unknown; error?: string }` (structurally `WcRequestLog`); `interface ExecutorDepositExpectation { l2: L2BridgeInSource; units: bigint; recipient: Hex; depositor: Address; recordedFee: bigint; allowanceBefore: bigint }`; `executorDepositRequests(requests: readonly SignedRequest[], expected: ExecutorDepositExpectation): { approve?: { hash: Hash; value: bigint }; burn: { hash: Hash; hookData: Hex } }` (throws listing every problem).
- Produces: `interface L2BurnSubmission { endpoint: string; burnHash: Hash; signed: { hookData: Hex }; burnQuote: { feeTotalAmount: bigint } }`; `confirmL2Burn(submission: L2BurnSubmission, ...)` (Chrome's `L2DepositSubmission` still fits).
- Produces: `l2KeyShortfall({ ..., refill?: string })`; without `refill` the message is unchanged.
- Produces: `payoutKeyProblem(chain: PayoutChain, address: Address, usdc: bigint): string | undefined`: on Ethereum Sepolia with no USDC, the reason Circle cannot pay the key; else undefined. Task 9's preflight calls it before `l2KeyShortfall`.

- [ ] **Step 1: Write the failing tests**

Create `playwright/e2e/helpers/usdcx-executor-requests.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { encodeFunctionData, formatUnits, type Address, type Hash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ERC20_ABI } from './arc-usdcx';
import { DEPOSIT_UNITS, L2_BRIDGE_IN_SOURCES, type L2BridgeInSource } from './usdcx-constants';
import { executorDepositRequests, type SignedRequest } from './usdcx-executor-requests';
import { buildDepositForBurnWithHookAndFeesArgs, buildExecutorBurnIntent } from '../../../src/lib/usdcx/executor';
import { TOKEN_MESSENGER_WITH_FEES_ABI } from '../../../src/lib/usdcx/protocol';
import { midenAccountHexToXReserveRecipient } from '../../../src/lib/usdcx/recipient';

const { address: DEPOSITOR } = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
);
const RECIPIENT = midenAccountHexToXReserveRecipient('0xf2f42cda8d010f417d1cad5dc4d52b');
const OTHER_RECIPIENT = midenAccountHexToXReserveRecipient('0x0a0b0c0d0e0f101112131415161718');
/** Circle's sandbox fee for a 0.001 USDC forwarded burn from Base Sepolia on 2026-10-16. */
const FEE = 22_404n;
const APPROVE_HASH: Hash = `0x${'a1'.repeat(32)}`;
const BURN_HASH: Hash = `0x${'b2'.repeat(32)}`;
const DEAD: Address = '0x000000000000000000000000000000000000dEaD';

function l2On(chainId: number): L2BridgeInSource {
  const found = L2_BRIDGE_IN_SOURCES.find(l2 => l2.payout.chainId === chainId);
  if (!found) throw new Error(`L2_BRIDGE_IN_SOURCES lost chain ${chainId}`);
  return found;
}
const l2 = l2On(84532);
const EXPECTED = {
  l2,
  units: DEPOSIT_UNITS,
  recipient: RECIPIENT,
  depositor: DEPOSITOR,
  recordedFee: FEE,
  allowanceBefore: 0n
};
const intentFor = (recipient: Hex) =>
  buildExecutorBurnIntent(formatUnits(DEPOSIT_UNITS, 6), l2.source, recipient, DEPOSITOR);

/** What the counterparty logs for a transaction the app asked for, in the address case the app sends. */
const sendTx = (to: Address, data: Hex, hash: Hash, chainId = 'eip155:84532'): SignedRequest => ({
  method: 'eth_sendTransaction',
  chainId,
  params: [{ from: DEPOSITOR.toLowerCase(), to: to.toLowerCase(), data, value: '0x0' }],
  result: hash
});
const approveTx = (value = DEPOSIT_UNITS + 2n * FEE) =>
  sendTx(
    l2.source.usdc,
    encodeFunctionData({ abi: ERC20_ABI, functionName: 'approve', args: [l2.source.tokenMessengerWithFees, value] }),
    APPROVE_HASH
  );
const burnTx = (opts: { recipient?: Hex; refund?: Address; chainId?: string } = {}) =>
  sendTx(
    l2.source.tokenMessengerWithFees,
    encodeFunctionData({
      abi: TOKEN_MESSENGER_WITH_FEES_ABI,
      functionName: 'depositForBurnWithHookAndFees',
      args: buildDepositForBurnWithHookAndFeesArgs(
        l2.source,
        intentFor(opts.recipient ?? RECIPIENT),
        { signedQuote: '0x0102', feeTotalAmount: FEE },
        opts.refund ?? DEPOSITOR
      )
    }),
    BURN_HASH,
    opts.chainId
  );

describe('executorDepositRequests', () => {
  it('accepts the approve and the forwarded burn runUsdcxExecutorDeposit asks for', () => {
    expect(executorDepositRequests([approveTx(), burnTx()], EXPECTED)).toEqual({
      approve: { hash: APPROVE_HASH, value: DEPOSIT_UNITS + 2n * FEE },
      burn: { hash: BURN_HASH, hookData: intentFor(RECIPIENT).hookData }
    });
  });

  it('accepts a burn alone when the allowance before the deposit covered the amount and the fee', () => {
    expect(
      executorDepositRequests([burnTx()], { ...EXPECTED, allowanceBefore: DEPOSIT_UNITS + FEE })
    ).toEqual({ burn: { hash: BURN_HASH, hookData: intentFor(RECIPIENT).hookData } });
  });

  it('refuses a burn alone when the allowance before the deposit did not cover it', () => {
    expect(() => executorDepositRequests([burnTx()], EXPECTED)).toThrow(
      'no approve, but the allowance before the deposit, 0, does not cover the amount and the fee 22404'
    );
  });

  it('refuses an approve the product would not have sent', () => {
    expect(() =>
      executorDepositRequests([approveTx(), burnTx()], { ...EXPECTED, allowanceBefore: DEPOSIT_UNITS + FEE })
    ).toThrow('covered the amount and the first fee 22404');
  });

  it('names every burn argument that differs from the one rebuilt with the product', () => {
    expect(() =>
      executorDepositRequests([approveTx(), burnTx({ recipient: OTHER_RECIPIENT, refund: DEAD })], EXPECTED)
    ).toThrow(/hookData[\s\S]*refundAddress/);
  });

  it('refuses another chain, a message to sign and an approve that is not the amount plus twice a fee', () => {
    const requests: SignedRequest[] = [
      approveTx(DEPOSIT_UNITS + 2n * FEE + 1n),
      burnTx({ chainId: 'eip155:5042002' }),
      { method: 'personal_sign', chainId: 'eip155:84532', params: [] }
    ];
    expect(() => executorDepositRequests(requests, EXPECTED)).toThrow(
      /not on eip155:84532[\s\S]*transactions only[\s\S]*not the amount 1000 plus twice a quoted fee/
    );
  });

  it('refuses two burns and an approve after the burn', () => {
    expect(() => executorDepositRequests([burnTx(), approveTx(), burnTx()], EXPECTED)).toThrow(
      /2 forwarded burns, expected exactly 1[\s\S]*the approve came after the burn/
    );
  });

  // The executor spec runs these gates on every source chain: each has its own chain id and USDC.
  it("accepts Ethereum Sepolia's requests on its own chain and contracts, and refuses Base Sepolia's there", () => {
    const sepolia = l2On(11155111);
    const intent = buildExecutorBurnIntent(formatUnits(DEPOSIT_UNITS, 6), sepolia.source, RECIPIENT, DEPOSITOR);
    const onSepolia = (to: Address, data: Hex, hash: Hash) => sendTx(to, data, hash, 'eip155:11155111');
    const requests: SignedRequest[] = [
      onSepolia(
        sepolia.source.usdc,
        encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [sepolia.source.tokenMessengerWithFees, DEPOSIT_UNITS + 2n * FEE]
        }),
        APPROVE_HASH
      ),
      onSepolia(
        sepolia.source.tokenMessengerWithFees,
        encodeFunctionData({
          abi: TOKEN_MESSENGER_WITH_FEES_ABI,
          functionName: 'depositForBurnWithHookAndFees',
          args: buildDepositForBurnWithHookAndFeesArgs(
            sepolia.source,
            intent,
            { signedQuote: '0x0102', feeTotalAmount: FEE },
            DEPOSITOR
          )
        }),
        BURN_HASH
      )
    ];

    expect(executorDepositRequests(requests, { ...EXPECTED, l2: sepolia })).toEqual({
      approve: { hash: APPROVE_HASH, value: DEPOSIT_UNITS + 2n * FEE },
      burn: { hash: BURN_HASH, hookData: intent.hookData }
    });
    expect(() => executorDepositRequests([approveTx(), burnTx()], { ...EXPECTED, l2: sepolia })).toThrow(
      'not on eip155:11155111'
    );
  });
});
```

In `playwright/e2e/helpers/usdcx-l2-deposit.test.ts`, inside `describe('l2KeyShortfall', ...)`, after the case `'asks for USDC to cover the deposit and twice the fee its approve covers'`, add:

```ts
  it("names the key's own refill when it has one", () => {
    expect(
      l2KeyShortfall({ ...enough, wei: 10n ** 16n, usdc: 40_000n, refill: 'a green iOS executor run pays it back' })
    ).toMatch(/which its approve covers\); a green iOS executor run pays it back$/);
  });
```

In the same file, replace the two imports at `:25-26` (from `./usdcx-constants` and `./usdcx-l2-deposit`) with:

```ts
import {
  ARBITRUM_SEPOLIA_PAYOUT,
  BASE_SEPOLIA_PAYOUT,
  DEPOSIT_UNITS,
  ETHEREUM_SEPOLIA_PAYOUT,
  L2_BRIDGE_IN_SOURCES,
  type L2BridgeInSource
} from './usdcx-constants';
import { l2KeyShortfall, l2Reads, payoutKeyProblem, readL2KeyFunds, submitL2Deposit } from './usdcx-l2-deposit';
```

and append at the end of the file:

```ts
describe('payoutKeyProblem', () => {
  it("refuses a key with no Ethereum Sepolia USDC, naming Circle's fixed mint gas limit", () => {
    expect(payoutKeyProblem(ETHEREUM_SEPOLIA_PAYOUT, DEPOSITOR, 0n)).toBe(
      `${DEPOSITOR} holds no Ethereum Sepolia USDC, and Circle's forwarder cannot mint a payout to a recipient with no ` +
        'USDC under its fixed gas limit: fund the key with any amount of Ethereum Sepolia USDC first'
    );
  });

  it.each([
    ['Ethereum Sepolia holding 1 base unit', ETHEREUM_SEPOLIA_PAYOUT, 1n],
    ['Base Sepolia holding none', BASE_SEPOLIA_PAYOUT, 0n],
    ['Arbitrum Sepolia holding none', ARBITRUM_SEPOLIA_PAYOUT, 0n]
  ])('asks nothing of a key on %s', (_on, chain, usdc) => {
    expect(payoutKeyProblem(chain, DEPOSITOR, usdc)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn jest playwright/e2e/helpers/usdcx-executor-requests.test.ts playwright/e2e/helpers/usdcx-l2-deposit.test.ts --maxWorkers=1`
Expected: FAIL. `Cannot find module './usdcx-executor-requests'`; in `usdcx-l2-deposit.test.ts` the refill case ends with `usdcx-burn-l2 run pays it about 0.99 USDC there`, and the `payoutKeyProblem` cases fail with `payoutKeyProblem is not a function` (swc does not type-check the missing export).

- [ ] **Step 3: Write the gates**

Create `playwright/e2e/helpers/usdcx-executor-requests.ts`:

```ts
/**
 * What the wallet asked a counterparty to sign for one executor-route deposit through its own deposit screen, checked
 * against what runUsdcxExecutorDeposit (usdcx/executor.ts) must ask: transactions only, on the source chain and from
 * the key; at most one approve, of the fee entry point, for the amount plus twice a quoted fee and only when the
 * allowance was short; and exactly one forwarded burn after it, every argument but Circle's signed quote rebuilt here
 * with the product's own builder. The quote is opaque, so the fee is the one the wallet wrote on its row with the burn.
 */
import { decodeFunctionData, formatUnits, isAddressEqual, isHash, isHex, type Address, type Hash, type Hex } from 'viem';

import { ERC20_ABI } from './arc-usdcx';
import type { L2BridgeInSource } from './usdcx-constants';
import { buildExecutorBurnIntent } from '../../../src/lib/usdcx/executor';
import { CIRCLE_USDC_DECIMALS, TOKEN_MESSENGER_WITH_FEES_ABI } from '../../../src/lib/usdcx/protocol';

/** One request a counterparty answered, as its WcRequestLog records it. */
export interface SignedRequest {
  method: string;
  chainId?: string;
  params: unknown;
  result?: unknown;
  error?: string;
}

export interface ExecutorDepositExpectation {
  l2: L2BridgeInSource;
  units: bigint;
  /** The xReserve recipient the burn's hook must carry: the Miden account as bytes32. */
  recipient: Hex;
  depositor: Address;
  /** The fee the burn paid, as the wallet recorded it with the burn (`cctp.forwardFee`). */
  recordedFee: bigint;
  /** The key's allowance to the fee entry point, read before the deposit. */
  allowanceBefore: bigint;
}

export interface ExecutorDepositRequests {
  approve?: { hash: Hash; value: bigint };
  burn: { hash: Hash; hookData: Hex };
}

function firstParam(params: unknown): Record<string, unknown> {
  const [tx] = Array.isArray(params) ? params : [];
  return tx !== null && typeof tx === 'object' ? Object.fromEntries(Object.entries(tx)) : {};
}

const sameAddress = (value: unknown, address: Address): boolean =>
  typeof value === 'string' && isHex(value) && value.length === 42 && isAddressEqual(value, address);

function decodeOr<T>(decode: () => T): T | undefined {
  try {
    return decode();
  } catch {
    return undefined;
  }
}

export function executorDepositRequests(
  requests: readonly SignedRequest[],
  expected: ExecutorDepositExpectation
): ExecutorDepositRequests {
  const { source, payout } = expected.l2;
  const chainId = `eip155:${payout.chainId}`;
  const intent = buildExecutorBurnIntent(
    formatUnits(expected.units, CIRCLE_USDC_DECIMALS),
    source,
    expected.recipient,
    expected.depositor
  );
  const problems: string[] = [];
  const approves: Array<{ index: number; hash: Hash; value: bigint }> = [];
  const burns: Array<{ index: number; hash: Hash }> = [];
  for (const [index, request] of requests.entries()) {
    const where = `request ${index + 1} (${request.method} on ${request.chainId ?? 'no chain'})`;
    if (request.method !== 'eth_sendTransaction') {
      problems.push(`${where}: the deposit asks for transactions only`);
      continue;
    }
    if (request.chainId !== chainId) problems.push(`${where}: not on ${chainId}`);
    if (request.error !== undefined) problems.push(`${where}: answered with an error: ${request.error}`);
    const hash = request.result;
    if (typeof hash !== 'string' || !isHash(hash)) {
      problems.push(`${where}: returned no transaction hash`);
      continue;
    }
    const tx = firstParam(request.params);
    if (!sameAddress(tx.from, expected.depositor)) {
      problems.push(`${where}: from ${String(tx.from)}, not ${expected.depositor}`);
    }
    if (tx.value !== undefined && !(isHex(tx.value) && BigInt(tx.value) === 0n)) {
      problems.push(`${where}: carries value ${String(tx.value)}`);
    }
    const data = isHex(tx.data) ? tx.data : '0x';
    if (sameAddress(tx.to, source.usdc)) {
      const call = decodeOr(() => decodeFunctionData({ abi: ERC20_ABI, data }));
      if (call?.functionName !== 'approve') {
        problems.push(`${where}: calls the source USDC with something other than approve`);
        continue;
      }
      const [spender, value] = call.args;
      if (!isAddressEqual(spender, source.tokenMessengerWithFees)) {
        problems.push(`${where}: approves ${spender}, not the fee entry point ${source.tokenMessengerWithFees}`);
      }
      approves.push({ index, hash, value });
    } else if (sameAddress(tx.to, source.tokenMessengerWithFees)) {
      const call = decodeOr(() => decodeFunctionData({ abi: TOKEN_MESSENGER_WITH_FEES_ABI, data }));
      if (call?.functionName !== 'depositForBurnWithHookAndFees') {
        problems.push(`${where}: calls the fee entry point with something other than depositForBurnWithHookAndFees`);
        continue;
      }
      const [amount, destinationDomain, mintRecipient, burnToken, destinationCaller, hookData, claim] = call.args;
      // Decoding lowercases bytes32 and bytes, while addressToBytes32 keeps the checksum's case.
      const checks: ReadonlyArray<readonly [string, string | number | bigint, string | number | bigint]> = [
        ['amount', amount, expected.units],
        ['destinationDomain', destinationDomain, source.target.domain],
        ['mintRecipient', mintRecipient.toLowerCase(), intent.destinationCaller.toLowerCase()],
        ['burnToken', burnToken.toLowerCase(), source.usdc.toLowerCase()],
        ['destinationCaller', destinationCaller.toLowerCase(), intent.destinationCaller.toLowerCase()],
        ['hookData', hookData.toLowerCase(), intent.hookData.toLowerCase()],
        ['refundAddress', claim.refundAddress.toLowerCase(), expected.depositor.toLowerCase()]
      ];
      for (const [field, actual, wanted] of checks) {
        if (actual !== wanted) problems.push(`${where}: ${field} ${actual}, expected ${wanted}`);
      }
      burns.push({ index, hash });
    } else {
      problems.push(`${where}: to ${String(tx.to)}, neither the source USDC nor the fee entry point`);
    }
  }
  const [burn, ...extraBurns] = burns;
  if (!burn || extraBurns.length > 0) problems.push(`${burns.length} forwarded burns, expected exactly 1`);
  const [approve, ...extraApproves] = approves;
  if (extraApproves.length > 0) problems.push(`${approves.length} approves, expected at most 1`);
  if (approve && burn && approve.index > burn.index) problems.push('the approve came after the burn');
  if (approve) {
    const twiceFee = approve.value - expected.units;
    if (twiceFee <= 0n || twiceFee % 2n !== 0n) {
      problems.push(`the approve of ${approve.value} is not the amount ${expected.units} plus twice a quoted fee`);
    } else if (expected.allowanceBefore >= expected.units + twiceFee / 2n) {
      problems.push(
        `an approve, though the allowance before the deposit, ${expected.allowanceBefore}, covered the amount and ` +
          `the first fee ${twiceFee / 2n}`
      );
    }
    if (expected.units + expected.recordedFee > approve.value) {
      problems.push(`the burn's fee ${expected.recordedFee} is more than the approve of ${approve.value} covers`);
    }
  } else if (expected.allowanceBefore < expected.units + expected.recordedFee) {
    problems.push(
      `no approve, but the allowance before the deposit, ${expected.allowanceBefore}, does not cover the amount ` +
        `and the fee ${expected.recordedFee}`
    );
  }
  if (problems.length > 0 || !burn) {
    throw new Error(`the requests to the key differ from runUsdcxExecutorDeposit's:\n  ${problems.join('\n  ')}`);
  }
  return {
    ...(approve ? { approve: { hash: approve.hash, value: approve.value } } : {}),
    burn: { hash: burn.hash, hookData: intent.hookData }
  };
}
```

- [ ] **Step 4: Narrow `confirmL2Burn`'s input, give `l2KeyShortfall` a refill, add `payoutKeyProblem`**

In `playwright/e2e/helpers/usdcx-cctp-proof.ts`, delete the import at `:31` (`import type { L2DepositSubmission } from './usdcx-l2-deposit';`) and insert above `export interface L2BurnProof` (`:127`):

```ts
/** What confirmL2Burn reads of a deposit: the endpoint that took it, the burn, its hook data and the fee it paid. */
export interface L2BurnSubmission {
  endpoint: string;
  burnHash: Hash;
  signed: { hookData: Hex };
  burnQuote: { feeTotalAmount: bigint };
}

```

and change the first parameter of `confirmL2Burn` (`:141`) from `submission: L2DepositSubmission,` to `submission: L2BurnSubmission,`.

In `playwright/e2e/helpers/usdcx-l2-deposit.ts`, in `l2KeyShortfall`'s argument type (`:81-89`) add after `fee: bigint;`:

```ts
  /** How the key's USDC there is refilled; the harness key's is a green usdcx-burn-l2 run. */
  refill?: string;
```

and replace the last two lines of the USDC message (`:103-104`):

```ts
      `deposit and twice Circle's ${usdc(args.fee)} fee, which its approve covers); a green usdcx-burn-l2 run pays it ` +
      'about 0.99 USDC there'
```

with:

```ts
      `deposit and twice Circle's ${usdc(args.fee)} fee, which its approve covers); ` +
      (args.refill ?? 'a green usdcx-burn-l2 run pays it about 0.99 USDC there')
```

In the same file, replace the import at `:24` (`import { L2_BRIDGE_IN_GAS, USDCX_REMOTE_DOMAIN, type L2BridgeInSource } from './usdcx-constants';`) with:

```ts
import {
  ETHEREUM_SEPOLIA_PAYOUT,
  L2_BRIDGE_IN_GAS,
  USDCX_REMOTE_DOMAIN,
  type L2BridgeInSource,
  type PayoutChain
} from './usdcx-constants';
```

and insert after the closing `}` of `l2KeyShortfall`, above `export interface L2DepositSubmission`:

```ts

/**
 * Why Circle cannot pay a burn to `address` on `chain`, or undefined. On Ethereum Sepolia its forwarder sends
 * gatewayMint with a fixed 250,000 gas limit, and a mint to an address that never held Sepolia USDC needs about
 * 346,000, so it reverts on every retry (scripts/e2e-real.mjs probeSepoliaPayoutKey, 2026-10-16).
 */
export function payoutKeyProblem(chain: PayoutChain, address: Address, usdc: bigint): string | undefined {
  if (chain.chainId !== ETHEREUM_SEPOLIA_PAYOUT.chainId || usdc > 0n) return undefined;
  return (
    `${address} holds no ${chain.label} USDC, and Circle's forwarder cannot mint a payout to a recipient with no ` +
    `USDC under its fixed gas limit: fund the key with any amount of ${chain.label} USDC first`
  );
}
```

- [ ] **Step 5: Run the directory's tests**

Run: `yarn jest playwright/e2e/helpers --maxWorkers=1`
Expected: PASS, the existing `l2KeyShortfall` cases unchanged and the `confirmL2Burn` cases in `usdcx-cctp-proof.test.ts` unchanged (the narrowing is a type change, which CI's `tsc` checks against the Chrome caller at `playwright/e2e/tests/usdcx/usdcx-in-l2.spec.ts:205-207`).

- [ ] **Step 6: Mutation checks**

One at a time, rerun the named file with `yarn jest <file> --maxWorkers=1` and restore:
1. `usdcx-executor-requests.test.ts`: delete the `['hookData', ...]` row: the "names every burn argument" case still fails on `refundAddress` but its regex needs both, so it fails.
2. `usdcx-executor-requests.test.ts`: change `} else if (expected.allowanceBefore >= expected.units + twiceFee / 2n) {` to `} else if (false) {`: the "would not have sent" case fails.
3. `usdcx-l2-deposit.test.ts`: in `payoutKeyProblem`, change `usdc > 0n` to `usdc >= 0n`: the Ethereum Sepolia refusal case fails.

- [ ] **Step 7: Format, lint, dash check, commit, push**

```bash
F="playwright/e2e/helpers/usdcx-executor-requests.ts playwright/e2e/helpers/usdcx-executor-requests.test.ts playwright/e2e/helpers/usdcx-cctp-proof.ts playwright/e2e/helpers/usdcx-l2-deposit.ts playwright/e2e/helpers/usdcx-l2-deposit.test.ts"
yarn prettier --check ${=F}
yarn eslint --max-warnings 0 ${=F}
perl -CSD -ne 'print "$ARGV:$.: $_" if /[\x{2013}\x{2014}]/' ${=F}
git add ${=F}
git commit -m "usdcx executor deposit gates for wallet-signed requests and the sepolia payout-key check"
git push
```

---

### Task 7: iOS page object: a network picker, a wider route confirm, a burn to any payout chain

**Why:** the live executor spec must pick its source chain on the deposit amount step (no helper today, `ios-wallet-page.ts:477-541` at `fd614122d`), proven by a row that names the chain exactly, since "Sepolia" is part of "Base Sepolia" and "Arbitrum Sepolia" (Review Focus 1), wait for Confirm on the executor route, where it waits on the balance read and Circle's quoted fee (`usdcxReady` requires `!usdcxFeeShortfall`, `EvmBridgeDepositScreen.tsx:1283-1289`), read a failed deposit row's error from `latestBridgeReceive` (the hook returns it, `bridge-in-test-hooks.ts:91-101`; the wrapper's type drops it, `ios-wallet-page.ts:453-461`), and burn back to the source chain, while the burn driver is Arc-only (`ARC_CHIP` `:165`, `usdcxPayoutRowsText(ARC_CHAIN_ID, ...)` `:668`, `network: 'arc-testnet'` `:727`, `ARC_TESTNET.name` `:739`, Arc explorer links `:841-853`). The extension driver already words a failed snapshot per chain (`burnSubmitFailure`, `playwright/e2e/helpers/bridge.ts:733-744`).

**Files:**
- Modify: `playwright/e2e/ios/helpers/ios-wallet-page.ts:9, :13-23, :32, :134-136 (after), :165, :258-269, :437-445, :485-489 (after), :514-521, :639-652, :675-682, :711, :723, :765-770, :824-837`. Every number from `:437` on is after Task 1, which deleted `:411-426`; each step also names its text anchor.
- Modify: `playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts:748, :751` (`arcTxLinks` to `txLinks`)
- Test: `playwright/e2e/ios/helpers/ios-wallet-page.test.ts` (imports `:9, :11-12`, `spikeAnswer`, the Arc snapshot case at `:519-528`, the details case at `:681-692`, new cases)

**Interfaces:**
- Produces: `IosWalletPage.selectBridgeNetwork(slug: string, name: string): Promise<void>`; `networkRowNames(spans: readonly string[] | null, name: string): boolean` (exported, pure); `confirmBridgeRouteUsdcx(timeoutMs = 15_000)`; `latestBridgeReceive()` returns `error?: string` too; `UsdcxBurnViaSendOptions.payout?: PayoutChain` (default `ARC_PAYOUT`); `transactionDetailsView(rowId, explorer = ARC_PAYOUT.explorer): Promise<{ pill: string | null; txLinks: string[] }>`.

- [ ] **Step 1: Write the failing tests**

In `playwright/e2e/ios/helpers/ios-wallet-page.test.ts`:

1. Change `:9` to `import { IosWalletPage, networkRowNames, routeOf } from './ios-wallet-page';`, and replace `:11-12` with:

```ts
import { enText, usdcxPayoutRowsText, type BridgedSendRow } from '../../helpers/bridge';
import { readTransactionRowsInPage } from '../../helpers/history';
import { BASE_SEPOLIA_PAYOUT } from '../../helpers/usdcx-constants';
```

2. Give `spikeAnswer` (`:390`) the chip that is pressed:

```ts
function spikeAnswer(js: string, overrides: { ready?: unknown; outcome?: unknown; pressed?: string } = {}): unknown {
  if (js.includes('aria-pressed')) {
    const pressed = overrides.pressed ?? CHIPS[0];
    return CHIPS.map(testId => ({ testId, pressed: testId === pressed ? 'true' : 'false' }));
  }
```

(the rest of the function unchanged).

3. In `"tells the wallet's failed Arc snapshot apart from a refusal after submit"` (`:519-528`), change the expected message to the shared helper's wording:

```ts
    await expect(page.burnUsdcxViaSendFlow(BURN)).rejects.toThrow(
      `Arc RPC unavailable for the wallet's balance snapshot (burn.ts:103), infra: review-error "HTTP request failed."`
    );
```

4. Add inside `describe('IosWalletPage.burnUsdcxViaSendFlow', ...)`, after the last case:

```ts
  it('presses the payout chain it is given and holds the route and the review to that chain', async () => {
    const baseChip = BASE_SEPOLIA_PAYOUT.chip;
    const href = HREF.replace('network=arc-testnet', `network=${BASE_SEPOLIA_PAYOUT.reviewNetwork}`);
    const rows = usdcxPayoutRowsText(BASE_SEPOLIA_PAYOUT.chainId, BURN.amount);
    const page = pageWith(async js => {
      if (js.includes('location.href')) return { href, hash: href.slice(href.indexOf('#')), submit: true };
      if (js.includes('function row(')) {
        return {
          network: BASE_SEPOLIA_PAYOUT.networkName,
          networkFee: enText('usdcxSponsorshipFee', { symbol: 'USDCX' }),
          fee: rows.fee,
          net: rows.net,
          notice: enText('usdcxWithdrawalNotice')
        };
      }
      if (js.includes('bridge-route-usdcx')) {
        return {
          checked: 'true',
          cardText: 'USDCx (Circle xReserve)USDCX fees',
          fee: rows.fee,
          net: rows.net,
          notice: enText('usdcxWithdrawalNotice')
        };
      }
      return spikeAnswer(js, { pressed: baseChip });
    });
    const selectors = stubDom(page);

    const result = await page.burnUsdcxViaSendFlow({ ...BURN, payout: BASE_SEPOLIA_PAYOUT });

    expect(result.reviewRoute).toBe(href.slice(href.indexOf('#')));
    expect(selectors.filter(selector => selector.includes('send-network-'))).toEqual([
      `${SEND} [data-testid="${baseChip}"]`
    ]);
  }, 15_000);
```

5. Add a new describe after `describe('IosWalletPage bridge deposit helpers', ...)`:

```ts
describe('IosWalletPage.selectBridgeNetwork', () => {
  it('opens the network drawer from the bridge layer, picks the chain and waits until the row names it', async () => {
    const bridge = '[data-page-layer="/bridge/deposit"]';
    const bodies: string[] = [];
    // The row's spans: the label, the network, and the line under them.
    const page = pageWith(async js => {
      bodies.push(js);
      return ['NetworkSepolia', 'Network', 'Sepolia', 'Receive on Sepolia, arrives as USDCX'];
    });
    const click = jest.fn(async (_selector: string) => undefined);
    const waitFor = jest.fn(async (_selector: string, _opts: { timeoutMs?: number }) => undefined);
    Object.assign(page as unknown as Record<string, unknown>, { click, waitFor });

    await page.selectBridgeNetwork('sepolia', 'Sepolia');

    expect(click.mock.calls.map(([selector]) => selector)).toEqual([
      `${bridge} [data-testid="bridge-network-selector"]`,
      '[data-testid="bridge-network-sepolia"]'
    ]);
    // The drawer portals to <body>, outside the layer, as the token drawer does.
    expect(waitFor).toHaveBeenCalledWith('[data-testid="bridge-network-sepolia"]', { timeoutMs: 10_000 });
    expect(bodies.some(js => js.includes(JSON.stringify(`${bridge} [data-testid="bridge-network-selector"]`)))).toBe(
      true
    );
  });
});

describe('networkRowNames', () => {
  // "Sepolia" is part of "Base Sepolia", "Arbitrum Sepolia" and the row's whole text, so only a span equal to it counts.
  it.each([
    [['NetworkSepolia', 'Network', 'Sepolia'], 'Sepolia', true],
    [['NetworkBase Sepolia', 'Network', 'Base Sepolia', 'Receive on Base Sepolia, arrives as USDCX'], 'Sepolia', false],
    [['NetworkArc Testnet', 'Network', 'Arc Testnet'], 'Base Sepolia', false],
    [null, 'Sepolia', false]
  ] satisfies Array<[readonly string[] | null, string, boolean]>)('reads %j as naming %s: %s', (spans, name, names) => {
    expect(networkRowNames(spans, name)).toBe(names);
  });
});
```

6. Replace the details case `'reads the pill and the Arc explorer links from the details layer only'` (`:681-692`) with:

```ts
  it('reads the pill and the Arc explorer links from the details layer only', async () => {
    const bodies: string[] = [];
    const view = { pill: 'Confirmed', txLinks: ['https://explorer.testnet.arc.io/tx/0xde87'] };
    const page = pageWith(async js => {
      bodies.push(js);
      return view;
    });

    await expect(page.transactionDetailsView('row-1')).resolves.toEqual(view);
    expect(bodies[0]).toContain(`document.querySelector(${JSON.stringify(LAYER)})`);
    expect(bodies[0]).toContain(JSON.stringify('https://explorer.testnet.arc.io/tx/'));
  });

  it("reads the links to the payout chain's explorer it is given", async () => {
    const bodies: string[] = [];
    const page = pageWith(async js => {
      bodies.push(js);
      return null;
    });

    await expect(page.transactionDetailsView('row-1', BASE_SEPOLIA_PAYOUT.explorer)).resolves.toEqual({
      pill: null,
      txLinks: []
    });
    expect(bodies[0]).toContain(JSON.stringify(`${BASE_SEPOLIA_PAYOUT.explorer}/tx/`));
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `yarn jest playwright/e2e/ios/helpers/ios-wallet-page.test.ts --maxWorkers=1`
Expected: FAIL: `selectBridgeNetwork is not a function` and `networkRowNames is not a function`; the Base burn case exceeds its 15 s timeout, since its chips report Base pressed and the driver still polls for Arc Testnet alone pressed; the snapshot case reads `(burn.ts)`; the payout-explorer details case reads `arcTxLinks` and Arc's prefix. The renamed Arc details case already passes (its stub returns the view as given); it stays to pin the default explorer.

- [ ] **Step 3: Implement in the page object**

In `playwright/e2e/ios/helpers/ios-wallet-page.ts` (line numbers are the file's before this step, after Task 1; each item also names its text, so apply them from the bottom up or by the text):

1. Delete `:9` (`import { ARC_TESTNET } from '../../../../src/lib/walletconnect/config';`).
2. In the `../../helpers/bridge` import (`:13-23`), replace `isArcSnapshotFailure,` with nothing and add `burnSubmitFailure,` right after `bridgedSendRowOf,`.
3. Replace `:32` (`import { ARC_CHAIN_ID } from '../../helpers/usdcx-constants';`) with:

```ts
import { ARC_PAYOUT, type PayoutChain } from '../../helpers/usdcx-constants';
```

   After `routeOf` (ends `:136`), add:

```ts

/** Whether the bridge network row's spans name `name` exactly: "Sepolia" is part of "Base Sepolia". */
export function networkRowNames(spans: readonly string[] | null, name: string): boolean {
  return spans !== null && spans.includes(name);
}
```

4. Delete `:165` (`const ARC_CHIP = 'send-network-arc-testnet';`).
5. In `UsdcxBurnViaSendOptions` (`:258-269`), replace the `destAddress` doc and add `payout`:

```ts
export interface UsdcxBurnViaSendOptions {
  /** The address Circle pays on the payout chain. Never a private key: appium-remote-debugger logs every eval body. */
  destAddress: `0x${string}`;
  /** As typed: a whole number, since the amount field follows the simulator's locale for decimals. */
  amount: string;
  nativeTokenId: string;
  nativeSymbol: string;
  /** The chain Circle pays on; Arc Testnet when absent. */
  payout?: PayoutChain;
```

(the remaining fields unchanged).

6. In `latestBridgeReceive`'s return type (`:437-445` after Task 1), add `error?: string;` after `displayMessage?: string;`.
7. After `selectBridgeToken` (ends `:489` after Task 1), add:

```ts
  /**
   * Open the network drawer from the amount step and pick the source chain `slug` (bridge-networks.ts), then wait until
   * the row names it: a Reown session that approves that chain alone refuses any other chain's prompt.
   */
  async selectBridgeNetwork(slug: string, name: string): Promise<void> {
    const row = `${IosWalletPage.BRIDGE_PAGE} [data-testid="bridge-network-selector"]`;
    await this.click(row);
    await this.waitFor(`[data-testid="bridge-network-${slug}"]`, { timeoutMs: 10_000 });
    await this.click(`[data-testid="bridge-network-${slug}"]`);
    await this.pollEval<string[] | null>(
      `the bridge network row naming ${name}`,
      `var e = document.querySelector(${JSON.stringify(row)}); if (!e) return null; ` +
        `return Array.from(e.querySelectorAll('span')).map(function (s) { return (s.textContent || '').trim(); });`,
      spans => networkRowNames(spans, name),
      10_000
    );
  }
```

8. Replace `confirmBridgeRouteUsdcx` (`:514-521` after Task 1, its doc comment included, the blank line after it kept) with:

```ts
  /**
   * Confirm the Circle USDC route and continue to review. The route step shows one card, already selected, so the step
   * only confirms; on the executor route Confirm also waits for the balance read and Circle's quoted fee.
   */
  async confirmBridgeRouteUsdcx(timeoutMs = 15_000): Promise<void> {
    await this.waitFor('[data-testid="bridge-route-usdcx"]', { timeoutMs: 15_000 });
    await this.clickWhenEnabled('[data-testid="bridge-route-confirm"]', timeoutMs);
  }
```

9. In `burnUsdcxViaSendFlow`, replace the doc comment and the first lines (`:639-652` after Task 1, from `  /**` above `   * Burns the native USDCx to an Arc Testnet address` through `    const payout = usdcxPayoutRowsText(ARC_CHAIN_ID, opts.amount);`) with:

```ts
  /**
   * Burns the native USDCx to an address on `opts.payout` (Arc Testnet by default) through the real Send UI and returns
   * once the wallet is on the generating page. Every read is scoped (SEND_FLOW, SEND_REVIEW). Checks on the way: exactly
   * the four USDCx chips with that chain's alone pressed, the route card, the payout rows and the notice on the route
   * and the review, and the review's network and fee rows; a refusal is named from `review-error`, never left to a
   * timeout. Nothing is submitted once `signal` has aborted (R26).
   */
  async burnUsdcxViaSendFlow(opts: UsdcxBurnViaSendOptions): Promise<UsdcxBurnSubmission> {
    const chain = opts.payout ?? ARC_PAYOUT;
    const symbol = opts.nativeSymbol.trim();
    if (symbol === '' || symbol.toUpperCase() === 'MIDEN') {
      throw new Error(`burnUsdcxViaSendFlow: "${opts.nativeSymbol}" cannot name USDCx, the asset a USDCx burn spends`);
    }
    // Throws before any UI when the amount does not exceed the payout chain's fee allowance (R14a).
    const payout = usdcxPayoutRowsText(chain.chainId, opts.amount);
```

10. Replace the chip click and its poll (`:675-682` after Task 1, from `    // A chip kept from an earlier attempt overrides the default, so Arc is pressed explicitly every time.` through the poll's closing `    );`):

```ts
    // A chip kept from an earlier attempt overrides the default, so the payout chain's chip is pressed every time.
    await this.click(`${SEND_FLOW} [data-testid="${chain.chip}"]`);
    await this.pollEval<NetworkChipState[] | null>(
      `${chain.networkName} alone pressed among the four USDCx chips`,
      SEND_CHIPS_JS,
      chips => chips !== null && usdcxChipsProblem(chips, chain.chip) === undefined,
      15_000
    );
```

11. At `:711` after Task 1, replace `network: 'arc-testnet'` with `network: chain.reviewNetwork`.
12. At `:723` after Task 1, replace `view.network === ARC_TESTNET.name &&` with `view.network === chain.networkName &&`.
13. Replace `:765-770` after Task 1 (from `const error = outcome.error ?? '';` through the closing `);` of `throw new Error(...)`) with:

```ts
      throw new Error(burnSubmitFailure(chain, outcome.error ?? '', fresh.length));
```

14. Replace `transactionDetailsView` (`:824-837` after Task 1, its doc comment included) with:

```ts
  /** The open details page's status pill and every transaction link it renders to `explorer`, Arc Testnet's by default. */
  async transactionDetailsView(
    rowId: string,
    explorer: string = ARC_PAYOUT.explorer
  ): Promise<{ pill: string | null; txLinks: string[] }> {
    const prefix = `${explorer}/tx/`;
    const view = await ridingOut(() =>
      this.cdp.eval<{ pill: string | null; txLinks: string[] } | null>(
        `var root = document.querySelector(${JSON.stringify(detailsLayer(rowId))}); if (!root) return null; ` +
          `var pill = root.querySelector('[data-testid="history-status-pill"]'); ` +
          `return { pill: pill ? (pill.textContent || '').trim() : null, ` +
          `txLinks: Array.from(root.querySelectorAll('a[href]')).map(function (a) { return a.getAttribute('href') || ''; })` +
          `.filter(function (h) { return h.indexOf(${JSON.stringify(prefix)}) === 0; }) };`
      )
    );
    return view ?? { pill: null, txLinks: [] };
  }
```

`ARC_PAYOUT.explorer` is `getChain(5042002).explorer` (`playwright/e2e/helpers/usdcx-constants.ts:199`), which is `ARC_TESTNET.blockExplorers.default.url` (`src/lib/walletconnect/config.ts:17, :70`), so Arc's prefix is unchanged.

In `playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts`, change `.arcTxLinks;` to `.txLinks;` at `:748` and `:751`.

- [ ] **Step 4: Run the directory's tests**

Run: `yarn jest playwright/e2e/ios/helpers --maxWorkers=1`
Expected: PASS.

- [ ] **Step 5: Mutation check**

In `networkRowNames`, temporarily replace `spans.includes(name)` with `spans.some(span => span.includes(name))` and rerun `yarn jest playwright/e2e/ios/helpers/ios-wallet-page.test.ts --maxWorkers=1`: the Base Sepolia row case fails. Restore and rerun: PASS.

- [ ] **Step 6: Format, lint, dash check, commit, push**

```bash
F="playwright/e2e/ios/helpers/ios-wallet-page.ts playwright/e2e/ios/helpers/ios-wallet-page.test.ts playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts"
yarn prettier --check ${=F}
yarn eslint --max-warnings 0 ${=F}
perl -CSD -ne 'print "$ARGV:$.: $_" if /[\x{2013}\x{2014}]/' ${=F}
git add ${=F}
git commit -m "ios page: bridge network picker, wider usdcx route confirm, burns to any payout chain"
git push
```

---

### Task 8: Share the live burn half between the iOS specs

**Why:** the executor spec's second half is the Arc spec's burn half with another payout chain (`usdcx-live-deposit.ios.spec.ts:452-765`), and the shared extension helpers it calls already take a payout chain (`payoutLeg`'s `payoutReads`, `playwright/e2e/helpers/usdcx-legs.ts:628-691`; `waitForWalletPayoutConfirmation`'s `arc.payoutChain`, `:721-777`). Copying 300 lines would let the two drift. This task moves that half and its helpers into one module with no change in what the Arc spec checks; the Arc job's own dispatch in the Delivery section proves it. Values for Arc are identical: `ARC_PAYOUT.chainId` is `ARC_CHAIN_ID`, `.burnDomain` is `ARC_CIRCLE_DOMAIN`, `.burnUnits` is `BURN_UNITS`, `.label` is `Arc` (`usdcx-constants.ts:72-77, :187-212`).

**Files:**
- Create: `playwright/e2e/ios/helpers/usdcx-live.ts`
- Modify: `playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts` (lines 1-59, 105-141, 158-230, 452-765, through a checked script)
- Modify (whole file below): `playwright/e2e/harness/usdcx-live-spec.test.ts`

**Interfaces:**
- Consumes: Task 7's `burnUsdcxViaSendFlow({ payout })` and `transactionDetailsView(rowId, explorer)`.
- Produces (all exported from `usdcx-live.ts`): `VAULT_MS`; `BURN_BUDGET`; `noteIdsOf(row: TransactionRowSnapshot): string[]`; `settleLedger(wallet: IosWalletPage, native: IosNativeAsset, term: { name: string; before: bigint; credit: bigint; debits: bigint; row: { id: string; feeAmount?: string; resultReleasedAt?: number } }): Promise<{ vault: bigint; fee: FeeTerm }>`; `evidenceBody(evidence: RunEvidence, secrets: readonly string[]): string`; `assertHostedGuardianAccount(step: NamedStep, wallet: IosWalletPage, opts: { address: string; guardianUrl: string; evidence: RunEvidence }): Promise<GuardianIdentity>`; `interface BurnHalf { step; wallet; address; native; envConfig: { name: string; rpcUrl: string }; identity; vaultBefore: bigint; arc: ArcReadDeps; payoutReads?: ArcReadDeps; depositKey: PayoutKey; evidence; secrets: string[]; screenshotDir: string }`; `burnBackToDepositKey(ctx: BurnHalf): Promise<void>`. Task 9 uses all of them.

- [ ] **Step 1: Write the pin test for the new shape (it fails first)**

Replace the whole of `playwright/e2e/harness/usdcx-live-spec.test.ts` with:

```ts
/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (path: string): string => readFileSync(resolve(__dirname, path), 'utf8');
const arcSpec = read('../ios/tests/usdcx-live-deposit.ios.spec.ts');
const burnHalf = read('../ios/helpers/usdcx-live.ts');

/** The source between two step names, so a check is pinned to the step that owns it. */
function between(source: string, from: string, to: string): string {
  const start = source.indexOf(`'${from}'`);
  const end = source.indexOf(`'${to}'`, start);
  if (start === -1 || end === -1) throw new Error(`no step '${start === -1 ? from : to}'`);
  return source.slice(start, end);
}

/** The markers that do not come after the one before them. */
function outOfOrder(source: string, markers: readonly string[]): string[] {
  const at = markers.map(marker => source.indexOf(marker));
  return markers.filter((_marker, i) => (at[i] ?? -1) <= (i === 0 ? -1 : (at[i - 1] ?? -1)));
}

describe('the live iOS USDCx spec on Arc', () => {
  // A wrong recipient strands the deposit at the faucet, so it must fail in seconds, not after Circle's 20 minutes.
  it("checks what the counterparty signed and the row's recipient before it waits on Circle", () => {
    expect(between(arcSpec, 'assert_deposit_broadcast', 'row_reaches_delivering')).toMatch(
      /remoteRecipient: recipient,\s*maxFee: 0n,\s*hookData: '0x'/
    );
    expect(between(arcSpec, 'row_reaches_delivering', 'circle_attests_deposit')).toMatch(/usdcxRemoteRecipient/);
  });

  // A dispatch sets the deposit amount; one the wallet will not claim unattended must fail before anything is sent.
  it('refuses a deposit the wallet would leave unclaimed before it pairs the counterparty', () => {
    expect(between(arcSpec, 'native_asset', 'connect_evm')).toMatch(/isWorthClaiming\(depositUnits, read\.baseFee\)/);
  });

  // R24: an Arc URL can carry an API key in its path, and the evidence holds neither a key nor the password.
  it('names Arc endpoints by host and writes the evidence only through its refusal of secrets', () => {
    expect(arcSpec).toMatch(/read on \$\{arcHost\(state\.endpoint\)\}/);
    expect(arcSpec).not.toMatch(/\$\{[\w.]*\.endpoint\}/);
    expect(arcSpec).toMatch(/fs\.writeFileSync\(evidencePath, evidenceBody\(evidence, secrets\)\)/);
  });

  // Circle's Arc payouts have run hours late, so the burn half comes last; R20: it pays the deposit key back.
  it('burns back to its own deposit key, only after the deposit leg', () => {
    expect(outOfOrder(arcSpec, ["'relayer_mints_and_wallet_claims'", "'deposit_vault'", 'await burnBackToDepositKey('])).toEqual(
      []
    );
    expect(arcSpec).toMatch(/const depositKey: PayoutKey = \{\s*key: \{ address: evmAddress,/);
    expect(arcSpec).toMatch(/burnBackToDepositKey\(\{[\s\S]*\bdepositKey,/);
  });
});

describe('the burn half the live iOS specs share', () => {
  it('names Arc endpoints by host', () => {
    expect(burnHalf).toMatch(/read on \$\{arcHost\(state\.endpoint\)\}/);
    expect(burnHalf).not.toMatch(/\$\{[\w.]*\.endpoint\}/);
  });

  it('gates on the payout before the wallet confirmation', () => {
    expect(
      outOfOrder(burnHalf, [
        "'arc_state'",
        "'grant'",
        'await payoutLeg(step,',
        "'burn_via_send'",
        'await waitForPayout(',
        "'wallet_confirms_payout'"
      ])
    ).toEqual([]);
  });

  // R20: the payout refills the key the deposit spent, and the gate counts from the leg's read right before the burn.
  it('burns back to the deposit key and holds the wallet to the snapshot the payout gate counts from', () => {
    expect(between(burnHalf, 'settle_grant', 'burn_via_send')).toMatch(/takeKey: \(\) => ctx\.depositKey,/);
    expect(between(burnHalf, 'burn_via_send', 'burn_completed')).toMatch(/destAddress: key\.address,/);
    expect(between(burnHalf, 'burn_completed', 'burn_consumed')).toMatch(/before: snapshot\.balance\.toString\(\)/);
  });
});
```

Run: `yarn jest playwright/e2e/harness/usdcx-live-spec.test.ts --maxWorkers=1`
Expected: FAIL with `ENOENT ... usdcx-live.ts` (the module does not exist yet).

- [ ] **Step 2: Create the shared module**

Create `playwright/e2e/ios/helpers/usdcx-live.ts`:

```ts
/**
 * What the live iOS USDCx specs share: the vault read on Home, the hosted Guardian check, the evidence file, and the
 * burn half, which burns 1 USDCx from a public faucet grant through Send back to the deposit key on the payout chain.
 */
import { expect } from '@playwright/test';
import { formatUnits, isHex } from 'viem';

import { arcHost, readXReserveDomainState, type ArcReadDeps } from '../../helpers/arc-usdcx';
import { enText } from '../../helpers/bridge';
import { describeTransactionRow, TxStatus, type TransactionRowSnapshot } from '../../helpers/history';
import { mintFromPublicFaucet, publicFaucetApiUrl } from '../../helpers/public-faucet';
import { waitForPublicNoteCommitment } from '../../helpers/public-note-commitment';
import {
  ARC_PAYOUT,
  ARC_READ_STEP_BUDGET_MS,
  GRANT_UNITS,
  PAYOUT_TIMEOUT_MS,
  USDCX_DECIMALS,
  USDCX_REMOTE_DOMAIN,
  WALLET_CONFIRM_TIMEOUT_MS
} from '../../helpers/usdcx-constants';
import {
  assertNoGuardianOpInFlight,
  guardianFailureContext,
  guardianIdentity,
  type GuardianIdentity
} from '../../helpers/usdcx-guardian';
import { payoutLeg, waitForWalletPayoutConfirmation, type PayoutKey } from '../../helpers/usdcx-legs';
import { accountHex, boundLandedFee, burnEvidence, burnOutputs, note, nullifier } from '../../helpers/usdcx-miden';
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
  PhaseTimeline,
  pollUntil,
  readSettledChange,
  type FeeTerm,
  type NamedStep,
  type RunEvidence,
  type StepContext
} from '../../helpers/usdcx-run';

import type { IosNativeAsset, IosWalletPage } from './ios-wallet-page';

/** The store caught up within 5.1 s of a move Home (ios-spike-report.md section 4.1). */
export const VAULT_MS = 30_000;
/** Step budgets: each a small multiple of the slowest spike run or CI run 38109117552, floored for chain variance. */
export const BURN_BUDGET = {
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

export function noteIdsOf(row: TransactionRowSnapshot): string[] {
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
```

Then copy `settleLedger` and `evidenceBody` **verbatim** from `playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts:177-230` (the doc comment above `async function settleLedger(` through the closing `}` of `evidenceBody`), adding `export ` in front of `async function settleLedger(` and of `function evidenceBody(`. Then append:

```ts
/** The deposit landed on and was claimed by a Guardian account bound to the hosted Guardian the run identified. */
export function assertHostedGuardianAccount(
  step: NamedStep,
  wallet: IosWalletPage,
  opts: { address: string; guardianUrl: string; evidence: RunEvidence }
): Promise<GuardianIdentity> {
  return step('assert_guardian_account', BURN_BUDGET.guardianAccount, async () => {
    // The auth structure shows the deposit landed on, and was claimed by, a Guardian account, not a single-sig
    // one, so a spec cannot quietly go back to testing the single-sig path.
    const auth = await wallet.getGuardianAuthInfo(opts.address);
    expect(auth.error, `guardian auth read failed: ${auth.error}`).toBeUndefined();
    expect(auth.signerCommitments.length, 'a fresh Guardian account has 2 signers (hot, cold)').toBe(2);
    expect(auth.procedureThresholds.update_guardian, 'update_guardian is hardened to threshold 2').toBe(2);
    const hosted = await hostedGuardian(opts.guardianUrl);
    opts.evidence.guardian = {
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
    return hosted;
  });
}

export interface BurnHalf {
  step: NamedStep;
  wallet: IosWalletPage;
  /** The wallet's account: the grant goes to it and the burn comes from it. */
  address: string;
  native: IosNativeAsset;
  envConfig: { name: string; rpcUrl: string };
  identity: GuardianIdentity;
  /** The vault before the grant, read on Home by the leg before. */
  vaultBefore: bigint;
  arc: ArcReadDeps;
  /** The payout chain's reads (`payoutChain` set); absent, Circle pays on Arc and `arc` reads it. */
  payoutReads?: ArcReadDeps;
  depositKey: PayoutKey;
  evidence: RunEvidence;
  secrets: string[];
  screenshotDir: string;
}

/**
 * The burn half of a live iOS run: one public faucet grant, then a burn through Send back to the deposit key on the
 * payout chain. It passes only once Circle paid the key exactly that burn within 10 minutes of the faucet's consume
 * (one AttestationUsed log carrying the burn note id, the key's whole rise above a read taken right before the burn)
 * and the wallet itself confirmed the payout: the row's destination balance, then the History pill.
 */
export async function burnBackToDepositKey(ctx: BurnHalf): Promise<void> {
  const { step, wallet, native, evidence } = ctx;
  const chain = ctx.payoutReads?.payoutChain ?? ARC_PAYOUT;
  const where: StepContext = async () =>
    describePage(await wallet.evalJs<string>('return location.href;'), () =>
      wallet.evalJs<string>('return document.visibilityState;')
    );
  const onGuardian: StepContext = () => guardianFailureContext(ctx.identity);
  const faucetUrl = publicFaucetApiUrl(ctx.envConfig.name);
  if (!faucetUrl) throw new Error(`no public faucet for ${ctx.envConfig.name}`);

  // Before the grant, so a bridge that cannot pay this burn out costs no grant and leaves no deferred payout.
  const xreserve = await step('arc_state', BURN_BUDGET.arcState, async () => {
    const state = await readXReserveDomainState(ctx.arc);
    expect(
      { registered: state.registered, paused: state.paused, withdrawalsPaused: state.withdrawalsPaused },
      `xReserve domain ${USDCX_REMOTE_DOMAIN} read on ${arcHost(state.endpoint)}`
    ).toEqual({ registered: true, paused: false, withdrawalsPaused: false });
    return state;
  });

  const grant = await step('grant', BURN_BUDGET.grant, async () => {
    // R19: one grant from the 10 USDCx tier; asking for no amount gets the largest, 100 USDCx.
    const { noteId } = await mintFromPublicFaucet(faucetUrl, ctx.address, GRANT_UNITS);
    if (!isHex(noteId)) throw new Error(`the public faucet answered note id ${noteId}`);
    await waitForPublicNoteCommitment(ctx.envConfig.rpcUrl, noteId, 120_000);
    const asset = exactlyOne(
      (await note(ctx.envConfig.rpcUrl, noteId)).assets,
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
    BURN_BUDGET.grantConsumed,
    async () => {
      const claim = await pollUntil(
        'the wallet auto-consuming the grant',
        async () =>
          (await wallet.readTransactionRows({ type: 'consume' })).find(row =>
            noteIdsOf(row).includes(grant.noteId.toLowerCase())
          ),
        row => row?.status === TxStatus.Completed || row?.status === TxStatus.Failed,
        { timeoutMs: BURN_BUDGET.grantConsumed - VAULT_MS - 30_000, intervalMs: 3_000, describe: () => where() }
      );
      if (claim?.status !== TxStatus.Completed) {
        throw new Error(`the grant's consume failed: ${claim ? describeTransactionRow(claim) : 'no row'}`);
      }
      const settled = await settleLedger(wallet, native, {
        name: 'f0',
        before: ctx.vaultBefore,
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
    BURN_BUDGET.settle,
    async () => {
      const started = Date.now();
      await pollUntil(
        'the grant consume committing',
        () => nullifier(ctx.envConfig.rpcUrl, grant.noteId),
        read => read.committed,
        { timeoutMs: BURN_BUDGET.settle - GUARDIAN_SETTLE_MS - 10_000, intervalMs: 3_000 }
      );
      await wallet.delay(GUARDIAN_SETTLE_MS);
      assertNoGuardianOpInFlight(await wallet.readTransactionRows(), ctx.address);
      return Date.now() - started;
    },
    onGuardian
  );

  // The leg reads the key right before the burn, after the deposit's own transactions were mined, and its payout gate
  // counts only what this burn adds above that read (R21, R22); the label names the key Circle pays in every failure.
  const { key, snapshot, waitForPayout } = await payoutLeg(step, {
    takeKey: () => ctx.depositKey,
    arc: ctx.arc,
    payoutReads: ctx.payoutReads,
    budget: BURN_BUDGET,
    evidence,
    secrets: ctx.secrets
  });

  const submission = await step(
    'burn_via_send',
    BURN_BUDGET.burnViaSend,
    signal =>
      wallet.burnUsdcxViaSendFlow({
        destAddress: key.address,
        amount: formatUnits(chain.burnUnits, USDCX_DECIMALS),
        nativeTokenId: native.tokenId,
        nativeSymbol: native.symbol,
        payout: chain,
        screenshotDir: ctx.screenshotDir,
        // R26: an overrun step never submits the burn after its test failed.
        signal
      }),
    onGuardian
  );
  evidence.ids.burnRow = submission.rowId;
  evidence.notes.push(
    `review ${submission.reviewRoute}`,
    `generating ${submission.generatingRoute}`,
    `chips pressed before the ${chain.networkName} click: ${submission.defaultPressed.join(', ') || 'none'}`
  );

  const burned = await step(
    'burn_completed',
    BURN_BUDGET.burnCompleted,
    async () => {
      const { row, stages } = await wallet.waitForBurnCompleted(submission.rowId, BURN_BUDGET.burnCompleted - 15_000);
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
        `burn row ${row.id}; the leg read ${snapshot.balance} on the key at ${chain.label} block ` +
          `${snapshot.blockNumber} right before the burn`
      ).toEqual({
        provider: 'usdcx',
        to: key.address.toLowerCase(),
        chain: chain.chainId,
        domain: chain.burnDomain,
        // The wallet's own snapshot of the key must be the one the payout gate counts from.
        before: snapshot.balance.toString()
      });
      evidence.notes.push(`burn stages ${JSON.stringify(stages)}`);
      return {
        row,
        burnNoteId,
        payoutFromBlock: BigInt(usdcxBurn?.destinationBalanceBefore?.blockNumber ?? '0')
      };
    },
    onGuardian
  );
  evidence.ids.burnNote = burned.burnNoteId;
  evidence.hashes.burnTransaction = burned.row.transactionId ?? 'none';

  const consumed = await step(
    'burn_consumed',
    BURN_BUDGET.burnConsumed,
    async () => {
      // The wallet's watcher moves the phase only while a wallet page is visible, so the run waits on Home.
      await wallet.navigateHome();
      const phases = new PhaseTimeline('burn row', BURN_PHASES);
      await pollUntil(
        'the faucet consuming the burn note',
        async () => {
          const rows = await wallet.readBridgedSendRows();
          const phase = rows.find(row => row.id === burned.row.id)?.extraInputs?.usdcxBurn?.phase;
          phases.record(phase, Date.now());
          if (phase === 'discarded') throw new Error(`the node discarded burn note ${burned.burnNoteId}`);
          return phase;
        },
        phase => phase === 'confirmed',
        { timeoutMs: BURN_BUDGET.burnConsumed - VAULT_MS - 60_000, intervalMs: 3_000, describe: () => where() }
      );
      phases.assertMonotone();
      evidence.phases.burn = phases.samples();
      const oracle = await burnEvidence(ctx.envConfig.rpcUrl, {
        faucetBech32: native.tokenId,
        noteId: burned.burnNoteId,
        senderBech32: ctx.address,
        domain: chain.burnDomain,
        recipient: key.address,
        amount: chain.burnUnits
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
          ['N', chain.burnUnits],
          ['s', oracle.sponsorshipUnits],
          ['f1', BigInt(burned.row.feeAmount ?? '-1')]
        ]);
        if (read !== want) throw new Error(`the burn's outputs by role read ${read}, expected ${want}`);
      }
      // Only the local completion path lists the burn note; a landed one rests on the oracle above (R24).
      const unlisted = burnOutputNoteProblem(completion, burned.row, burned.burnNoteId);
      if (unlisted !== undefined) throw new Error(unlisted);
      const settled = await settleLedger(wallet, native, {
        name: 'f1',
        before: grantedVault,
        credit: 0n,
        debits: chain.burnUnits + oracle.sponsorshipUnits,
        row: burned.row
      });
      evidence.fees.push(settled.fee, { name: 's', amount: oracle.sponsorshipUnits, kind: 'exact' });
      evidence.notes.push(
        `burn ledger ${ledgerLine([
          ['V1', grantedVault],
          ['N', chain.burnUnits],
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
  // D3 in delta mode, a hard gate (the leg's payout step): exactly one AttestationUsed log whose gatewayMint carries
  // the burn note id, by the consume plus 10 min, that adds exactly its value to the key's balance above the snapshot.
  const payout = await waitForPayout({ burnNoteId: burned.burnNoteId, oracle: consumed }, xreserve.depositor);

  // Q6, a hard gate: the wallet's own destination check confirms the payout Circle made.
  const confirmedAt = await step('wallet_confirms_payout', BURN_BUDGET.walletConfirmed, async () => {
    await wallet.navigateHome();
    const at = await waitForWalletPayoutConfirmation({
      readRows: () => wallet.readBridgedSendRows(),
      rowId: burned.row.id,
      arcFromBlock: burned.payoutFromBlock,
      payout,
      key,
      arc: ctx.payoutReads ?? ctx.arc,
      where,
      evidence
    });
    await wallet.openTransactionDetails(burned.row.id);
    const pills: string[] = [];
    await pollUntil(
      'the History pill reading Confirmed',
      async () => {
        const { pill } = await wallet.transactionDetailsView(burned.row.id, chain.explorer);
        if (pill !== null && pills[pills.length - 1] !== pill) pills.push(pill);
        return pill;
      },
      pill => pill === enText('confirmed'),
      { timeoutMs: 30_000, intervalMs: 1_000 }
    );
    evidence.notes.push(`history pill ${pills.join(' then ')}`);
    // The receiving-tx link is a best-effort RPC match (CLAUDE.md), so only a link to another transaction fails.
    const linkDeadline = Date.now() + RECEIVING_TX_LINK_MS;
    let links = (await wallet.transactionDetailsView(burned.row.id, chain.explorer)).txLinks;
    while (links.length === 0 && Date.now() < linkDeadline) {
      await wallet.delay(1_000);
      links = (await wallet.transactionDetailsView(burned.row.id, chain.explorer)).txLinks;
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
    await wallet.navigateHome();
    return at;
  });
  evidence.latenciesMs.payoutToWalletConfirmation = confirmedAt - (consumeTsMs + payout.latencyMs);
}
```

- [ ] **Step 3: Cut the Arc spec over, bottom-up, with every boundary checked**

Create `/private/tmp/claude-501/-Users-celrisen/db8fab66-f5d7-4097-9a35-f658575da152/scratchpad/cut-arc-spec.py` with the content below and run it with `python3 -I <that path> playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts`. It refuses to write unless each boundary line is the one this plan read at `fd614122d` (after Task 7, which changed no line count of this file).

```python
import sys

path = sys.argv[1]
lines = open(path, encoding='utf-8').read().split('\n')


def expect(number, starts):
    actual = lines[number - 1]
    if not actual.startswith(starts):
        sys.exit(f'line {number} is {actual!r}, expected it to start with {starts!r}; nothing written')


expect(1, "import fs from 'fs';")
expect(59, "import { WcCounterparty, type WcRequestLog } from '../helpers/wc-counterparty';")
expect(105, '/** The store caught up within 5.1 s')
expect(141, 'const RECEIVING_TX_LINK_MS = 15_000;')
expect(158, '')
expect(159, 'function noteIdsOf(row: TransactionRowSnapshot): string[] {')
expect(230, '}')
expect(232, "test.describe('Bridge-IN deposit (Circle xReserve/USDC, live testnets)'")
expect(452, '      // The identity is read here, after the deposit leg')
expect(765, '      evidence.latenciesMs.payoutToWalletConfirmation = ')
expect(766, '    } finally {')

BURN_HALF = '''      // The identity is read here, after the deposit leg, so a Guardian endpoint glitch cannot stop that leg running.
      const identity = await assertHostedGuardianAccount(step, walletA, {
        address: addressA,
        guardianUrl: envConfig.guardianUrl,
        evidence
      });

      // R20: the burn pays the deposit key back, so each run refills what its deposit leg spent. It comes last: Circle's
      // Arc payouts have run hours late, and this order lets one redden the run only after the deposit leg passed.
      const depositKey: PayoutKey = {
        key: { address: evmAddress, privateKey: `0x${evmPrivateKey.replace(/^0x/i, '')}` },
        role: 'deposit',
        label: `deposit key ${evmAddress} (USDCX_LIVE_EVM_PRIVATE_KEY), which Circle pays,`
      };
      await burnBackToDepositKey({
        step,
        wallet: walletA,
        address: addressA,
        native,
        envConfig,
        identity,
        vaultBefore: depositVault,
        arc,
        depositKey,
        evidence,
        secrets,
        screenshotDir: path.join(steps.outputDir, 'usdcx-burn')
      });'''.split('\n')

DEPOSIT_BUDGET = '''/** Deposit-leg step budgets: each a small multiple of the slowest spike run or CI run 38109117552. */
const BUDGET = {
  // spike 0.2 s for the cache, plus the oracle's account-hex read and a store that lands after Ready
  nativeAsset: 90_000,
  // CI 5.2 s for the old balance step (run 38109117552), plus the rows and the Home wait
  depositVault: 120_000
};'''.split('\n')

IMPORTS = '''import fs from 'fs';
import path from 'path';
import { decodeFunctionData, isHash, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { fetchXReserveAttestations, findAttestationForDomain } from '../../../../src/lib/usdcx/attestation-protocol';
import { CIRCLE_USDC_DECIMALS, XRESERVE_ABI } from '../../../../src/lib/usdcx/protocol';
import { midenAccountHexToXReserveRecipient } from '../../../../src/lib/usdcx/recipient';
import { ARC_TESTNET } from '../../../../src/lib/walletconnect/config';
import { arcEndpoints, arcHost, readArcUsdc, readXReserveDomainState, type ArcReadDeps } from '../../helpers/arc-usdcx';
import { parseBridgeReceiveState } from '../../helpers/bridge';
import { describeTransactionRow, TxStatus } from '../../helpers/history';
import { USDCX_REMOTE_DOMAIN, getUsdcxXReserveSource } from '../../helpers/usdcx-config';
import { CLAIM_COST_FEE_MULTIPLE, GAS_RESERVE_UNITS, isWorthClaiming } from '../../helpers/usdcx-constants';
import type { PayoutKey } from '../../helpers/usdcx-legs';
import { accountHex } from '../../helpers/usdcx-miden';
import { readUsdcxRelayerEnv, UsdcxRelayer } from '../../helpers/usdcx-relayer';
import { exactlyOne, namedSteps, newRunEvidence, PhaseTimeline, pollUntil } from '../../helpers/usdcx-run';
import { expect, test } from '../fixtures/two-simulators';
import {
  assertHostedGuardianAccount,
  burnBackToDepositKey,
  evidenceBody,
  noteIdsOf,
  settleLedger
} from '../helpers/usdcx-live';
import { WcCounterparty, type WcRequestLog } from '../helpers/wc-counterparty';'''.split('\n')

# Bottom-up, so each earlier range keeps its line numbers.
lines[452 - 1:765] = BURN_HALF
lines[158 - 1:230] = []
lines[105 - 1:141] = DEPOSIT_BUDGET
lines[1 - 1:59] = IMPORTS
open(path, 'w', encoding='utf-8').write('\n'.join(lines))
print('cut over')
```

Expected output: `cut over`. Then read the result around the cut points (`sed -n 1,30p`, the `BUDGET` block, the line before `test.describe`, and the block from `// The identity is read here` to `} finally {`) and confirm each matches the text above.

- [ ] **Step 4: Run the pin test and its directory**

Run: `yarn jest playwright/e2e/harness --maxWorkers=1`
Expected: PASS.

- [ ] **Step 5: Mutation check on the moved pins**

In `usdcx-live.ts`, temporarily change `takeKey: () => ctx.depositKey,` to `takeKey: () => ({ ...ctx.depositKey }),` and rerun `yarn jest playwright/e2e/harness/usdcx-live-spec.test.ts --maxWorkers=1`: the burn-half pin fails. Restore and rerun: PASS.

- [ ] **Step 6: Format, lint, dash check, commit, push**

```bash
F="playwright/e2e/ios/helpers/usdcx-live.ts playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts playwright/e2e/harness/usdcx-live-spec.test.ts"
yarn prettier --check ${=F}
yarn eslint --max-warnings 0 ${=F}
perl -CSD -ne 'print "$ARGV:$.: $_" if /[\x{2013}\x{2014}]/' ${=F}
git add ${=F}
git commit -m "ios live usdcx: share the burn half between specs"
git push
```

CI's `tsc` is the check that no import the cut removed is still used and none it kept is now unused (`noUnusedLocals`).

---

### Task 9: The live executor-route spec, one test per source chain, and its pins

**Why:** the only E2E of the deposit screen's executor branch today signs in Node and creates the row through a hook (`playwright/e2e/tests/usdcx/usdcx-in-l2.spec.ts:170-200`), so `prepareNativeSessionChain` on a source chain, `sendNative` there and the screen's own balance, quote and approve logic (`EvmBridgeDepositScreen.tsx:947-1100`) have no E2E. Production routes Base Sepolia, Arbitrum Sepolia and Ethereum Sepolia USDCx through the executor and only Arc through xReserve (live `0xMiden/wallet-config` `testnet.json` version 10, usdcx-ios scout 1.4), and the user asked for all three (decision 3 of 2026-10-17). This spec drives that branch on iOS through a real Reown pairing, one test per source chain of `L2_BRIDGE_IN_SOURCES` (the loop `usdcx-in-l2.spec.ts:85` uses), reuses the Chrome executor gates hop by hop, and pays the key back on the source chain. A job runs one chain by naming its slug in `USDCX_LIVE_SOURCE`; the spec then defines that chain's test alone, so no other chain's preflight runs. **[I]** Being the first E2E of that branch, its first runs may surface product findings; the Delivery loop fixes them in this PR.

**Files:**
- Create: `playwright/e2e/ios/tests/usdcx-live-executor-deposit.ios.spec.ts`
- Modify: `playwright/e2e/harness/usdcx-live-spec.test.ts` (append a describe)

**Interfaces:**
- Consumes: Task 2 (`WcCounterparty` `sessionChainIds`, `send`, `WcRequestLog.chainId`), Task 3 (`bridge-network-selector`), Task 4 (`cctpForwarded`, `cctpForwardFee`), Task 5 (`createL2Sender`), Task 6 (`executorDepositRequests`, `L2BurnSubmission`, `l2KeyShortfall({ refill })`, `payoutKeyProblem`), Task 7 (`selectBridgeNetwork`, `confirmBridgeRouteUsdcx(timeoutMs)`, `latestBridgeReceive().error`), Task 8 (`assertHostedGuardianAccount`, `burnBackToDepositKey`, `evidenceBody`, `settleLedger`, `VAULT_MS`). From the extension harness: `l2Reads`, `readL2KeyFunds`, `quoteL2Deposit`, `l2KeyShortfall` (`usdcx-l2-deposit.ts`), `confirmL2Burn`, `waitForIrisForward`, `confirmArcForward` (`usdcx-cctp-proof.ts`), `waitForXReserveAttestation`, `assertDepositIntent`, `readXReserveDomainState`, `onFirstEndpoint` (`arc-usdcx.ts`), `deriveUsdcxMintNoteId`, `waitForUsdcxMint`, `accountHex`, `bareId` (`usdcx-miden.ts`), `L2_BRIDGE_IN_SOURCES` (`usdcx-constants.ts`: Base Sepolia, Arbitrum Sepolia, Ethereum Sepolia, in that order).
- Produces: the spec file name `usdcx-live-executor-deposit.ios.spec.ts`, which Task 10's workflow filter `usdcx-live-executor-deposit.ios` selects and the Arc filter `usdcx-live-deposit.ios` does not (Playwright file filters are regular expressions over the path; `usdcx-live-deposit` is not a substring of `usdcx-live-executor-deposit`); the env var `USDCX_LIVE_SOURCE`, whose values are the sources' `payout.reviewNetwork` slugs (`base-sepolia`, `arbitrum-sepolia`, `sepolia`, from `evmChainSlug`, `src/lib/remote-config/chains.ts:14-21`), which Task 10's matrix sets.

- [ ] **Step 1: Add the pins (they fail first)**

Append to `playwright/e2e/harness/usdcx-live-spec.test.ts`:

```ts
describe('the live iOS USDCx deposits on the executor route', () => {
  const executorSpec = read('../ios/tests/usdcx-live-executor-deposit.ios.spec.ts');

  // Each job runs one source chain; a slug that names none fails the file instead of running nothing.
  it('defines one test per executor source, only the one USDCX_LIVE_SOURCE names when it is set', () => {
    expect(executorSpec).toMatch(
      /if \(SELECTED_SOURCE !== '' && !SOURCE_SLUGS\.includes\(SELECTED_SOURCE\)\) \{[\s\S]{0,200}?throw new Error\(/
    );
    expect(executorSpec).toMatch(
      /SELECTED_SOURCE === ''\s*\?\s*L2_BRIDGE_IN_SOURCES\s*:\s*L2_BRIDGE_IN_SOURCES\.filter\(l2 => l2\.payout\.reviewNetwork === SELECTED_SOURCE\)/
    );
    expect(executorSpec).toMatch(/for \(const l2 of SOURCES\) \{/);
  });

  // Circle's Sepolia forwarder cannot mint to an address with no USDC, so that key is refused before anything is spent.
  it('refuses a key Circle cannot pay, then a key short of gas or USDC, before the simulators start', () => {
    expect(executorSpec).toMatch(
      /test\.beforeAll\(async \(\) => \{[\s\S]*?payoutKeyProblem\(chain, address, funds\.usdc\) \?\?\s*l2KeyShortfall\(/
    );
  });

  // The session approves the source chain alone, so the key can never be asked to sign on Arc, where a stray spend
  // would land in the Arc job's payout window, and every transaction goes through the pinned, tip-capped sender.
  it('pairs a counterparty that approves its source chain alone and sends through the L2 sender', () => {
    expect(executorSpec).toMatch(/sessionChainIds: \[chain\.chainId\]/);
    expect(executorSpec).toMatch(/send: \(tx, signal\) => sender\.send\(tx, signal\)/);
  });

  // What the wallet asked the key to sign and the burn on chain are checked in seconds, before Circle's minutes.
  it('gates the requests and the burn before it waits on Circle, and burns back only after the claim', () => {
    expect(
      outOfOrder(executorSpec, [
        "'deposit_via_ui'",
        "'deposit_requests'",
        "'source_burn'",
        "'iris'",
        "'arc_forward'",
        "'attest'",
        "'mint'",
        "'receive'",
        'await burnBackToDepositKey('
      ])
    ).toEqual([]);
  });

  it('burns back to the deposit key on its source chain', () => {
    expect(executorSpec).toMatch(/const reads = l2Reads\(l2\);/);
    expect(executorSpec).toMatch(/burnBackToDepositKey\(\{[\s\S]*payoutReads: reads,[\s\S]*\bdepositKey,/);
  });

  it('names endpoints by host and writes the evidence only through its refusal of secrets', () => {
    expect(executorSpec).not.toMatch(/\$\{[\w.]*\.endpoint\}/);
    expect(executorSpec).toMatch(/fs\.writeFileSync\(evidencePath, evidenceBody\(evidence, secrets\)\)/);
  });
});
```

Run: `yarn jest playwright/e2e/harness/usdcx-live-spec.test.ts --maxWorkers=1`
Expected: FAIL with `ENOENT ... usdcx-live-executor-deposit.ios.spec.ts`.

- [ ] **Step 2: Write the spec**

Create `playwright/e2e/ios/tests/usdcx-live-executor-deposit.ios.spec.ts`:

```ts
import fs from 'fs';
import path from 'path';
import { formatUnits, isHash, type Hash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { matchUsdcxDepositAttestation } from '../../../../src/lib/usdcx/attestation-protocol';
import { CIRCLE_USDC_DECIMALS } from '../../../../src/lib/usdcx/protocol';
import { midenAccountHexToXReserveRecipient } from '../../../../src/lib/usdcx/recipient';
import {
  arcEndpoints,
  arcHost,
  assertDepositIntent,
  ERC20_ABI,
  onFirstEndpoint,
  readXReserveDomainState,
  waitForXReserveAttestation,
  type ArcReadDeps
} from '../../helpers/arc-usdcx';
import { parseBridgeReceiveState, type BridgeReceiveStateSnapshot } from '../../helpers/bridge';
import { describeTransactionRow, TxStatus } from '../../helpers/history';
import { createL2Sender } from '../../helpers/l2-sender';
import { confirmArcForward, confirmL2Burn, waitForIrisForward } from '../../helpers/usdcx-cctp-proof';
import {
  ARC_ATTESTATION_API,
  ARC_READ_STEP_BUDGET_MS,
  ARC_USDC,
  CLAIM_COST_FEE_MULTIPLE,
  DEPOSIT_UNITS,
  isWorthClaiming,
  L2_BRIDGE_IN_SOURCES,
  redactProjectId,
  USDCX_REMOTE_DOMAIN
} from '../../helpers/usdcx-constants';
import { executorDepositRequests } from '../../helpers/usdcx-executor-requests';
import {
  l2KeyShortfall,
  l2Reads,
  payoutKeyProblem,
  quoteL2Deposit,
  readL2KeyFunds
} from '../../helpers/usdcx-l2-deposit';
import type { PayoutKey } from '../../helpers/usdcx-legs';
import { accountHex, bareId, deriveUsdcxMintNoteId, waitForUsdcxMint } from '../../helpers/usdcx-miden';
import {
  errorText,
  exactlyOne,
  jsonObject,
  jsonString,
  namedSteps,
  newRunEvidence,
  PhaseTimeline,
  pollUntil
} from '../../helpers/usdcx-run';
import { expect, test } from '../fixtures/two-simulators';
import {
  assertHostedGuardianAccount,
  burnBackToDepositKey,
  evidenceBody,
  settleLedger,
  VAULT_MS
} from '../helpers/usdcx-live';
import { WcCounterparty, type WcRequestLog } from '../helpers/wc-counterparty';

/**
 * Bridge-IN on the executor route against the LIVE networks, one test per source chain the wallet offers there
 * (L2_BRIDGE_IN_SOURCES: Base Sepolia, Arbitrum Sepolia, Ethereum Sepolia), to Miden testnet through Circle's CCTP
 * forward to Arc. Nothing on the path is a double:
 *   1. Real Reown pairing: the app's native Reown and a headless counterparty that approves the source chain alone.
 *   2. Real UI: Receive, Cross Chain, Circle USDC, the source network, the amount, the route, Confirm.
 *   3. Real deposit: the wallet's runUsdcxExecutorDeposit asks the key to approve the fee entry point when its
 *      allowance is short, then to sign the forwarded burn; the counterparty signs through createL2Sender.
 *   4. Circle attests the burn and forwards it to Arc, its executor deposits into xReserve, Circle attests that
 *      deposit, the deployed relayer mints and the wallet claims the mint by itself.
 *   5. Only then the burn half: USDCx from a public faucet grant through Send back to the key's address on the source
 *      chain (2 USDCx to Ethereum Sepolia, 1 elsewhere), passing only once Circle paid that burn there and the wallet
 *      reads Confirmed.
 * Each hop is gated with the extension suite's executor proofs (usdcx-in-l2.spec.ts). The run never executes on Arc:
 * the session approves no Arc chain, so the key cannot be asked to sign there.
 *
 * Environment: USDCX_LIVE_EVM_PRIVATE_KEY, the key E2E USDCx Bridge-IN (live) deposits from, which needs ETH and USDC on
 * each source chain (playwright/e2e/docs/e2e-architecture.md, "The iOS job's key"); the spec skips without it.
 * USDCX_LIVE_SOURCE (base-sepolia, arbitrum-sepolia or sepolia) defines that chain's test alone, as each job of the
 * workflow does; unset, every chain runs, one after another.
 *
 * Build the app WITHOUT `E2E_EVM_RPC_URL`, so its source-chain and Arc reads go to the real RPCs.
 */

const SOURCE_SLUGS = L2_BRIDGE_IN_SOURCES.map(l2 => l2.payout.reviewNetwork);
const SELECTED_SOURCE = (process.env.USDCX_LIVE_SOURCE ?? '').trim();
if (SELECTED_SOURCE !== '' && !SOURCE_SLUGS.includes(SELECTED_SOURCE)) {
  // A typo would otherwise define no test, and the job would only say that it found none.
  throw new Error(`USDCX_LIVE_SOURCE ${SELECTED_SOURCE} names no executor source: ${SOURCE_SLUGS.join(', ')}`);
}
const SOURCES =
  SELECTED_SOURCE === '' ? L2_BRIDGE_IN_SOURCES : L2_BRIDGE_IN_SOURCES.filter(l2 => l2.payout.reviewNetwork === SELECTED_SOURCE);
// #1405: a fast round trip can go from submitting straight to received, so ready is recorded, never required.
const DEPOSIT_PHASES = ['submitting', 'delivering', 'ready', 'received'];
/**
 * The preflight's fee ceiling, before a wallet exists to quote for: scripts/e2e-real.mjs's L2_BRIDGE_IN_USDC_FLOOR_UNITS
 * assumes the same 0.05 USDC (Circle quoted 0.022404 from Base Sepolia and 0.015638 from Ethereum Sepolia on
 * 2026-10-16). The l2_key step checks the real quote.
 */
const PREFLIGHT_FORWARD_FEE = 50_000n;
const KEY_REFILL = 'a green run of the iOS executor spec pays it back there';
const BUDGET = {
  nativeAsset: 90_000,
  arcState: ARC_READ_STEP_BUDGET_MS,
  l2Key: ARC_READ_STEP_BUDGET_MS + 15_000,
  l2Sender: ARC_READ_STEP_BUDGET_MS,
  depositViaUi: 240_000,
  // The wallet's balance read, Circle's quote, the approve and its receipt on the wallet's own RPC, a second quote,
  // the burn prompt, and the sender's receipt wait and pin before it signs the burn.
  depositBroadcast: 300_000,
  rowDelivering: 180_000,
  check: 30_000,
  sourceBurn: ARC_READ_STEP_BUDGET_MS,
  // A fast transfer forwarded in 8-10 s when probed; Circle falls back to source finality (15-20 min) when its fast
  // allowance runs out, and the wallet tells users about 20 min.
  iris: 1_500_000,
  arcForward: 150_000,
  rowForward: 120_000,
  attest: 120_000,
  mint: 180_000,
  receive: 420_000
};

const evmPrivateKey = (process.env.USDCX_LIVE_EVM_PRIVATE_KEY ?? '').trim();
const keyHex: Hex = `0x${evmPrivateKey.replace(/^0x/i, '')}`;

/** A transaction request's target, lowercase. */
function targetOf(request: WcRequestLog): string | undefined {
  const [tx] = Array.isArray(request.params) ? request.params : [];
  const to: unknown = tx !== null && typeof tx === 'object' ? Reflect.get(tx, 'to') : undefined;
  return typeof to === 'string' ? to.toLowerCase() : undefined;
}

for (const l2 of SOURCES) {
  const chain = l2.payout;
  test.describe(`Bridge-IN deposit from ${chain.networkName} (Circle CCTP forward to Arc, live testnets)`, () => {
    // The worst passing run: the 13 min simulator setup cap, every deposit step at its budget (75.5 min, 25 of them
    // Circle's forward at source finality and about 15 the Reown handshake's retries) and every burn step at its
    // budget (47 min): about 136 min, rounded up.
    test.describe.configure({ mode: 'serial', timeout: 8_400_000 });
    test.skip(
      evmPrivateKey === '' || (process.env.E2E_NETWORK ?? 'testnet') !== 'testnet',
      'requires E2E_NETWORK=testnet and USDCX_LIVE_EVM_PRIVATE_KEY'
    );

    // Before the simulator setup: a key Circle cannot pay on the chain, one short of its ETH or USDC, or a wallet RPC
    // that refuses the chain fails here in seconds, naming what to fix.
    test.beforeAll(async () => {
      const address = privateKeyToAccount(keyHex).address;
      const reads = l2Reads(l2);
      const funds = await readL2KeyFunds(address, reads);
      const problem =
        payoutKeyProblem(chain, address, funds.usdc) ??
        l2KeyShortfall({
          label: chain.label,
          address,
          ...funds,
          units: DEPOSIT_UNITS,
          fee: PREFLIGHT_FORWARD_FEE,
          refill: KEY_REFILL
        });
      if (problem !== undefined) throw new Error(problem);
      try {
        await onFirstEndpoint({ ...reads, endpoints: [chain.walletRpcUrl] }, `${chain.label} head`, client =>
          client.getBlockNumber()
        );
      } catch (error) {
        throw new Error(
          `infra: the wallet reads ${chain.label} through ${chain.walletRpcName}, which did not answer: ` +
            redactProjectId(errorText(error))
        );
      }
    });

    test(`deposit USDC from ${chain.networkName} through the UI, Circle forwards it to Arc and the wallet claims it, then burn USDCx back to the key there`, async ({
      walletA,
      walletB,
      steps,
      envConfig
    }) => {
      const step = namedSteps(steps);
      const evmAddress = privateKeyToAccount(keyHex).address;
      const arc: ArcReadDeps = { endpoints: arcEndpoints(process.env.E2E_ARC_RPC_URL) };
      const reads = l2Reads(l2);
      const evidence = newRunEvidence(`usdcx-live-executor-ios ${chain.reviewNetwork}`);
      // evidenceJson refuses to write any of these.
      const secrets: string[] = [keyHex];
      const depositPhases = new PhaseTimeline('deposit row', DEPOSIT_PHASES);
      let cp: WcCounterparty | undefined;
      let addressA = '';
      let bridgeTxId = '';
      // A failed CDP read (an inspector reattach) reads as not yet; a failed row fails at once.
      const rowState = async (): Promise<BridgeReceiveStateSnapshot | undefined> => {
        const raw = await walletA.getBridgeReceiveState(bridgeTxId).catch(() => undefined);
        if (raw === undefined) return undefined;
        const state = parseBridgeReceiveState(raw);
        depositPhases.record(state.phase, Date.now());
        if (state.phase === 'failed') {
          throw new Error(`the deposit row failed: ${state.error ?? state.displayMessage ?? 'no error recorded'}`);
        }
        return state;
      };

      await steps.step('create_wallet', async () => {
        ({ address: addressA } = await walletA.createGuardianWallet());
        await walletB.createNewWallet(); // fixture requires both sims up; B takes no part
      });

      try {
        // Inside the try, so a failure here still writes the evidence.
        const { native, ids } = await step('native_asset', BUDGET.nativeAsset, async () => {
          evidence.ids.wallet = addressA;
          evidence.ids.sourceChainId = String(chain.chainId);
          const read = await walletA.nativeAsset();
          if (!isWorthClaiming(DEPOSIT_UNITS, read.baseFee)) {
            throw new Error(
              `the ${DEPOSIT_UNITS}-unit deposit does not exceed the wallet's unattended claim floor, base fee ` +
                `${read.baseFee} x ${CLAIM_COST_FEE_MULTIPLE}`
            );
          }
          return {
            native: read,
            ids: {
              accountHex: await accountHex(addressA),
              nativeHex: await accountHex(read.tokenId),
              bare: bareId(addressA),
              nativeBare: bareId(read.tokenId)
            }
          };
        });
        evidence.ids.native = native.tokenId;
        // R is derived in Node from the account id, apart from the wallet's own derivation (usdcx/deposit-target.ts).
        const recipient = midenAccountHexToXReserveRecipient(ids.accountHex);

        const xreserve = await step('arc_state', BUDGET.arcState, async () => {
          const state = await readXReserveDomainState(arc);
          expect(
            { registered: state.registered, paused: state.paused, depositsPaused: state.depositsPaused },
            `xReserve domain ${USDCX_REMOTE_DOMAIN} read on ${arcHost(state.endpoint)}`
          ).toEqual({ registered: true, paused: false, depositsPaused: false });
          expect(state.remoteToken.toLowerCase(), "xReserve's remote token is the wallet's native faucet").toBe(
            midenAccountHexToXReserveRecipient(ids.nativeHex)
          );
          return state;
        });

        const funded = await step('l2_key', BUDGET.l2Key, async () => {
          const funds = await readL2KeyFunds(evmAddress, reads);
          const quote = await quoteL2Deposit(l2, { units: DEPOSIT_UNITS, recipient, depositor: evmAddress });
          const shortfall = l2KeyShortfall({
            label: chain.label,
            address: evmAddress,
            ...funds,
            units: DEPOSIT_UNITS,
            fee: quote.feeTotalAmount,
            refill: KEY_REFILL
          });
          if (shortfall !== undefined) throw new Error(shortfall);
          // With no approve in the deposit, this allowance must have covered the burn (executorDepositRequests).
          const allowance = await onFirstEndpoint(reads, `${chain.label} allowance of ${evmAddress}`, client =>
            client.readContract({
              address: l2.source.usdc,
              abi: ERC20_ABI,
              functionName: 'allowance',
              args: [evmAddress, l2.source.tokenMessengerWithFees]
            })
          );
          return { funds, fee: quote.feeTotalAmount, allowance };
        });
        evidence.ids.arcKey = evmAddress;
        evidence.ids.arcKeyRole = 'deposit';
        evidence.notes.push(
          `key on ${chain.label}: ${funded.funds.wei} wei, ${funded.funds.usdc} USDC base units, allowance ` +
            `${funded.allowance}, quoted fee ${funded.fee}`
        );

        const sender = await step('l2_sender', BUDGET.l2Sender, () =>
          createL2Sender({
            privateKey: keyHex,
            l2,
            allowedTargets: [l2.source.usdc, l2.source.tokenMessengerWithFees]
          })
        );
        evidence.notes.push(`writes via ${arcHost(sender.endpoint)}`);
        const counterparty = new WcCounterparty({
          privateKey: keyHex,
          rpcUrl: sender.endpoint,
          chainId: chain.chainId,
          sessionChainIds: [chain.chainId],
          send: (tx, signal) => sender.send(tx, signal)
        });
        cp = counterparty;

        await steps.step('connect_evm', async () => {
          await counterparty.connectWithRetry(
            () => walletA.reownConnectUri(),
            async () => (await walletA.reownState()).connected
          );
        });

        await step('deposit_via_ui', BUDGET.depositViaUi, async () => {
          await walletA.openBridgeDeposit();
          await walletA.selectBridgeToken('CIRCLE_USDC');
          await walletA.selectBridgeNetwork(chain.reviewNetwork, chain.networkName);
          await walletA.enterBridgeAmount(formatUnits(DEPOSIT_UNITS, CIRCLE_USDC_DECIMALS));
          await walletA.confirmBridgeRouteUsdcx(60_000);
          await walletA.confirmBridgeDeposit();
        });
        const submittedAt = Date.now();

        const burnHash = await step('deposit_broadcast', BUDGET.depositBroadcast, async (): Promise<Hash> => {
          const fee = l2.source.tokenMessengerWithFees.toLowerCase();
          const request = await pollUntil(
            'the forwarded burn the wallet asked the key to sign',
            async () => {
              const refused = counterparty.requests.find(entry => entry.error !== undefined);
              if (refused) {
                throw new Error(`the key's counterparty answered ${refused.method} with an error: ${refused.error}`);
              }
              const row = await walletA.latestBridgeReceive('usdcx').catch(() => null);
              if (row?.phase === 'failed') {
                throw new Error(`the deposit row failed before the burn: ${row.error ?? row.displayMessage ?? 'no error'}`);
              }
              return counterparty.requests.find(entry => entry.method === 'eth_sendTransaction' && targetOf(entry) === fee);
            },
            found => found !== undefined,
            {
              timeoutMs: BUDGET.depositBroadcast - 15_000,
              intervalMs: 2_000,
              describe: async () =>
                `requests so far ${JSON.stringify(
                  counterparty.requests.map(entry => ({ method: entry.method, chainId: entry.chainId, to: targetOf(entry) }))
                )}`
            }
          );
          const hash = request?.result;
          if (typeof hash !== 'string' || !isHash(hash)) throw new Error(`the burn returned no hash: ${String(hash)}`);
          return hash;
        });
        evidence.hashes.burn = burnHash;

        const recordedFee = await step('row_reaches_delivering', BUDGET.rowDelivering, async () => {
          const row = await walletA.latestBridgeReceive('usdcx');
          if (!row) throw new Error('the deposit screen created no usdcx bridged-receive row');
          bridgeTxId = row.id;
          evidence.ids.depositRow = bridgeTxId;
          const state = await pollUntil(
            'the deposit row leaving submitting',
            rowState,
            read => read !== undefined && read.phase !== 'submitting',
            { timeoutMs: BUDGET.rowDelivering - 15_000, intervalMs: 3_000 }
          );
          // What runUsdcxExecutorDeposit wrote with the burn: the hash, the signed recipient and the forwarded leg.
          expect(
            {
              sourceChainId: state?.sourceChainId,
              evmTxHash: state?.evmTxHash?.toLowerCase(),
              usdcxRemoteRecipient: state?.usdcxRemoteRecipient,
              cctpForwarded: state?.cctpForwarded
            },
            `deposit row ${bridgeTxId}`
          ).toEqual({
            sourceChainId: chain.chainId,
            evmTxHash: burnHash.toLowerCase(),
            usdcxRemoteRecipient: recipient,
            cctpForwarded: true
          });
          const fee = state?.cctpForwardFee;
          if (fee === undefined || !/^\d+$/.test(fee)) throw new Error(`deposit row ${bridgeTxId} records no forward fee`);
          return BigInt(fee);
        });

        const requests = await step('deposit_requests', BUDGET.check, async () =>
          executorDepositRequests(counterparty.requests, {
            l2,
            units: DEPOSIT_UNITS,
            recipient,
            depositor: evmAddress,
            recordedFee,
            allowanceBefore: funded.allowance
          })
        );
        evidence.hashes.approve = requests.approve?.hash ?? 'none';
        evidence.fees.push({ name: 'circle forward fee', amount: recordedFee, kind: 'exact' });

        const burn = await step('source_burn', BUDGET.sourceBurn, () =>
          confirmL2Burn(
            {
              endpoint: sender.endpoint,
              burnHash,
              signed: { hookData: requests.burn.hookData },
              burnQuote: { feeTotalAmount: recordedFee }
            },
            { l2, units: DEPOSIT_UNITS, depositor: evmAddress },
            reads
          )
        );
        evidence.ids.burnBlock = String(burn.blockNumber);

        const iris = await step('iris', BUDGET.iris, () =>
          waitForIrisForward(
            { l2, burnHash, sentMessage: burn.sentMessage },
            { timeoutMs: BUDGET.iris - 15_000 }
          )
        );
        evidence.hashes.forward = iris.forwardTxHash;
        evidence.ids.cctpNonce = iris.nonce;
        evidence.latenciesMs.submitToForwardSeen = iris.seenAtMs - submittedAt;

        const executed = await step('arc_forward', BUDGET.arcForward, () =>
          confirmArcForward(
            iris.forwardTxHash,
            { l2, nonce: iris.nonce, units: DEPOSIT_UNITS, remoteRecipient: recipient, remoteToken: xreserve.remoteToken },
            arc
          )
        );
        evidence.ids.forwardBlock = String(executed.blockNumber);

        await step('row_forward', BUDGET.rowForward, () =>
          pollUntil(
            "the wallet's row taking Circle's Arc forward as its execute",
            rowState,
            state => state?.usdcxExecuteTxHash?.toLowerCase() === iris.forwardTxHash.toLowerCase(),
            {
              timeoutMs: BUDGET.rowForward - 5_000,
              intervalMs: 3_000,
              describe: async last =>
                `row phase ${last?.phase ?? 'unread'}, execute ${last?.usdcxExecuteTxHash ?? 'none'}, ` +
                `error ${last?.error ?? 'none'}`
            }
          )
        );

        const attested = await step('attest', BUDGET.attest, async () => {
          const attestation = await waitForXReserveAttestation(iris.forwardTxHash, {
            baseUrl: ARC_ATTESTATION_API,
            timeoutMs: BUDGET.attest - 15_000,
            pollMs: 3_000
          });
          const attestedAt = Date.now();
          // An executor deposit's depositor is the DepositFor handler, never the key (attestation-protocol.ts).
          const { intent, signer } = await assertDepositIntent(attestation, {
            amount: DEPOSIT_UNITS,
            remoteToken: xreserve.remoteToken,
            remoteRecipient: recipient,
            localToken: ARC_USDC,
            localDepositor: l2.source.target.handler
          });
          const verdict = matchUsdcxDepositAttestation([attestation], {
            remoteRecipient: recipient,
            remoteToken: xreserve.remoteToken,
            amount: DEPOSIT_UNITS,
            remoteDomain: USDCX_REMOTE_DOMAIN
          });
          expect(verdict.kind, "the wallet's own matcher accepts Circle's attestation").toBe('attested');
          evidence.ids.attestationSigner = signer;
          evidence.hashes.attestationMessage = attestation.messageHash;
          return { intent, attestedAt };
        });

        const mintNoteId = await step('mint', BUDGET.mint, async () => {
          // Derived, not discovered: a mint to any other account or of any other amount cannot satisfy this read.
          const derived = await deriveUsdcxMintNoteId({
            faucetHex: ids.nativeHex,
            recipientHex: ids.accountHex,
            units: DEPOSIT_UNITS,
            nonce: attested.intent.nonce
          });
          const read = await waitForUsdcxMint(envConfig.rpcUrl, {
            mintNoteId: derived,
            depositHash: iris.forwardTxHash,
            nonce: attested.intent.nonce,
            faucetBech32: ids.nativeBare,
            accountBech32: ids.bare,
            // The account was created in this run, so every faucet note to it is recent.
            sinceBlock: 0,
            timeoutMs: BUDGET.mint - 15_000
          });
          expect(
            {
              committed: read.committed,
              sender: read.senderHex?.toLowerCase(),
              assets: read.assets.map(asset => ({ faucetHex: asset.faucetHex.toLowerCase(), amount: asset.amount }))
            },
            `mint note ${derived}`
          ).toEqual({
            committed: true,
            sender: ids.nativeHex.toLowerCase(),
            assets: [{ faucetHex: ids.nativeHex.toLowerCase(), amount: DEPOSIT_UNITS }]
          });
          return derived;
        });
        evidence.ids.mintNote = mintNoteId;
        evidence.latenciesMs.attestationToMint = Date.now() - attested.attestedAt;

        const depositVault = await step('receive', BUDGET.receive, async () => {
          // The wallet claims the mint by itself (USDCx is testnet's native asset) and moves the row to received only
          // once the consume it matched to the deposit has completed.
          await pollUntil('the wallet claiming the mint and the row reading received', rowState, state => state?.phase === 'received', {
            timeoutMs: BUDGET.receive - VAULT_MS - 60_000,
            intervalMs: 5_000
          });
          depositPhases.assertMonotone();
          evidence.phases.deposit = depositPhases.samples();
          const state = parseBridgeReceiveState(await walletA.getBridgeReceiveState(bridgeTxId));
          const claim = exactlyOne(
            (await walletA.readTransactionRows({ type: 'consume' })).filter(row => row.status === TxStatus.Completed),
            'Completed consume on the fresh wallet, the claim of the minted note',
            describeTransactionRow
          );
          expect(
            {
              rowNote: state.midenNoteId?.toLowerCase(),
              rowAmount: state.amount,
              claimNotes: (claim.noteIds ?? []).map(id => id.toLowerCase()),
              displayMessage: claim.displayMessage,
              adoptedBy: jsonString(jsonObject(claim.extraInputs?.bridgeIn)?.bridgeReceiveTxId)
            },
            `deposit row ${bridgeTxId} and claim ${claim.id}`
          ).toEqual({
            rowNote: mintNoteId.toLowerCase(),
            rowAmount: DEPOSIT_UNITS.toString(),
            claimNotes: [mintNoteId.toLowerCase()],
            displayMessage: 'Bridged from EVM',
            adoptedBy: bridgeTxId
          });
          // A new wallet starts at zero, so the vault is the mint less the fee the claim's row recorded.
          const settled = await settleLedger(walletA, native, {
            name: 'f2',
            before: 0n,
            credit: DEPOSIT_UNITS,
            debits: 0n,
            row: claim
          });
          evidence.ids.mintConsume = claim.id;
          evidence.fees.push(settled.fee);
          return settled.vault;
        });
        evidence.notes.push(`vault after the claim ${depositVault}`);

        // The identity is read here, after the deposit leg, so a Guardian endpoint glitch cannot stop that leg running.
        const identity = await assertHostedGuardianAccount(step, walletA, {
          address: addressA,
          guardianUrl: envConfig.guardianUrl,
          evidence
        });

        // The burn pays the key back on the source chain, so each green run refills the USDC its deposit spent there.
        const depositKey: PayoutKey = {
          key: { address: evmAddress, privateKey: keyHex },
          role: 'deposit',
          label: `deposit key ${evmAddress} (USDCX_LIVE_EVM_PRIVATE_KEY) on ${chain.label}, which Circle pays,`
        };
        await burnBackToDepositKey({
          step,
          wallet: walletA,
          address: addressA,
          native,
          envConfig,
          identity,
          vaultBefore: depositVault,
          arc,
          payoutReads: reads,
          depositKey,
          evidence,
          secrets,
          screenshotDir: path.join(steps.outputDir, 'usdcx-burn')
        });
      } finally {
        await cp?.stop();
        // In the run's artifact directory, which the job uploads (test-results-ios/).
        const evidencePath = path.join(steps.outputDir, `usdcx-live-executor-${chain.reviewNetwork}-ios-evidence.json`);
        fs.mkdirSync(steps.outputDir, { recursive: true });
        fs.writeFileSync(evidencePath, evidenceBody(evidence, secrets));
        await test.info().attach(`usdcx-live-executor-${chain.reviewNetwork}-ios-evidence.json`, {
          path: evidencePath,
          contentType: 'application/json'
        });
      }
    });
  });
}
```

Notes for the implementer (facts, not code):
- `claim.noteIds` is used directly (not `noteIdsOf`): the extension suite holds the consume to exactly the mint note (`playwright/e2e/helpers/usdcx-receive.ts:110-113`).
- The receive gates mirror `receiveLeg` (`usdcx-receive.ts:96-170`): the consume's `bridgeIn.bridgeReceiveTxId` is the row, its `displayMessage` reads `Bridged from EVM`, the row's `midenNoteId` is the derived mint.
- No `if/else` holds an `expect`, no wait sleeps over 2 s and no balance check uses a zero threshold, so the harness ratchet (`yarn lint:e2e`, CI) has nothing new to count.
- `SOURCES` holds only the selected chain when `USDCX_LIVE_SOURCE` is set, so a job defines one describe, one `beforeAll` and one test: no other chain's key is read and nothing is reported skipped. With the variable unset (a local run) the three tests run one after another, up to 140 minutes each.
- `chain.networkName` is the wallet's own chain name (`Base Sepolia`, `Arbitrum Sepolia`, `Sepolia`, viem's names through `getChain`), which the network row shows and `selectBridgeNetwork` waits for; `chain.label` (`Ethereum Sepolia` for 11155111) is only for messages.
- Ethereum Sepolia's burn half burns 2 USDCx (`ETHEREUM_SEPOLIA_PAYOUT.burnUnits`), which `burnBackToDepositKey` reads from the payout chain; the 10 USDCx grant covers it and its fees.

- [ ] **Step 3: Run the pins**

Run: `yarn jest playwright/e2e/harness/usdcx-live-spec.test.ts --maxWorkers=1`
Expected: PASS.

- [ ] **Step 4: Mutation checks**

One at a time, rerun `yarn jest playwright/e2e/harness/usdcx-live-spec.test.ts --maxWorkers=1` and restore after each:
1. Change `sessionChainIds: [chain.chainId],` to `sessionChainIds: [chain.chainId, 5042002],`: the session pin fails.
2. Delete `payoutKeyProblem(chain, address, funds.usdc) ??` from the `beforeAll` (keep its `l2KeyShortfall(...)`): the preflight pin fails.
3. Change `for (const l2 of SOURCES) {` to `for (const l2 of L2_BRIDGE_IN_SOURCES) {`: the selection pin fails.

- [ ] **Step 5: Format, lint, dash check, commit, push**

```bash
F="playwright/e2e/ios/tests/usdcx-live-executor-deposit.ios.spec.ts playwright/e2e/harness/usdcx-live-spec.test.ts"
yarn prettier --check ${=F}
yarn eslint --max-warnings 0 ${=F}
perl -CSD -ne 'print "$ARGV:$.: $_" if /[\x{2013}\x{2014}]/' ${=F}
git add ${=F}
git commit -m "ios live usdcx deposits from each executor source chain through the deposit screen"
git push
```

The spec runs only on simulators, in Task 10's jobs, dispatched in the Delivery section.

---

### Task 10: E2E USDCx Bridge-IN (live): an executor job per source chain after the Arc job

**Why:** both specs match the config's glob (`playwright.ios.usdcx-live.config.ts:16`), so each job filters its own; the executor jobs run after the Arc job (decision table), one matrix entry per source chain, `fail-fast: false`, the same ceiling per entry, and a dispatch can run the Arc job or one chain alone (`legs` input), so a branch dispatch spends only what it tests (the user's decision 3 of 2026-10-17). The matrix and the `legs` options must name exactly the spec's sources, so the pins read them against `L2_BRIDGE_IN_SOURCES`. The pins read the workflow as text (`playwright/e2e/harness/usdcx-live-workflow.test.ts:11-46`) and every guarded job's ceiling (`playwright/e2e/harness/linked-pr-injection.test.ts:329-366`; a macOS job's dispatch ceiling must be at least its push ceiling plus 75 for a linked web-sdk build and 10 for the CLI, `:136-141, :157-166`). That test's job parser reads only a job's indent-4 keys before `steps:` and skips deeper lines (`:51-104`), so a `strategy:` block parses, and it reads a job `if:` only in a workflow that a pull request runs (`:207-210`), which this one is not. The matrix's value comes from an expression over `inputs`, which GitHub allows in `jobs.<id>.strategy`; on a push or the nightly `inputs.legs` is empty, so every chain runs.

**Files:**
- Modify: `.github/workflows/e2e-usdcx-live.yml:3-27` (header), `:29-30` (required configuration), `:49-54` (inputs), `:69` (Arc job `if`, after its `name:`), `:284` (Arc filter), append the executor job
- Modify (whole file below): `playwright/e2e/harness/usdcx-live-workflow.test.ts`
- Modify: `playwright/e2e/harness/linked-pr-injection.test.ts:360`
- Modify: `playwright.ios.usdcx-live.config.ts:5-12` (comment)
- Modify: `playwright/e2e/docs/e2e-architecture.md:382` (table row), `:423` (iOS key section)
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: Task 9's spec file name and `USDCX_LIVE_SOURCE`; `L2_BRIDGE_IN_SOURCES` (`usdcx-constants.ts:249-253`).
- Produces: job `mobile-usdcx-live-executor` (`needs: mobile-usdcx-live`, `if: ${{ !cancelled() && inputs.legs != 'arc' }}`, `strategy.matrix.source` over `base-sepolia`, `arbitrum-sepolia`, `sepolia`, push 170 / dispatch 255 per entry); the Arc job's `if: ${{ !inputs.legs || inputs.legs == 'all' || inputs.legs == 'arc' }}`; dispatch input `legs` (`all` default, `arc`, `base-sepolia`, `arbitrum-sepolia`, `sepolia`). The Delivery section dispatches with these values.

- [ ] **Step 1: Write the pins (they fail first)**

Replace the whole of `playwright/e2e/harness/usdcx-live-workflow.test.ts` with:

```ts
/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { L2_BRIDGE_IN_SOURCES } from '../helpers/usdcx-constants';

const workflow = readFileSync(resolve(__dirname, '../../../.github/workflows/e2e-usdcx-live.yml'), 'utf8');
const ARC_JOB = 'mobile-usdcx-live';
const EXECUTOR_JOB = 'mobile-usdcx-live-executor';
/** The executor spec's sources, by the slug USDCX_LIVE_SOURCE and the `legs` input name them. */
const SOURCES = L2_BRIDGE_IN_SOURCES.map(l2 => l2.payout.reviewNetwork);

/** A job's lines, from its `  <id>:` line to the next line at that indent (a job or a comment above one). */
function jobBlock(id: string): string {
  const lines = workflow.split('\n');
  const at = lines.indexOf(`  ${id}:`);
  if (at === -1) throw new Error(`no job ${id}`);
  const next = lines.findIndex((line, index) => index > at && /^ {2}\S/.test(line));
  return lines.slice(at, next === -1 ? lines.length : next).join('\n');
}
const stepsOf = (id: string): string => jobBlock(id).split('\n    steps:\n')[1] ?? '';

describe('E2E USDCx Bridge-IN (live) workflow', () => {
  // The specs skip themselves without the key, and a skipped spec passes the job, so a run that tested nothing read green.
  it.each([
    [ARC_JOB, 'Require the live Arc Testnet key'],
    [EXECUTOR_JOB, 'Require the live deposit key']
  ])('fails %s before anything else when the live key is not set', (job, name) => {
    const steps = stepsOf(job);
    const guard = steps.indexOf(`- name: ${name}`);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(steps.indexOf('- uses: actions/checkout@v4'));
    const body = steps.slice(guard, steps.indexOf('\n      - ', guard + 1));
    expect(body).toMatch(/if \[ -z "\$USDCX_LIVE_EVM_PRIVATE_KEY" \]; then[\s\S]*::error[\s\S]*exit 1/);
  });

  // Every push to main runs it as well as the nightly and a dispatch, and runs queue: a cancelled run can leave a
  // deposit that no relayer mints.
  it('runs after every push to main, nightly and by dispatch, one run at a time', () => {
    expect(workflow).toMatch(
      /\non:\n {2}push:\n {4}branches:\n {6}- main\n {2}schedule:\n {4}- cron: '17 3 \* \* \*'\n {2}workflow_dispatch:\n/
    );
    expect(workflow).toMatch(
      /\nconcurrency:\n {2}group: \$\{\{ github\.workflow \}\}\n(?: {2}#.*\n)* {2}cancel-in-progress: false\n/
    );
  });

  // Every step sees a job variable, the dependency install and the app build among them.
  it('sets the live key only on the key checks and the test steps', () => {
    const code = workflow
      .split('\n')
      .filter(line => !line.trimStart().startsWith('#'))
      .join('\n');
    const reading = code.split(/\n(?= {6}- )/).filter(chunk => chunk.includes('secrets.USDCX_LIVE_EVM_PRIVATE_KEY'));
    expect(reading.map(chunk => /^ {6}- name: (.+)$/m.exec(chunk)?.[1])).toEqual([
      'Require the live Arc Testnet key',
      'Run USDCx bridge-IN E2E (mobile, live testnets)',
      'Require the live deposit key',
      'Run USDCx bridge-IN E2E from a source chain (mobile, live testnets)'
    ]);
    for (const chunk of reading)
      expect(chunk).toContain(
        `\n        env:\n          USDCX_LIVE_EVM_PRIVATE_KEY: \${{ secrets.USDCX_LIVE_EVM_PRIVATE_KEY }}\n`
      );
  });

  // A forwarded burn names the key as the executor's recovery address on Arc, so no source chain's deposit runs inside
  // the Arc leg's payout window; a dispatch can still run the Arc leg or one source chain alone.
  it('runs the executor legs after the Arc leg, red or green, never in a cancelled run', () => {
    expect(jobBlock(EXECUTOR_JOB)).toMatch(/^ {4}needs: mobile-usdcx-live$/m);
    expect(jobBlock(EXECUTOR_JOB)).toMatch(/^ {4}if: \$\{\{ !cancelled\(\) && inputs\.legs != 'arc' \}\}$/m);
    expect(jobBlock(ARC_JOB)).toMatch(
      /^ {4}if: \$\{\{ !inputs\.legs \|\| inputs\.legs == 'all' \|\| inputs\.legs == 'arc' \}\}$/m
    );
  });

  // One job per source chain the spec knows, none cancelled by another's failure mid-deposit; a dispatch that names one
  // chain spends only that chain's funds.
  it('runs one job per executor source, and one alone on a dispatch that names it', () => {
    const one = SOURCES.map(slug => `inputs.legs == '${slug}' && '${JSON.stringify([slug])}'`).join(' || ');
    expect(jobBlock(EXECUTOR_JOB)).toMatch(/^ {6}fail-fast: false$/m);
    expect(jobBlock(EXECUTOR_JOB)).toContain(
      `\n        source: \${{ fromJSON(${one} || '${JSON.stringify(SOURCES)}') }}\n`
    );
    expect(workflow).toContain(
      ['        options:', '          - all', '          - arc', ...SOURCES.map(slug => `          - ${slug}`)].join('\n')
    );
    expect(stepsOf(EXECUTOR_JOB)).toContain('\n          USDCX_LIVE_SOURCE: ${{ matrix.source }}\n');
  });

  // Both specs match the config's usdcx-live-* glob, and a retry sends a second real deposit.
  it("runs each spec in its own jobs, with no retries, and keeps each source chain's artifact", () => {
    expect(stepsOf(ARC_JOB)).toMatch(/\n {8}run: yarn test:e2e:mobile:usdcx-live:run usdcx-live-deposit\.ios\n/);
    expect(stepsOf(EXECUTOR_JOB)).toMatch(
      /\n {8}run: yarn test:e2e:mobile:usdcx-live:run usdcx-live-executor-deposit\.ios\n/
    );
    expect(stepsOf(EXECUTOR_JOB)).toContain(
      '\n          name: usdcx-live-executor-e2e-${{ matrix.source }}-${{ github.run_id }}\n'
    );
    expect(workflow).not.toMatch(/--retries/);
  });
});
```

In `playwright/e2e/harness/linked-pr-injection.test.ts`, after the line `'e2e-usdcx-live.yml mobile-usdcx-live: push 150, dispatch 235',` (`:360`), add:

```ts
      'e2e-usdcx-live.yml mobile-usdcx-live-executor: push 170, dispatch 255',
```

Run: `yarn jest playwright/e2e/harness/usdcx-live-workflow.test.ts playwright/e2e/harness/linked-pr-injection.test.ts --maxWorkers=1`
Expected: FAIL (`no job mobile-usdcx-live-executor`; the Arc job has no `if:`; the ceilings list misses the new line).

- [ ] **Step 2: Edit the workflow**

In `.github/workflows/e2e-usdcx-live.yml`:

1. Replace the header `:3-27` (from `# Runs the live USDCx E2E on iOS` through `# main, nightly and on demand, and is never a per-PR gate.`) with:

```yaml
# Runs the live USDCx E2E on iOS against the LIVE networks (Arc Testnet, Base
# Sepolia, Arbitrum Sepolia, Ethereum Sepolia and Miden testnet). Nothing on the
# path is a double.
#   Arc job (usdcx-live-deposit.ios.spec.ts):
#   1. Bridge-IN: the deposit goes to Circle's real xReserve contract, Circle's
#      attestation service signs it, the deposit relayer submits the mint note to
#      the USDCx faucet, and the Guardian wallet claims the minted note.
#   2. Burn, only once the deposit leg passed: the same wallet takes USDCx from the
#      public faucet and burns 1 USDCx through Send back to the deposit key's Arc
#      address. The run fails unless Circle pays that key within 10 minutes of the
#      faucet consuming the burn and the wallet's own History then reads Confirmed.
#      The payout, about 0.98 USDC, refills what the deposit and its gas spent, so
#      the key funds itself on Arc.
#   Executor jobs (usdcx-live-executor-deposit.ios.spec.ts), after the Arc job, one
#   per source chain the wallet routes through Circle's executor (Base Sepolia,
#   Arbitrum Sepolia, Ethereum Sepolia), in parallel:
#   1. Bridge-IN: the same key deposits 0.001 USDC plus Circle's forward fee
#      through the deposit screen and a Reown pairing; Circle attests the burn and
#      forwards it to Arc, its executor deposits into xReserve, the relayer mints
#      and the wallet claims.
#   2. Burn USDCx back to the key's address on that chain (2 USDCx to Ethereum
#      Sepolia, 1 elsewhere), with the same payout and wallet gates, which refills
#      the key's USDC there.
#
# By default the DEPLOYED relayer mints: the faucet does not look at who sent a mint
# note, so the jobs need no relayer of their own and only the EVM key. To test a
# relayer build before it is deployed, set vars.USDCX_RELAYER_ACCOUNT_ID (with the
# other relayer values below); the Arc job then installs that relayer and the spec
# starts it as a local process.
#
# E2E Bridge-IN (e2e-bridge-in.yml) covers the AggLayer and Epoch deposit UI
# hermetically on every push to main. These jobs cover what that suite cannot:
# Circle's real contracts, its attestation and forward, and the mint.
#
# It spends real Arc Testnet USDC, USDC and ETH on the three source chains, and
# public faucet USDCx on each run, and it depends on Circle's service, the relayer
# and the faucet, so it runs after every push to main, nightly and on demand, and
# is never a per-PR gate.
```

2. Replace `:30` (`#   secrets.USDCX_LIVE_EVM_PRIVATE_KEY        funded Arc Testnet key (USDC is the gas token too)`) with:

```yaml
#   secrets.USDCX_LIVE_EVM_PRIVATE_KEY        the deposit key: USDC on Arc Testnet (its gas token too), and
#                                             ETH and USDC on Base Sepolia, Arbitrum Sepolia and Ethereum Sepolia
```

3. Replace the `workflow_dispatch` inputs (`:49-54`) with:

```yaml
  workflow_dispatch:
    inputs:
      deposit_amount:
        description: Arc deposit amount in USDC
        required: false
        default: '0.01'
      legs:
        description: Which legs run (all, arc, or one executor source chain)
        required: false
        type: choice
        options:
          - all
          - arc
          - base-sepolia
          - arbitrum-sepolia
          - sepolia
        default: all
```

4. In the Arc job, after `    name: USDCx bridge-IN E2E (iOS, live testnets)` (`:69`), add:

```yaml
    # Every run but a dispatch that names one executor source chain; a push and the nightly have no inputs.
    if: ${{ !inputs.legs || inputs.legs == 'all' || inputs.legs == 'arc' }}
```

5. In the Arc job's run step (`:284`), replace `run: yarn test:e2e:mobile:usdcx-live:run` with:

```yaml
        run: yarn test:e2e:mobile:usdcx-live:run usdcx-live-deposit.ios
```

6. Append at the end of the file (after the Arc job's `Upload artifacts` step; keep one blank line between the jobs):

```yaml

  # After the Arc job, red or green, never in a cancelled run: every job spends from one key, and a forwarded burn
  # names that key as the executor's recovery address on Arc, so no source chain's deposit may run inside the Arc job's
  # payout window. One job per source chain, in parallel: each reads and refills only its own chain's balance of the
  # key, whose nonce there is its own. Like the Arc job, a retry would send a second real deposit, so there is none.
  mobile-usdcx-live-executor:
    name: USDCx bridge-IN E2E from ${{ matrix.source }} (iOS, live testnets)
    needs: mobile-usdcx-live
    if: ${{ !cancelled() && inputs.legs != 'arc' }}
    strategy:
      # A failed chain must not cancel another mid-deposit: a cancelled run can leave a deposit no relayer mints.
      fail-fast: false
      matrix:
        # The executor spec's sources (L2_BRIDGE_IN_SOURCES), by the slug USDCX_LIVE_SOURCE takes; a dispatch that
        # names one runs it alone.
        source: ${{ fromJSON(inputs.legs == 'base-sepolia' && '["base-sepolia"]' || inputs.legs == 'arbitrum-sepolia' && '["arbitrum-sepolia"]' || inputs.legs == 'sepolia' && '["sepolia"]' || '["base-sepolia","arbitrum-sepolia","sepolia"]') }}
    runs-on: macos-26-xlarge
    # Per source chain: the iOS build and setup (~21 min) + the test (140 min worst case, the spec's own timeout).
    # A dispatch may first build a linked web-sdk PR from source (73 min on macos-26, pr-compile-surfaces.yml).
    # A `Client PR:` or `Protocol PR:` marker on that PR also rebuilds the CLI cold (up to 10 min on this runner).
    timeout-minutes: ${{ github.event_name == 'workflow_dispatch' && 255 || 170 }}
    env:
      E2E_NETWORK: testnet
      # NO E2E_EVM_RPC_URL: the wallet reads the source chain and Arc through their real RPCs.
      # NO USDCX_LIVE_EVM_PRIVATE_KEY either: it is set only on the two steps that read it.
      # Optional: a relay projectId of the counterparty's own. See e2e-bridge-in.yml.
      WC_COUNTERPARTY_PROJECT_ID: ${{ secrets.WC_COUNTERPARTY_PROJECT_ID }}
    steps:
      # The spec skips itself without this key, and a skipped spec passes the job. Fail first instead.
      - name: Require the live deposit key
        env:
          USDCX_LIVE_EVM_PRIVATE_KEY: ${{ secrets.USDCX_LIVE_EVM_PRIVATE_KEY }}
        run: |
          if [ -z "$USDCX_LIVE_EVM_PRIVATE_KEY" ]; then
            echo "::error title=USDCX_LIVE_EVM_PRIVATE_KEY is not set::Add the funded deposit key as the repository secret USDCX_LIVE_EVM_PRIVATE_KEY. Without it the spec skips and the run tests nothing."
            exit 1
          fi

      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - uses: dtolnay/rust-toolchain@stable

      - name: Cache miden-client-cli
        uses: actions/cache@v4
        with:
          path: ~/.cargo/bin/miden-client
          key: miden-client-cli-${{ runner.os }}-${{ hashFiles('package.json') }}

      # On a dispatch from a pull request's branch these build against that pull request's linked
      # web-sdk and Guardian PRs, as its own CI does; on any other run both are no-ops.
      - name: Inject linked web-sdk PR
        id: inject-web-sdk
        uses: ./.github/actions/inject-linked-web-sdk-pr
      - name: Inject linked guardian PR
        id: inject-guardian
        uses: ./.github/actions/inject-linked-guardian-pr

      - name: Install dependencies
        if: steps.inject-web-sdk.outputs.patched != 'true' && steps.inject-guardian.outputs.patched != 'true'
        run: yarn install --frozen-lockfile
      # Not frozen: an injection rewrites package.json to `file:` deps the committed lockfile cannot match.
      - name: Install dependencies (linked PRs injected)
        if: steps.inject-web-sdk.outputs.patched == 'true' || steps.inject-guardian.outputs.patched == 'true'
        uses: ./.github/actions/yarn-install

      # The two-simulator fixture sets up the CLI for every spec, this one included.
      - name: Install miden-client-cli
        uses: ./.github/actions/install-miden-client-cli

      # CDP bridge (appium-remote-debugger) requires Simulator.app GUI running.
      - name: Launch Simulator.app
        run: open -a Simulator || true

      # idb lets the harness tap "Allow" on the native notification-permission alert. Best-effort.
      - name: Set up Python for idb
        continue-on-error: true
        uses: actions/setup-python@v5
        with:
          python-version: '3.11'
      - name: Install idb (dismiss native notification alert)
        continue-on-error: true
        run: |
          brew trust facebook/fb || true
          brew install facebook/fb/idb-companion
          python3 -m pip install fb-idb
```

then append the Arc job's three steps `Pin test pair to preinstalled simulators`, `Pre-boot simulators (async, overlaps build)` and `Build iOS app` byte for byte, from the commit this plan read (the edits above moved their line numbers): `git show fd614122d:.github/workflows/e2e-usdcx-live.yml | sed -n 206,277p >> .github/workflows/e2e-usdcx-live.yml`, then check that the appended block starts with a blank line and `      # Fresh-create + boot of custom sims hangs on macos-26 runners.` and ends with the `Build iOS app` step's closing `          }`. Add a blank line and end the job with:

```yaml
      - name: Run USDCx bridge-IN E2E from a source chain (mobile, live testnets)
        # NO retries: a retry sends a second real deposit, and past the deposit leg it also burns again.
        env:
          USDCX_LIVE_EVM_PRIVATE_KEY: ${{ secrets.USDCX_LIVE_EVM_PRIVATE_KEY }}
          # The spec defines this source chain's test alone; a slug that names none fails the file.
          USDCX_LIVE_SOURCE: ${{ matrix.source }}
        run: yarn test:e2e:mobile:usdcx-live:run usdcx-live-executor-deposit.ios

      - name: Upload artifacts
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: usdcx-live-executor-e2e-${{ matrix.source }}-${{ github.run_id }}
          path: test-results-ios/
          retention-days: 7
          if-no-files-found: ignore
```

Run: `actionlint -oneline .github/workflows/e2e-usdcx-live.yml`
Expected: no output (0 findings at `fd614122d`; the matrix expression and the `inputs` reads in `strategy` and `if:` are allowed there).

- [ ] **Step 3: Config comment, docs, CHANGELOG**

In `playwright.ios.usdcx-live.config.ts`, replace the comment `:5-12` with:

```ts
// Same harness as the iOS E2E config, but runs ONLY the live USDCx specs (which the base iOS config ignores): the Arc
// spec deposits real Arc Testnet USDC through Circle xReserve, and the executor spec deposits from Base Sepolia,
// Arbitrum Sepolia or Ethereum Sepolia through Circle's CCTP forward to Arc, each from the funded key
// USDCX_LIVE_EVM_PRIVATE_KEY and each then burning public faucet USDCx through Send back to that key and waiting for
// Circle's payout. E2E USDCx Bridge-IN (live) runs each in jobs of its own with a file filter:
// yarn test:e2e:mobile:usdcx-live:run usdcx-live-deposit.ios, or usdcx-live-executor-deposit.ios with
// USDCX_LIVE_SOURCE naming the chain.
//
// The app must be built WITHOUT E2E_EVM_RPC_URL: that flag sends the EVM reads to a local Anvil, and these specs need
// the real RPCs.
```

(The `timeout` comment and value below it stay: the executor spec sets its own timeout.)

In `playwright/e2e/docs/e2e-architecture.md`, after the table row that starts `| The iOS live round trip (` (`:382`), add:

```markdown
| The iOS live executor-route deposits (`usdcx-live-executor-deposit.ios.spec.ts`), one test per source chain (Base Sepolia, Arbitrum Sepolia, Ethereum Sepolia): a deposit through the deposit screen and a Reown pairing, then the burn half back to the key on that chain | E2E USDCx Bridge-IN (live)'s executor jobs, one per chain in parallel, after the Arc job whatever it did, never in a cancelled run; a dispatch with `legs` set to a chain's slug runs that chain alone | The same secret, at its address on each source chain ([below](#the-ios-jobs-key)) |
```

and after the paragraph that starts `` `e2e-usdcx-live.yml` runs `playwright/e2e/ios/tests/usdcx-live-deposit.ios.spec.ts` `` (`:423`), add:

```markdown
The workflow's executor jobs run `usdcx-live-executor-deposit.ios.spec.ts` after the Arc job, red or green, one job per source chain, each naming its chain in `USDCX_LIVE_SOURCE`: the same key deposits 0.001 USDC plus Circle's forward fee from that chain through the deposit screen, and the wallet then burns USDCx from a public faucet grant back to the key's address there (1 USDCx, and 2 USDCx to Ethereum Sepolia, whose 1.5 USDC payout fee allowance takes 1 whole). A green run leaves the key about 0.97 USDC richer on Base Sepolia and on Arbitrum Sepolia and about 0.98 on Ethereum Sepolia, and spends a little ETH for gas on each, which is sent to the key by hand. Before the simulators start, the spec fails naming the address and the minimum when the key holds less than one bridge-in's gas (1.1M gas at the live fee) or 0.101 USDC on the chain, and on Ethereum Sepolia when it holds no USDC at all, since Circle's forwarder mints a payout there under a fixed 250,000 gas limit that a mint to an address with no USDC exceeds. Each Reown counterparty approves its source chain alone, so the key is never asked to sign on Arc or on another chain; it signs with a nonce counted locally, sends the burn only after reading the chain at or past its approve's block, and on Ethereum Sepolia tips at most 0.01 gwei.
```

Append to the end of `### Fixes` under `## 1.17.5 (TBD)` in `CHANGELOG.md`:

```markdown
- [FIX][ci] E2E USDCx Bridge-IN (live) runs an iOS job for each executor-route source chain after the Arc one: the iOS key deposits 0.001 USDC plus Circle's forward fee from Base Sepolia, Arbitrum Sepolia and Ethereum Sepolia through the real deposit screen and a Reown pairing, and each job passes only once what the wallet asked the key to sign, the burn, Circle's attestation and forward, the Arc execution, the mint and the wallet's claim are each proven, and then a USDCx burn back to the key on that chain is paid there and the wallet reads Confirmed. A dispatch can run the Arc job or one chain alone.
```

- [ ] **Step 4: Run the pins and their directory**

Run: `yarn jest playwright/e2e/harness --maxWorkers=1`
Expected: PASS, `usdcx-live-workflow.test.ts`, `linked-pr-injection.test.ts` (which also proves the new job injects the linked PRs before its install, `:258-260`) and `usdcx-live-spec.test.ts` included.

- [ ] **Step 5: Mutation check**

In the workflow, temporarily change `      fail-fast: false` to `      fail-fast: true` and rerun `yarn jest playwright/e2e/harness/usdcx-live-workflow.test.ts --maxWorkers=1`: the matrix case fails. Then temporarily drop `inputs.legs == 'sepolia' && '["sepolia"]' || ` from the matrix line: the same case fails. Restore and rerun: PASS.

- [ ] **Step 6: Dash check, commit, push**

```bash
F=".github/workflows/e2e-usdcx-live.yml playwright/e2e/harness/usdcx-live-workflow.test.ts playwright/e2e/harness/linked-pr-injection.test.ts playwright.ios.usdcx-live.config.ts"
actionlint -oneline .github/workflows/e2e-usdcx-live.yml   # prints nothing
yarn prettier --check playwright/e2e/harness/usdcx-live-workflow.test.ts playwright/e2e/harness/linked-pr-injection.test.ts playwright.ios.usdcx-live.config.ts
git diff -U0 HEAD -- ${=F} CHANGELOG.md playwright/e2e/docs/e2e-architecture.md | perl -CSD -ne 'print if /^\+.*[\x{2013}\x{2014}]/'
git add ${=F} CHANGELOG.md playwright/e2e/docs/e2e-architecture.md
git commit -m "e2e usdcx live: an executor-route job per source chain after the arc job"
git push
```

Expected: no actionlint output, prettier clean, no dash output.

---

### Task 11: Retire the Sepolia-fork USDCx spec

**Why:** `bridge-in-deposit-usdcx.ios.spec.ts` registers Miden on Sepolia's xReserve through impersonated admins on an Anvil fork (`playwright/e2e/ios/helpers/xreserve-fork.ts:141-214`), a route production does not have: the live document routes Sepolia through the executor, and `isRemoteDomainRegistered(10007)` on Sepolia's xReserve answered `false` on 2026-10-17 (suite scout section 5). The user's rule of 2026-10-17 retires it: no spec deposits through a route production does not use. Its flakes were the shared-Core counterparty (Task 2), and the live Arc job covers the iOS xReserve deposit UI against the real contract, as Task 9 now covers the executor route from each source chain, Ethereum Sepolia included. Its only importer of `xreserve-fork.ts` is itself (suite scout section 7).

**Files:**
- Delete: `playwright/e2e/ios/tests/bridge-in-deposit-usdcx.ios.spec.ts`, `playwright/e2e/ios/helpers/xreserve-fork.ts`
- Modify: `.github/workflows/e2e-bridge-in.yml:3-12` (header), `:60-67` (fork env)
- Modify: `CHANGELOG.md`

**Interfaces:** none. The product flag `MIDEN_E2E_USDCX_CHAIN` (`src/lib/usdcx/constant.ts:18`, five vite defines, the runner's refusal at `scripts/e2e-real.mjs:378`), the served document's Sepolia USDCx block (`playwright/e2e/helpers/fake-bridge-config.ts:96-126`) and `anvil.ts`'s `forkUrl` option stay; nothing else reads the deleted files (`git grep` at `fd614122d`).

- [ ] **Step 1: Confirm nothing else imports the deleted files**

Run: `git grep -n -e 'xreserve-fork' -e 'bridge-in-deposit-usdcx' -- . ':!docs/superpowers'`
Expected: hits only inside the two files being deleted (Task 10 already rewrote the `e2e-usdcx-live.yml` header that named the spec). Any other hit stops the task: read it and fold its fix into this task.

- [ ] **Step 2: Delete and edit**

```bash
git rm playwright/e2e/ios/tests/bridge-in-deposit-usdcx.ios.spec.ts playwright/e2e/ios/helpers/xreserve-fork.ts
```

In `.github/workflows/e2e-bridge-in.yml`, delete `:60-67` (from `      # The USDCx spec forks Sepolia on that Anvil and deposits into Circle's real` through `      E2E_SEPOLIA_FORK_URL: ${{ secrets.E2E_SEPOLIA_FORK_URL }}`), and replace the header `:3-12` (from `# Runs the cross-chain bridge-IN deposit E2E (EVM -> Miden) on every push to` through `# and reconciles it to "Bridged from EVM".`) with:

```yaml
# Runs the iOS bridge-IN E2E (EVM -> Miden) on every push to main and by
# dispatch, three specs:
#   - Epoch "Fast"/USDC: the Epoch SDK reads a stubbed Compact and USDC on a
#     local Anvil, builds a real `depositERC20AndRegister` that a headless Reown
#     counterparty signs and broadcasts, and registers the allocation with a
#     local FAKE allocator.
#   - AggLayer "Slow"/ETH: the app builds `bridgeAsset` calldata that the
#     counterparty signs and broadcasts to an Anvil bridge stub.
#   - Reown pairing alone.
# Both deposit specs drive the real deposit UI through a REAL Reown pairing, then
# the wallet consumes a REAL Miden note delivered by the miden-client CLI
# "solver" and reconciles it to "Bridged from EVM". The USDCx deposits run live
# in e2e-usdcx-live.yml (Arc xReserve, and the executor route from Base Sepolia,
# Arbitrum Sepolia and Ethereum Sepolia).
```

- [ ] **Step 3: CHANGELOG**

Append to the end of `### Fixes` under `## 1.17.5 (TBD)`:

```markdown
- [FIX][ci] E2E Bridge-IN no longer runs its Sepolia-fork USDCx spec, which registered Miden on Sepolia's xReserve itself and so tested a route production does not use there; the live Arc deposit and the executor-route deposits from Base Sepolia, Arbitrum Sepolia and Ethereum Sepolia in E2E USDCx Bridge-IN (live) cover the iOS USDCx deposit UI against Circle's real contracts.
```

- [ ] **Step 4: Dash check, commit, push**

No test file changes here, so nothing runs locally but the checks below; CI's run of this push reads the edited workflow (`linked-pr-injection.test.ts`) and type-checks that nothing imported the deleted files.

```bash
actionlint -oneline .github/workflows/e2e-bridge-in.yml   # prints nothing
git diff -U0 HEAD -- .github/workflows/e2e-bridge-in.yml | perl -CSD -ne 'print if /^\+.*[\x{2013}\x{2014}]/'
git diff -U0 CHANGELOG.md | perl -CSD -ne 'print if /^\+.*[\x{2013}\x{2014}]/'
git add .github/workflows/e2e-bridge-in.yml CHANGELOG.md
git commit -m "e2e bridge-in: retire the sepolia-fork usdcx spec"
git push
```

Expected: no actionlint output and no dash output (`git rm` already staged the deletions; the commit includes them).

---

### Task 12: Bridge-IN stabilisation: the Epoch count polled, every spec runs, dispatchable retries

**Why:** the Epoch Anvil mines a block a second (`bridge-in-deposit-epoch.ios.spec.ts:68`) and the counterparty logs a request when it is sent, not mined (`wc-counterparty.ts`), so the one immediate read of the Compact count at `:143` failed 5 of 38 attempts with `Expected: 1, Received: 0` (suite scout 4.3). The base config's `maxFailures: 1` (`playwright.ios.config.ts:39`) made one failed spec hide every spec after it: the retired receive spec's hard failure hid the pairing spec in every run since 2026-10-14 (suite scout section 2); Playwright 1.61 counts a test toward it only once its retries are spent (`node_modules/playwright/lib/runner/index.js:5563`). With retries a test that fails once and then passes exits 0 (agentic-kb note `tool/playwright-retries-turn-failures-into-flaky-passes`), so the proof before blocking is a run at `--retries=0`, which needs a dispatch input instead of a temporary commit. The workflow's own text still says "two specs" and blames "Project not found", which occurs 0 times in 33 logs (suite scout section 2).

**Files:**
- Modify: `playwright/e2e/ios/tests/bridge-in-deposit-epoch.ios.spec.ts:139-143`
- Modify: `playwright.ios.bridge-in.config.ts:10-19`
- Modify: `.github/workflows/e2e-bridge-in.yml` (`on.workflow_dispatch`, the timeout comment, the test step)
- Create: `playwright/e2e/harness/bridge-in-workflow.test.ts`

**Interfaces:**
- Produces: dispatch input `retries` (default `'2'`); the test step named `Run bridge-IN E2E (mobile, testnet + local Anvil)` with `env: RETRIES: ${{ inputs.retries || '2' }}`. Task 13 and the Delivery section rely on both.

- [ ] **Step 1: Write the pin test (it fails first)**

Create `playwright/e2e/harness/bridge-in-workflow.test.ts`:

```ts
/**
 * @jest-environment node
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '../../..');
const workflow = readFileSync(resolve(root, '.github/workflows/e2e-bridge-in.yml'), 'utf8');
const config = readFileSync(resolve(root, 'playwright.ios.bridge-in.config.ts'), 'utf8');

/** The suite's test step, from its name to the next step. */
function testStep(): string {
  const at = workflow.indexOf('      - name: Run bridge-IN E2E');
  if (at === -1) throw new Error('no bridge-IN test step');
  const next = workflow.indexOf('\n      - ', at + 1);
  return workflow.slice(at, next === -1 ? workflow.length : next);
}

describe('E2E Bridge-IN workflow', () => {
  // With the base config's maxFailures 1, one failed spec hid every spec after it: the Reown pairing spec did not run
  // from 2026-10-14 to 2026-10-17.
  it('runs every spec even after one failed', () => {
    expect(config).toMatch(/^ {2}maxFailures: 0,$/m);
  });

  // With retries, a test that fails once and then passes reads flaky and exits 0, so a fix is proven at retries 0.
  it('takes its retries from a dispatch input, 2 unless a dispatch says otherwise', () => {
    expect(workflow).toMatch(/\n {2}workflow_dispatch:\n {4}inputs:\n {6}retries:\n/);
    expect(testStep()).toContain("\n          RETRIES: ${{ inputs.retries || '2' }}\n");
    expect(testStep()).toMatch(
      /\n {8}run: yarn playwright test --config playwright\.ios\.bridge-in\.config\.ts --retries="\$RETRIES"\n/
    );
  });
});
```

Run: `yarn jest playwright/e2e/harness/bridge-in-workflow.test.ts --maxWorkers=1`
Expected: FAIL (no `maxFailures: 0`, no input, no step of that name).

- [ ] **Step 2: Poll the Epoch count**

In `playwright/e2e/ios/tests/bridge-in-deposit-epoch.ios.spec.ts`, replace `:139-143` (the four comment lines that start `        // The Compact stub actually executed the deposit` and the line `        expect(await readCompactDepositCount(anvil.rpcUrl)).toBe(1);`) with:

```ts
        // The Compact stub actually executed the deposit, not green against dead code. Anvil mines a block a second
        // here (--block-time 1) and the counterparty logs the request when it is sent, not mined, so the count is
        // polled. The allocation is registered (/compact) only AFTER the SDK's post-deposit receipt wait
        // (confirmations:3), so that is polled too.
        await expect.poll(() => readCompactDepositCount(anvil.rpcUrl), { timeout: 15_000, intervals: [500] }).toBe(1);
```

(The `await expect.poll(() => allocator.requests.some(...` lines after it stay.)

- [ ] **Step 3: Every spec runs**

In `playwright.ios.bridge-in.config.ts`, after `  testMatch: '**/bridge-in-*.ios.spec.ts',` add:

```ts
  // Every spec runs even after one failed: with the base config's maxFailures 1, one failed spec hid every spec after
  // it (the Reown pairing spec did not run from 2026-10-14 to 2026-10-17).
  maxFailures: 0,
```

- [ ] **Step 4: The dispatch input, the step and the stale text**

In `.github/workflows/e2e-bridge-in.yml`:

1. Replace `  workflow_dispatch:` (under `on:`) with:

```yaml
  workflow_dispatch:
    inputs:
      retries:
        description: Playwright retries per spec (0 proves a fix passes on its first attempt)
        required: false
        type: choice
        options:
          - '0'
          - '1'
          - '2'
        default: '2'
```

(A choice, so a dispatch can pass nothing but a retry count into the `run:` line; a push has no inputs, so `inputs.retries` is empty there and the step's `|| '2'` applies.)

2. Replace the timeout comment lines

```yaml
    # build (~25 min) + simulator cold boot (overlapped). The suite is two tests
    # (~2 min each, serial), and --retries=2 gives up to three fresh attempts each.
```

with:

```yaml
    # build (~25 min) + simulator cold boot (overlapped). The suite is three specs
    # (0.7-7 min an attempt, serial), and --retries=2 gives each up to three fresh
    # attempts.
```

3. Replace the whole test step (from `      - name: Run bridge-IN deposit E2E (mobile, testnet + local Anvil)` through `        run: yarn playwright test --config playwright.ios.bridge-in.config.ts --retries=2`) with:

```yaml
      - name: Run bridge-IN E2E (mobile, testnet + local Anvil)
        id: e2e
        # The specs run serially (workers: 1), each booting and tearing down its
        # own Anvil (and the Epoch spec its fake allocator), and every spec runs
        # even after one failed (maxFailures: 0). --retries=2 absorbs a degraded
        # simulator, CDP or a relay rate-limit trip on the connect step; each
        # attempt is a fresh wallet, pairing and Anvil. A dispatch can pass
        # retries: 0 to prove a fix passes on its first attempt.
        #
        # NON-BLOCKING only until a dispatch at retries 0 passes on this config.
        continue-on-error: true
        env:
          RETRIES: ${{ inputs.retries || '2' }}
        run: yarn playwright test --config playwright.ios.bridge-in.config.ts --retries="$RETRIES"
```

- [ ] **Step 5: Run the pins and their directory**

Run: `yarn jest playwright/e2e/harness --maxWorkers=1`
Expected: PASS, `bridge-in-workflow.test.ts` and `linked-pr-injection.test.ts` (which reads the edited workflow) included.

- [ ] **Step 6: Format, dash check, commit, push**

```bash
F="playwright/e2e/ios/tests/bridge-in-deposit-epoch.ios.spec.ts playwright.ios.bridge-in.config.ts playwright/e2e/harness/bridge-in-workflow.test.ts"
yarn prettier --check ${=F}
yarn eslint --max-warnings 0 ${=F}
actionlint -oneline .github/workflows/e2e-bridge-in.yml   # prints nothing
perl -CSD -ne 'print "$ARGV:$.: $_" if /[\x{2013}\x{2014}]/' playwright/e2e/harness/bridge-in-workflow.test.ts
git diff -U0 HEAD -- playwright/e2e/ios/tests/bridge-in-deposit-epoch.ios.spec.ts playwright.ios.bridge-in.config.ts .github/workflows/e2e-bridge-in.yml | perl -CSD -ne 'print if /^\+.*[\x{2013}\x{2014}]/'
git add ${=F} .github/workflows/e2e-bridge-in.yml
git commit -m "e2e bridge-in: poll the epoch deposit count, run every spec, dispatchable retries"
git push
```

The Epoch edit removes the em dash the old comment carried, but six others stay in lines it does not touch (`:16`, `:19`, `:42`, `:104`, `:122`, `:164`), so for that file and the workflow use the added-lines form from Global Constraints: `git diff -U0 HEAD -- playwright/e2e/ios/tests/bridge-in-deposit-epoch.ios.spec.ts .github/workflows/e2e-bridge-in.yml playwright.ios.bridge-in.config.ts | perl -CSD -ne 'print if /^\+.*[\x{2013}\x{2014}]/'` prints nothing, and the whole-file form only for the new `bridge-in-workflow.test.ts`.

---

### Task 13: E2E Bridge-IN fails its run when a spec fails

**Why:** `continue-on-error: true` (`e2e-bridge-in.yml:251`) made every run since 2026-10-14 read green with a red test step, 30 of 30, and the API reports even the step as `success` (suite scout section 0); it hid a real deposit regression from #1453 to #1478 for 14 runs (suite scout 4.4). The user asked for the suite to block once green. "Blocking" here means a red run on main and on a dispatch: no ruleset requires a check on main (suite scout section 6, item 10), and the workflow has no `pull_request` trigger by design (`e2e-bridge-in.yml:21-22`).

**Gate (do not start this task before it holds):** an E2E Bridge-IN dispatch on the branch head with `retries=0` (Delivery step D3) shows `3 passed`, no `failed`, no `flaky`, no `did not run`, no `Testing stopped early`, and no `Init() was called` warning in the test step's log. Record that run's URL for the PR body.

**Files:**
- Modify: `.github/workflows/e2e-bridge-in.yml` (the test step)
- Modify: `playwright/e2e/harness/bridge-in-workflow.test.ts` (one case)
- Modify: `playwright/e2e/docs/e2e-architecture.md:340`
- Modify: `CHANGELOG.md`

**Interfaces:** none new.

- [ ] **Step 1: Add the failing pin**

Append inside `describe('E2E Bridge-IN workflow', ...)` in `playwright/e2e/harness/bridge-in-workflow.test.ts`:

```ts
  // The suite is the bridge-in deposit's only hermetic E2E; continue-on-error kept main green through a real
  // regression (#1453 to #1478) and through three days in which one spec failed every run.
  it('fails its run when a spec fails', () => {
    expect(testStep()).not.toMatch(/^ {8}continue-on-error:/m);
  });
```

Run: `yarn jest playwright/e2e/harness/bridge-in-workflow.test.ts --maxWorkers=1`
Expected: FAIL on the new case.

- [ ] **Step 2: Make it blocking**

In the test step of `.github/workflows/e2e-bridge-in.yml`, replace

```yaml
        # retries: 0 to prove a fix passes on its first attempt.
        #
        # NON-BLOCKING only until a dispatch at retries 0 passes on this config.
        continue-on-error: true
```

with:

```yaml
        # retries: 0 to prove a fix passes on its first attempt. A failed spec
        # fails the run.
```

- [ ] **Step 3: Docs and CHANGELOG**

In `playwright/e2e/docs/e2e-architecture.md`, replace the paragraph that starts `> **Status:** the mobile bridge-in suite runs after merge to main and does not yet fail its run.` (`:340`) with:

```markdown
> **Status:** the mobile bridge-in suite runs after every merge to main and fails its run when a spec fails. Its three specs drive the real deposit UI or the Reown pairing alone; none makes a bridge row through a test hook. Every spec runs even after another failed, and a dispatch can run the suite with `retries: 0` to prove a fix passes on its first attempt. Each test's Reown counterparty has a Reown core of its own and answers nothing once its test ends, so no counterparty answers a later test's app. The app and the counterparty pair through the built-in Reown project id; relay rate limits are handled by retrying the connect step. The live USDCx deposits, from Arc and on the executor route from Base Sepolia, Arbitrum Sepolia and Ethereum Sepolia, run in E2E USDCx Bridge-IN (live).
```

Append to the end of `### Fixes` under `## 1.17.5 (TBD)` in `CHANGELOG.md`:

```markdown
- [FIX][ci] E2E Bridge-IN fails its run when a spec fails, instead of reading green: each test's Reown counterparty has a Reown core of its own and answers nothing once its test ends (an earlier test's counterparty answered later tests' requests, the cause of most retry-only passes), the Epoch spec waits for its deposit to be mined, every spec runs after another failed, and a dispatch can run the suite with no retries.
```

- [ ] **Step 4: Run the pin, dash check, commit, push**

```bash
yarn jest playwright/e2e/harness/bridge-in-workflow.test.ts --maxWorkers=1   # PASS, 3 tests
actionlint -oneline .github/workflows/e2e-bridge-in.yml   # prints nothing
git diff -U0 HEAD -- .github/workflows/e2e-bridge-in.yml playwright/e2e/harness/bridge-in-workflow.test.ts | perl -CSD -ne 'print if /^\+.*[\x{2013}\x{2014}]/'
git diff -U0 CHANGELOG.md playwright/e2e/docs/e2e-architecture.md | perl -CSD -ne 'print if /^\+.*[\x{2013}\x{2014}]/'
git add .github/workflows/e2e-bridge-in.yml playwright/e2e/harness/bridge-in-workflow.test.ts playwright/e2e/docs/e2e-architecture.md CHANGELOG.md
git commit -m "e2e bridge-in fails its run when a spec fails"
git push
```

Expected: jest PASS; no dash output.

---

## What the key needs

Funding is not a task, and no agent moves funds (Global Constraints). Each executor job deposits from, and is refilled to, `USDCX_LIVE_EVM_PRIVATE_KEY` (address `0x9336e3F0B913C4316Fc75918fDb88aA5e1fe49Dc`) on its own source chain. The Arc job is unchanged and keeps refilling itself on Arc (the key held 104.43 USDC there, usdcx-ios scout 1.5).

| | Base Sepolia (84532) | Arbitrum Sepolia (421614) | Ethereum Sepolia (11155111) |
|---|---|---|---|
| USDC (`L2_BRIDGE_IN_SOURCES`) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` |
| Holds (read-only `eth_getBalance`, `balanceOf` and `eth_getTransactionCount` on the publicnode endpoints, 2026-10-17) | 0.006 ETH, 1.5 USDC, nonce 0 | 0.006 ETH, 1.5 USDC, nonce 0 | 0.0005 ETH, 1.5 USDC, nonce 0 |
| Fees then (`eth_gasPrice`, `eth_maxPriorityFeePerGas`) | 0.006 gwei, tip 0.001 gwei | 0.02 gwei, tip 0 | 18 wei, tip 1 wei; its sends cap the tip at 0.01 gwei |
| Floor the spec's preflight enforces | ETH for `L2_BRIDGE_IN_GAS` = 1,100,000 gas at the live max fee (`usdcx-l2-deposit.ts:91-97`; about 0.000008 ETH then) and 0.101 USDC (`DEPOSIT_UNITS` + 2 x `PREFLIGHT_FORWARD_FEE`); the `l2_key` step then checks the amount plus twice Circle's live quote | The same (about 0.000026 ETH then) | The same (well under 0.000001 ETH then; 0.0005 ETH covers a max fee up to about 0.45 gwei), and any USDC above 0, without which Circle never pays the burn half (`payoutKeyProblem`) |
| Per green run | Spends about 0.0234 USDC (0.001 deposited plus the forward fee, 0.022404 when quoted on 2026-10-16) and about 0.000005 ETH (an approve of about 55k gas and a burn of 693-699k); the 1 USDCx burn's payout returns about 0.99 USDC, so the USDC grows about 0.97 | Spends about 0.023 USDC and about 0.000015 ETH; the payout returns about 0.99 USDC | Spends about 0.017 USDC (the forward fee was 0.015638 when quoted) and well under 0.00001 ETH at these fees (an approve of 40-140k gas and a burn of about 727k); the 2 USDCx burn's payout returns about 0.9965 USDC, so the USDC grows about 0.98 |
| Send before the first dispatch | Nothing | Nothing | Nothing at these fees. Optional headroom: 0.0015 ETH more (to 0.002 ETH, the CI key's level there) keeps the floor met up to about a 1.8 gwei max fee |

Who funds it: the user, asked by the controller only for a chain the read below shows under its floor. No agent sends these funds: a transfer needs a private key, which this plan never reads. The CI harness key `USDCX_HARNESS_ARC_KEY` (0x4D4A180C637a71FCB9b5BD1186C8ce23C40EBa81) is never a source, at any time: `usdcx-burn-l2` proves its balances on these chains as exact deltas under the `usdcx-harness-arc-key` group, and a push to main can start an E2E USDCx run between any "no run in progress" check and a transfer.

Read-only check before the first live dispatch (no key is read):

```bash
A=0x9336e3F0B913C4316Fc75918fDb88aA5e1fe49Dc
for pair in \
  'https://base-sepolia-rpc.publicnode.com 0x036CbD53842c5426634e7929541eC2318f3dCF7e' \
  'https://arbitrum-sepolia-rpc.publicnode.com 0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' \
  'https://ethereum-sepolia-rpc.publicnode.com 0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238'; do
  set -- ${=pair}   # zsh: the RPC, then the chain's USDC
  for call in \
    "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getBalance\",\"params\":[\"$A\",\"latest\"]}" \
    "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"eth_call\",\"params\":[{\"to\":\"$2\",\"data\":\"0x70a08231000000000000000000000000${A#0x}\"},\"latest\"]}" \
    '{"jsonrpc":"2.0","id":3,"method":"eth_gasPrice","params":[]}'; do
    curl -s -m 15 -X POST "$1" -H 'content-type: application/json' -d "$call"; echo
  done
done
```

Expected, on each chain: a wei balance of at least 1,100,000 x 1.2 x the gas price read (on Ethereum Sepolia with the tip part at most 0.01 gwei), a USDC balance of at least `0x18a88` (101,000 base units), and on Ethereum Sepolia any USDC at all.

## Open items (for the controller to raise; none blocks Tasks 1-13)

1. **Left out on purpose** (name them in the PR body; filing them is the user's call): removing the E2E-only product flag `MIDEN_E2E_USDCX_CHAIN` (`src/lib/usdcx/constant.ts:18`, five vite defines, `scripts/e2e-real.mjs:378`) and `anvil.ts`'s `forkUrl` option, both unused once Task 11 lands; the Reown add-chain and switch-chain path, which no E2E reaches because each executor counterparty approves its source chain alone (usdcx-ios scout 2.4); E2E Bridge-IN's `cancel-in-progress: true` on main, which cancelled 7 of the last 40 main runs (suite scout section 6, item 9).
2. **Accepted residual risk across runs** **[I]**: placing the executor jobs after the Arc job keeps one run's jobs apart, but an executor job that ends while Circle's forward is still pending (red or timed out after the burn) lets that forward execute later, and if the executor cannot deposit into xReserve it pays its recovery address, the key, on Arc (`src/lib/usdcx/executor.ts:206-217` makes the depositor that address). Runs queue back to back (`e2e-usdcx-live.yml:61-65`), so such a payment can land inside the next run's Arc payout window and fail that exact-delta gate; with three executor jobs a run has three such chances. A red Arc payout gate right after a red executor job is first read against that job's evidence (its burn hash and the forward's state on Iris) before anything else is suspected.
3. **CI cost**: every push to main, the nightly and every `legs=all` dispatch now run four macOS jobs of E2E USDCx Bridge-IN (live) instead of one, the three executor jobs up to 170 minutes each, in parallel. The user chose all three chains (decision 3 of 2026-10-17); the PR body names the cost.
4. **Ethereum Sepolia ETH headroom**: optional, see "What the key needs"; asked of the user only when a Sepolia preflight reports the floor.

## Delivery

The branch is pushed after every task but Task 1, whose commit goes out with Task 2's red push. Locally each task runs only its changed test files and their directories at `--maxWorkers=1`, prettier and eslint; CI runs builds, `tsc`, lint, full jest, coverage, simulators and every E2E suite (Global Constraints). The draft PR exists from Task 2 Step 3. Every fix after a red check is a new commit; never amend, never force-push. The live and simulator workflows are dispatched as soon as what they test exists (D2a, D4), not only at the end.

- [ ] **D1: Red-before recorded.** Task 2 Step 3's run URL, failing on exactly the two new counterparty test files, is kept for the PR body.

- [ ] **D2a: An early E2E Bridge-IN read, right after Task 2's implementation is pushed.** Tasks 1-2 hold the receive spec's retirement and the counterparty isolation, and the workflow is dispatchable before Task 12 adds its `retries` input: `gh workflow run e2e-bridge-in.yml --repo 0xMiden/wallet --ref wiktor/reown-bridge-in-e2e`, then read the log as D3 does. Expected: the Epoch, Sepolia-fork USDCx, AggLayer deposit and Reown pairing specs pass (retries allowed; until Task 12, `maxFailures: 1` still stops the run at the first spec whose retries are spent), no receive spec runs, and no `Init() was called` warning appears. The job still reads `success` under `continue-on-error`, so the log is the verdict. A red spec is fixed now, while Tasks 3-12 are built; it does not wait for D3. The Reown pairing spec has not run since 2026-10-14 (suite scout section 3), so its first run can need a fix.

- [ ] **D2: PR checks on the head after Task 12.** Watch every check of the current head, and fix each red one with a new commit as soon as it reports:

```bash
gh pr checks <n> --repo 0xMiden/wallet --watch --fail-fast; echo "exit $?"
gh run view <run> --repo 0xMiden/wallet --log-failed | head -200
```

What runs on the PR (suite scout): `pr.yml` (ESLint, `tsc`, jest, the coverage shards and their 95% gate over `src`, `lint:i18n`, `lint:e2e`, mock-e2e), `pr-compile-surfaces.yml`, the five `pr-e2e-*` suites and `changelog.yml`. `bridge-in-test-hooks.ts` is outside the coverage denominator (`jest.config.ts:94`); `SelectAmount.tsx` gains one attribute, covered by Task 3's test. A coverage gap CI reports is closed with tests, never a lower threshold.

- [ ] **D3: E2E Bridge-IN at retries 0 on the branch head.** The PR body must carry no `Web SDK PR:`, `Client PR:` or `Protocol PR:` marker, or the dispatch builds the linked PRs from source (`.github/actions/inject-linked-web-sdk-pr/action.yml:3-12`). A second dispatch on the same branch cancels the first (`e2e-bridge-in.yml:37-39`).

```bash
gh workflow run e2e-bridge-in.yml --repo 0xMiden/wallet --ref wiktor/reown-bridge-in-e2e -f retries=0
# the run takes a few seconds to appear; list again until one shows with headSha = git rev-parse HEAD
gh run list --repo 0xMiden/wallet --workflow e2e-bridge-in.yml --branch wiktor/reown-bridge-in-e2e --event workflow_dispatch --limit 1 --json databaseId,headSha,status
gh run watch <id> --repo 0xMiden/wallet; gh run view <id> --repo 0xMiden/wallet --log > bridge-in-<id>.log
grep -E ' passed| failed| flaky|did not run|Testing stopped early|Init\(\) was called' bridge-in-<id>.log | head -40
```

(Save the log under the scratchpad, never in the repository.) While `continue-on-error` is still on the step, the job reads `success` whatever happened, so the log is the verdict. Expected: `3 passed` (Epoch, AggLayer deposit, Reown pairing), no `failed`, `flaky`, `did not run` or `Testing stopped early`, and no `Init() was called` warning. A red spec is diagnosed from the log and the artifact (`gh run download <id> --repo 0xMiden/wallet -n bridge-in-e2e-testnet-<id> -D <scratchpad dir>`), fixed with a new commit, pushed, and dispatched again at `retries=0`.

- [ ] **D4: E2E USDCx Bridge-IN (live) on the branch.** Before each dispatch the read-only check in "What the key needs" passes, and no run of the workflow is in progress or queued: its group is the whole workflow and never cancels a running run, but a run still waiting is cancelled when a newer one queues, as `e2e-usdcx.yml:36-39` notes for its own group, so dispatch one at a time and re-dispatch a cancelled one.

```bash
gh run list --repo 0xMiden/wallet --workflow e2e-usdcx-live.yml --status in_progress --json databaseId,headBranch
gh run list --repo 0xMiden/wallet --workflow e2e-usdcx-live.yml --status queued --json databaseId,headBranch
```

- **D4a, as soon as Task 10 is pushed:** `gh workflow run e2e-usdcx-live.yml --repo 0xMiden/wallet --ref wiktor/reown-bridge-in-e2e -f legs=all`. Expected: the Arc job `success` running the refactored Arc spec (Task 8's proof), then the three executor jobs, `USDCx bridge-IN E2E from base-sepolia`, `from arbitrum-sepolia` and `from sepolia`, each `success` with `1 passed`.
- **Re-runs:** a fix re-dispatches only the leg it touched (`-f legs=arc`, `-f legs=base-sepolia`, `-f legs=arbitrum-sepolia` or `-f legs=sepolia`), never with retries.

Watch with `gh run watch <id>`. A run takes about 1.5 to 3.5 hours: the Arc job 30 to 60 minutes, then the executor jobs in parallel, each up to its ceiling (170 minutes on a dispatch without linked PRs). Read each job's evidence artifact (`usdcx-live-e2e-<id>`, `usdcx-live-executor-e2e-<slug>-<id>`) for the hashes, fees and phases. A red executor step is the first E2E of the deposit screen's executor branch (Task 9, **[I]**): a product defect is fixed in this PR with a unit test that fails without the fix; a harness defect is fixed in the harness. Each re-run spends real funds. Before merging, all four legs must be green on a head whose later commits touched none of their files (D7); if they are not, one `-f legs=all` dispatch on the final head proves them.

- [ ] **D4b: The iOS suites that load the changed page object but no PR event runs, once on the final head** (the user asked for "ideally all the simulators too", and decision 4 runs simulators in CI). Task 7 changes `ios-wallet-page.ts` and Task 1 removes a method from it; every iOS suite loads it through `playwright/e2e/ios/fixtures/two-simulators.ts`. Each of these keys its concurrency on the ref, so a branch dispatch never cancels main's run.

```bash
B=wiktor/reown-bridge-in-e2e
gh workflow run e2e-blockchain.yml --repo 0xMiden/wallet --ref "$B" -f network=testnet   # main's push runs testnet (e2e-blockchain.yml:175-177, :766-768)
gh workflow run e2e-dapp-browser.yml --repo 0xMiden/wallet --ref "$B"
```

Expected: each concludes `success`. Before calling any red run this PR's doing, pull the same workflow's last runs on main (`gh api 'repos/0xMiden/wallet/actions/workflows/<file>/runs?branch=main&per_page=20' --jq '.workflow_runs[] | "\(.created_at[:10]) \(.conclusion) \(.head_sha[:8])"'`): a failure that main already shows is reported with that evidence, not fixed here. The build workflows need no dispatch: this PR edits none of them, and `pr-compile-surfaces.yml` and `pr.yml`'s mock-e2e build every surface on the PR itself.

- [ ] **D5: Make E2E Bridge-IN blocking.** Once D3 holds, run Task 13, push, and dispatch once more with the default retries (`gh workflow run e2e-bridge-in.yml --repo 0xMiden/wallet --ref wiktor/reown-bridge-in-e2e`). Expected: the job concludes `success` with the test step no longer under `continue-on-error`, and the log again reads `3 passed`.

- [ ] **D6a: One CHANGELOG line for the PR.** The repository adds one line per PR: each of the last 12 PRs that touched `CHANGELOG.md` added one, and #1508 added two (`git show <sha> -- CHANGELOG.md`). CLAUDE.md asks for a "one-liner per PR/task (not per fix)". Tasks 1, 10, 11 and 13 each add a line, so that `changelog.yml` stays green while the PR is built. Before the PR is marked ready, replace this PR's four `[FIX][ci]` lines under `## 1.17.5 (TBD)` -> `### Fixes` with this one, in a new commit (`changelog: one line for the bridge-in e2e pr`):

```markdown
- [FIX][ci] E2E Bridge-IN fails its run when a spec fails again, and every iOS bridge-in E2E deposits through the real deposit screen: the AggLayer receive spec, whose row an E2E hook made, and the Sepolia-fork USDCx spec are retired, each test's Reown counterparty has a Reown core of its own and answers nothing once its test ends, the Epoch spec waits for its deposit to be mined, and every spec runs after another failed. E2E USDCx Bridge-IN (live) gains an iOS job per executor-route source chain (Base Sepolia, Arbitrum Sepolia, Ethereum Sepolia) that deposits 0.001 USDC through the deposit screen and a Reown pairing, proves every hop and burns USDCx back to the key there.
```

Check it with `git diff -U0 HEAD -- CHANGELOG.md | perl -CSD -ne 'print if /^\+.*[\x{2013}\x{2014}]/'` (prints nothing), push, and confirm `changelog.yml` is green on that head.

- [ ] **D6: The PR text.** Replace the draft body (`gh pr edit <n> --repo 0xMiden/wallet --body-file <scratchpad>/pr-body.md`), then `gh pr ready <n> --repo 0xMiden/wallet`. Shape (the user's PR rules): one opening sentence, one-line bullets, depth in `<details>`, a closing `Reviewers:` line, Reown in prose, no em or en dash, no tool name, no attribution line of any kind, no linked-PR marker. Content, with the run URLs from D1, D3, D4, D4b and D5 filled in:

```markdown
Every iOS bridge-in E2E now deposits through the real deposit screen, the USDCx executor route runs live from all three chains the wallet offers it on, and E2E Bridge-IN can fail again.

- Retired: the AggLayer receive spec (an E2E hook made its row; the deposit spec already checks all it did) and the Sepolia-fork USDCx spec (a route production does not have). The hook now makes USDCx rows only.
- Bridge-IN harness: one Reown core per counterparty, silent once stopped (the retry-only passes); the Epoch count is polled; every spec runs; a `retries` input; no `continue-on-error`.
- E2E USDCx Bridge-IN (live): a matrix job after the Arc job deposits 0.001 USDC from Base Sepolia, Arbitrum Sepolia and Ethereum Sepolia through the deposit screen, proves each hop with the extension's executor gates, and burns USDCx back to the key on each chain.
- A `legs` input runs the Arc job or one chain alone. On Ethereum Sepolia the counterparty tips at most 0.01 gwei, and a key with no Sepolia USDC is refused before anything is spent.

Proof: red-before <D1 run>; E2E Bridge-IN at retries 0, 3 passed <D3 run>; E2E USDCx Bridge-IN (live), all four legs <D4 run>; the iOS suites sharing the page object <D4b runs>; E2E Bridge-IN blocking <D5 run>.

<details><summary>Funding and cost</summary>

The deposit key holds ETH and USDC on all three source chains; each green run refills its USDC on each chain, and its ETH is sent by hand. Each run of E2E USDCx Bridge-IN (live) now runs four macOS jobs: the Arc job, then three executor jobs in parallel. The Reown project id stays the built-in default, which is the paid project.
</details>

<details><summary>Not in this PR</summary>

Removing the E2E-only `MIDEN_E2E_USDCX_CHAIN` flag and `anvil.ts`'s `forkUrl`; an E2E of the Reown add-chain and switch-chain path; keeping every main run of E2E Bridge-IN instead of cancelling superseded ones. The Chrome `usdcx`, `usdcx-in` and `usdcx-in-l2` suites keep signing in Node and making their rows through the test hook: the extension cannot pair with Reown.
</details>

Reviewers: the burn-half move out of the green Arc spec (`usdcx-live.ts`) and the executor matrix's place after the Arc job are the parts worth your time.
```

Check the file before it is used: `perl -CSD -ne 'print if /[\x{2013}\x{2014}]/' <scratchpad>/pr-body.md` prints nothing, and `grep -E 'Web SDK PR|Client PR|Protocol PR|Co-Authored|Generated with' <scratchpad>/pr-body.md` prints nothing.

- [ ] **D7: Merge on green.** Merge only when every check of the current head is green (`gh pr checks <n> --repo 0xMiden/wallet` lists no failing or pending check), D3, D4 (all four legs), D4b and D5 are green on a head whose later commits touched none of their files (a D4b failure that main already shows, read as D4b says, does not block), and the CHANGELOG section is still unreleased (`git fetch --tags`; if `v1.17.5` exists, move this PR's entries to a new `## 1.17.6 (TBD)` section above it in a new commit). Squash with an explicit body so no commit trailer reaches main (agentic-kb `github-squash-merge-body-replaces-commit-messages`):

```bash
gh pr merge <n> --repo 0xMiden/wallet --squash \
  --subject "iOS bridge-in E2E: UI-only specs, live executor-route deposits from three chains, blocking suite (#<n>)" \
  --body "Retires the bridge-in specs that skipped the deposit screen, isolates the Reown counterparties, adds live iOS executor-route deposit jobs from Base Sepolia, Arbitrum Sepolia and Ethereum Sepolia, and makes E2E Bridge-IN blocking."
```

The main ruleset requires no approval and no status check (suite scout section 2), so no `--admin` is needed.

- [ ] **D8: After the merge.** Confirm main got its runs by the merge commit's SHA, not the branch (`gh api "repos/0xMiden/wallet/actions/runs?head_sha=$(git rev-parse origin/main)" --jq '.total_count'` is non-zero after `git fetch origin main`; agentic-kb `github-actions-push-sometimes-creates-no-runs`), and that the first main runs of E2E Bridge-IN (now blocking) and E2E USDCx Bridge-IN (live), all four of its jobs, pass. Write the machine-independent gotcha D3 confirmed into the team knowledge base (`~/agentic-kb/scripts/note.sh tool/walletconnect <slug>`, then `--push`): `@walletconnect/core` 2.23.x caches one Core per `customStoragePrefix` on `globalThis`, so a second `SignClient.init` in the same Node process shares the first one's relayer, pairings and storage, and the first client's listeners can answer the second's session; give each client its own `customStoragePrefix` (or set `DISABLE_GLOBAL_CORE=true`) and stop listening when done. Log the notes that helped (`note.sh --used tool/playwright-retries-turn-failures-into-flaky-passes "..."`, and `github-actions-push-sometimes-creates-no-runs` if D1 or D8 needed it).

## Self-review

**Coverage of the user's decisions of 2026-10-17 (`reown-plan-revision.md`):**

| Decision | Where |
|---|---|
| 1. The Reown project id stays the built-in default | Decisions row "Reown project id". The old secret-wiring task is gone with its Review Focus line, its two Decisions rows, its File Structure rows, its CHANGELOG line, its README edit and its Delivery and Open items. |
| 2. Every bridge-in spec takes the UI route | Task 1 (receive spec retired; its checks compared with the deposit spec's, nothing to move; `createBridgeReceive` deleted; the hook's `provider` and unused fields gone; docs and CHANGELOG), Task 11 (the fork spec, kept from the old plan). The Chrome Node-signed suites are out of scope (Decisions). |
| 3. All three executor chains | Task 5 (the Sepolia tip cap, pinned), Task 6 (chain-generic gates, `payoutKeyProblem`), Task 7 (an exact network name), Task 9 (one test per chain, `USDCX_LIVE_SOURCE`, the zero-USDC preflight), Task 10 (the matrix after the Arc job, `fail-fast: false`, the same `needs`, `if` and ceiling, `legs` with one slug per chain), "What the key needs" (per chain) |
| 4. Where checks run | Global Constraints, first lines; every step's local `yarn jest` names changed test files or their directories at `--maxWorkers=1` |
| Kept: the counterparty, the old Tasks 4, 5, 7, 8, 9, 12, 14 and 15 | Tasks 2, 3, 4, 6, 7, 8, 11, 12 and 13 |
| Kept: the deliberate red-before push | Re-attached to Task 2, the first task whose tests fail at `fd614122d`; Task 1 adds no such test (Global Constraints) |

**Placeholders:** none in the task steps. `<n>`, `<id>`, `<run>`, `<slug>` and the D6 run links are values that exist only once CI has run, filled in during Delivery.

**Type and name consistency:** `CounterpartyTransaction` (Task 2) and `L2Transaction` (Task 5) are both `{ to: Address; data: Hex; value: bigint }`, and Task 9 passes one to the other through `send: (tx, signal) => sender.send(tx, signal)`. `executorDepositRequests` returns `{ approve?: { hash; value }; burn: { hash; hookData } }` (Task 6), which Task 9 reads as `requests.approve?.hash` and `requests.burn.hookData`. `L2BurnSubmission` (Task 6) is what Task 9 builds for `confirmL2Burn`; `payoutKeyProblem(chain, address, usdc)` (Task 6) is what Task 9's preflight calls. `selectBridgeNetwork(slug, name)` and `networkRowNames` (Task 7) are called with `chain.reviewNetwork` (the drawer's `bridge-network-<slug>` uses the same `evmChainSlug`, `src/screens/send-flow/bridge-networks.ts:19-21`) and `chain.networkName`. Task 8's exports (`assertHostedGuardianAccount`, `burnBackToDepositKey`, `evidenceBody`, `settleLedger`, `VAULT_MS`, `BURN_BUDGET`, `noteIdsOf`) are the names Tasks 8 and 9 import. `cctpForwarded` and `cctpForwardFee` are the same names in the hook, the parser and the spec (Tasks 4, 9). `SOURCE_SLUGS`, `SELECTED_SOURCE`, `SOURCES` and `USDCX_LIVE_SOURCE` are the same in Task 9's spec and pins; the slugs `base-sepolia`, `arbitrum-sepolia` and `sepolia` are `L2_BRIDGE_IN_SOURCES`' `payout.reviewNetwork`, which Task 10's pins compare with the matrix and the `legs` options. The job id `mobile-usdcx-live-executor`, its step names and its ceiling line are the same in Task 10's workflow, its pins and `linked-pr-injection.test.ts`. The test step `Run bridge-IN E2E (mobile, testnet + local Anvil)` and `RETRIES` are the same in Tasks 12 and 13. `CreateUsdcxBridgeReceiveArgs` (Task 1) is the only argument type of the hook.

**Checked against the tree while revising this plan (at `fd614122d`, read-only):** Task 1's callers (`git grep -w` output in its Step 1), the receive and deposit specs' assertions line by line, the hook's line numbers after Task 1 (`:41-51`, `:85-95`, by applying Task 1's edit in memory) and the page object's (`:411-426` deleted, so every later number less 16); `sendSigned` caps the tip at `chainOf(deps).maxPriorityFeeCap` and `l2Reads` sets `payoutChain` (`arc-usdcx.ts:838-876`, `usdcx-l2-deposit.ts:39-44`), and the Chrome tests' max-fee arithmetic (`usdcx-l2-deposit.test.ts:365-384`) is the one Task 5's tip cases use; `probeSepoliaPayoutKey` (`scripts/e2e-real.mjs:1488-1516`); `evmChainSlug` (`src/lib/remote-config/chains.ts:14-21`) and the wallet's chain names (viem's, `src/lib/walletconnect/config.ts:76-86`); the testnet document's four USDCx chains (version 10; Arc on xReserve, the other three on the executor); `linked-pr-injection.test.ts` skips a job's indent-6 and deeper keys before `steps:` (`:51-104`) and reads `if:` only for pull-request workflows (`:207-210`); the iOS key's balances on the three chains (read-only RPC, 2026-10-17). Task 8's cut boundaries (`usdcx-live-deposit.ios.spec.ts:1, :59, :105, :141, :158-159, :230, :232, :452, :765, :766`) and its import list are unchanged from the pre-flight review, since Task 7 changes no line count of that file.

**Review Focus:** each of its five lines has a test in the owning task (Tasks 7, 5, 5, 6 and 9, 2).

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-10-17-reown-bridge-in-e2e-plan.md` (excluded from git through `.git/info/exclude`, never committed). The header names the execution method (superpowers:subagent-driven-development); the user approved all superpowers plans and asked for autonomous work, so execution starts at Task 1 and runs through Delivery.

---
