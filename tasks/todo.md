# Fee faucet discovery and USDCX value

- [x] Read discovery, repository rules, and decision profile; inspect all sync and pricing paths.
- [x] Verify this isolated branch matches current `origin/next` and install frozen dependencies with Node 22.
- [x] Record a green 146-test baseline and complete the independent plan check.
- [x] Implement scoped sync-time discovery and cross-realm publication with RED/GREEN tests.
- [x] Preserve authoritative native metadata, fixed $1 USDCX value and the actual Send fee reserve.
- [x] Verify the uninjected devnet path with an empty market feed and an independent header read.
- [x] Complete discovery, risk and adversarial code panels; correct all twelve grouped findings and reverify mutations.
- [x] Finish focused and static validation of the metadata, startup-publication and render-notification corrections.
- [ ] Run full tests, unchanged 95% coverage gates and browser regressions on the final PR head in CI only.
- [x] Publish PR #1351 against `next` while completing review, as explicitly requested.
- [x] Correct the confirmed stale-metadata bootstrap P1 and the explicitly reopened valuation snapshot P2.
- [x] Default fresh native display to USDCX and a fixed $1 unit quote; require confirmed scale for quantities and fees.
- [x] Update native fee, funding and auto-accept copy across all 14 locales and align default token selectors.
- [x] Finish the remaining internal review on the corrected committed checkpoint; other P2/P3 findings remain nonblocking.
- [ ] Babysit the PR to green and admin squash merge.
- [ ] Babysit `origin/next` to green and publish wallet `v1.17.1` with all required assets verified.
- Store publishing is handled by the user; preserve the existing `v1.17.0` release and tag.

Local results are recorded in `tasks/fee-faucet-plan.md`. Final certification, merge and wallet `v1.17.1` release follow this source checkpoint and are recorded in the PR and release.

# Issue #537 - guarded .mac account export

## Plan

- [x] Read the issue, repository instructions, decision profile, frontend guidance, and required TDD references.
- [x] Trace the supported web-client `accounts.export()` path, wallet vault key storage, realm keystore lifecycle, intercom actions, and Advanced Settings routing.
- [x] Measure TypeScript and TSX comment density before editing production code.
- [x] RED: add focused tests for a scoped vault-backed `getKey` callback and serialized account-file export, then run them and record the expected failures.
- [x] GREEN: implement scoped realm `getKey` installation, authenticated vault key reads, and `MidenClientInterface` account-file serialization.
- [x] RED: add request, store, and context tests for a base64-safe account-file export action, then run them and record the expected failures.
- [x] GREEN: wire the export through the backend, both intercom paths, Zustand, and `useMidenContext`.
- [x] RED: add Advanced Settings and export-screen tests covering warning acknowledgement, credential step-up, binary download/share, success, and failure.
- [x] GREEN: add the routed export screen under Advanced Settings with localized fund-access warning copy.
- [x] Add the issue changelog entry under the unreleased version.
- [x] Run focused Jest suites, scoped type and lint gates, i18n lint, and formatting checks.
- [x] RED: prove an in-flight `getKey` result escaped after its client generation was replaced.
- [x] GREEN: add the universal post-await generation check to the per-client `getKey` trampoline.
- [x] Run all affected tests and static gates, the configured 95% coverage gate, affected builds with artifact/error checks, and visual verification.
- [x] Inspect the final diff, scan authored text for U+2014/U+2013 and attribution, and create the signed implementation commit.
- [ ] Run the four-seat Review Council from a fresh session, apply all actionable findings, and reverify.
- [ ] Push once, open the non-draft PR with `Closes #537`, babysit CI/review/conflicts to green, and admin squash merge.

## Architecture

The wallet's singleton client already uses the supported web-client `accounts.export()` API, but its external keystore intentionally refuses `getKey` during normal operation. The export action will authenticate first, install a vault-backed key reader only for one mutex-held export, remove it by identity in `finally`, serialize the returned `AccountFile`, and carry the bytes through intercom as base64. A routed Advanced Settings screen will require an explicit fund-access acknowledgement plus password, passcode, or device-security confirmation before downloading or sharing `<account-id>.mac`.

## Review

- RED core: 10 expected failures across four suites because the realm `getKey` slot, vault reader, SDK export method, and action did not exist.
- RED transport: three expected failures because the request enum, dispatch cases, and store action did not exist.
- RED UI: the new page module and route were absent, and Advanced Settings had no export row.
- RED hardening: one callback-install cleanup test and two mobile cache-cleanup assertions failed before their guards existed.
- RED 537A race: one parked-key test resolved stale secret bytes after the client generation changed.
- RED watchdog cleanup: a parked SDK export survived the lock watchdog without uninstalling its scoped callback; the outer identity-safe `finally` now removes it before the action rejects.
- RED interaction cleanup: the export row and acknowledgement emitted no haptics, and a thrown browser download click left its temporary anchor attached.
- RED dark-theme contrast: the new export page's account address inherited black text until the page supplied the established heading color token.
- RED completion semantics: the desktop path still claimed the account file was saved after only dispatching an anchor download, while the mobile path did not distinguish a completed share.
- GREEN completion semantics: desktop reports that the download started and mobile reports that the file was shared; neither path claims confirmed browser persistence.
- GREEN: 611 tests pass across 11 affected suites. TypeScript, full source ESLint, scoped Prettier, i18n lint, and dependency integrity pass.
- Full pre-translation coverage: 11,175 tests pass across 656 suites; statements 97.41%, branches 95.37%, functions 96.42%, and lines 97.41%. The sole expected failure is source/generated locale parity for the new English keys; the verified translation workflow generates and commits those bundles before every downstream coverage and build gate.
- Final production builds pass for Chrome, mobile, desktop, Android, and iOS. Targeted error scans are empty, and the Chrome manifest/zip, mobile and desktop bundles/WASM, Android APK, and iOS app executable/Info.plist all exist.
- Fresh routed light/dark visual checks pass at the supported 640 px fullpage width: the exact fund-access warning, acknowledgement, password step-up, disabled-to-enabled save transition, account identity contrast, and horizontal geometry are visible and correct.
- Final comment density: TypeScript 20%, TSX 10%, `miden-client.ts` 55%, `vault.ts` 30%, `actions.ts` 25%, `AdvancedSettings.tsx` 4%, `ExportAccountFile.tsx` 0%, and `Settings.tsx` 16%. New comments are limited to lifecycle rationale.
- Mobile share files are deleted from app cache in `finally`, including when the share fails.
- Remaining verification risk: the tests exercise the supported web-client `accounts.export()` API and byte-preserving save paths with doubles; a live wallet-to-CLI import round trip and native share sheet were not run in this worktree. After the translation commit, the exact remote branch tree still requires a fully green coverage rerun before merge.

---

# Bridge-IN e2e harness — REAL WalletConnect on iOS simulator

## ✅ PROVEN (both make-or-break unknowns resolved)
- [x] Real Miden receipt path on iOS (commit 5e8b5b4d5): CLI solver delivers real note ->
      real sync -> real Claim-All consume -> real takeAgglayerBridgeInInfo reconcile ->
      bridged-receive row -> received / "Bridged from EVM". GREEN on the sim.
- [x] Real WalletConnect handshake on iOS (commit 73b65a90d): connectUri native hook ->
      real wc: URI -> headless counterparty pairs over the PUBLIC relay -> session approved ->
      app reports connected {0xf39F..., chainId 11155111}. GREEN on the sim.
- [x] 403 diagnosed: RATE-LIMITING (not allowlist/attestation). com.miden.bread IS allowlisted
      for projectId b54ef53; spaced connections connect 6/6. NOTE: bursts (app+counterparty+
      reown reconnects on one IP) can trip it -> CI may need retry/spacing or a dedicated projectId.
      Measured before #1246: b54ef53 was the default project id then; #1246 retired it in favor
      of d18d112eb50cbe764f03e51a90210611, and this check has not been re-run on that id.

## Deposit half — ✅ GREEN on sim (AggLayer/ETH route, full real UI)
PASSED (testnet build + local Anvil, 1.6m): real wallet → real WC pairing → real UI deposit
(Receive → ETH → amount → Slow → review → Confirm) → REAL bridgeAsset signed by counterparty +
broadcast to Anvil (asserted: destNet 78, token 0x0, amount, value==amount, stub depositCount=1) →
real Anvil receipt → 'delivering' → CLI solver mints matching 1e12 note → real Claim-All consume →
reconcile → 'received' / "Bridged from EVM". Only doubles: Anvil chain + AggLayer bridge stub +
MockUsdc balance. Connect step is retry-guarded (relay rate-limit); needed a cooldown to pass.

Scope decision: full-UI deposit e2e targets the **AggLayer ETH (Slow)** route. It has a
proven receipt path + a single `bridgeAsset` call (one stub), vs Epoch/USDC which needs
The Compact + USDC ERC-20 + the allocator service + Epoch solver all doubled. Epoch = follow-up.
- [x] Anvil (chain 11155111) bring-up: `helpers/anvil.ts` (AnvilInstance start/stop); spec beforeAll/afterAll.
- [x] EVM read override: `config.ts` E2E-gated RPC → `E2E_EVM_RPC_URL` (Anvil); vite.mobile define added.
      Covers BOTH balance reads (`rpcRequest`) and `waitForSepoliaReceipt` (both read getChain().rpcUrl).
- [x] AggLayer bridge stub on Anvil: `MockAggLayerBridge.sol` (real bridgeAsset selector +
      `msg.value==amount` invariant → reverts on bad calldata) via `anvil_setCode`. `helpers/evm-doubles.ts`
      embeds runtime bytecode. Smoke-tested with cast: status 1, BridgeEvent emitted. NOT green-on-anything.
- [x] data-testids: `receive-cross-chain` (AddressTab), `bridge-token-{ETH,USDC}` (EvmBridgeTokenDrawer).
      (route/amount/review testids already existed.)
- [x] IosWalletPage nav: openBridgeDeposit / selectBridgeToken / enterBridgeAmount / selectBridgeRouteSlow /
      confirmBridgeDeposit / latestBridgeReceive (+ __TEST_LATEST_BRIDGE_RECEIVE__ hook — UI doesn't hand
      the txId to the DOM).
- [x] Full spec `bridge-in-deposit.ios.spec.ts`: create wallet -> solver faucet + setAgglayerSender ->
      real WC connect -> Receive/CrossChain/ETH/amount/Slow/review/Confirm -> assert real bridgeAsset
      broadcast (decoded: destNet 78, token 0x0, amount, value==amount, stub depositCount=1) ->
      row 'delivering' (real Anvil receipt) -> solver mints matching note -> Claim-All -> 'received'.
- [x] Typecheck clean (tsc --noEmit).
- [~] RUN on sim (testnet). Iterating through real bugs the harness surfaced:
      1. devnet on protocol 0.16 vs @miden-sdk 0.15.8 → create_wallet registration rejected.
         Fix: TESTNET (0.15-compatible). [env, not code]
      2. openBridgeDeposit race: cross-chain tap reads React `connected` before useNativeReown's
         on-mount getState() refresh lands → opens un-tappable native modal. Fix: /bridge/deposit
         route fallback (declarative, reactive). [helper]
      3. Deposit screen defaults to USDC, reads its balance on mount; no USDC contract on Anvil →
         eth_call "0x" → viem decodeFunctionResult throws → amount screen never renders. Fix:
         MockUsdc double at BRIDGEABLE_EVM_OUTPUT_TOKEN_ADDRESS (getBalance/balanceOf → 0). [double]
      4. In `isBridge` mode SelectAmount uses `bridgeSelector` (no testid), NOT the send
         `tokenSelector` — so send-token-selector never existed on the deposit form (Explore map
         was wrong). Fix: add send-token-selector to the bridge token button. [app source → rebuild]
      5. CurrencyInput decimalsLimit=6 → 0.00000005 truncates to 0; smallest ETH is 0.000001 →
         parseUnits(.,18)=1e12, but faucet max_supply was 1e12. Fix: createFaucet maxSupply param,
         1e15 for this test; deposit 0.000001 ETH → mint 1e12 note. [harness]
      Diagnosis was evidence-driven: DEBUG dump showed native connected the whole time + the exact
      "Cannot decode zero data" error + which screen rendered. Rebuild+run in progress.
      NOTE: bridge-in harness is HYBRID — local EVM (Anvil + stub + WC counterparty) + REAL Miden
      testnet (no local Miden node in mobile harness; same as every iOS spec + bridge-OUT). Only the
      WC relay is non-local (transport, not chain).
- [x] CI gate: `.github/workflows/e2e-bridge-in.yml` — post-merge on main (push + workflow_dispatch),
      macos-26-xlarge, installs Foundry, reuses the tuned sim-boot pattern from e2e-blockchain.yml,
      bakes E2E_EVM_RPC_URL, runs `bridge-in-deposit --retries=2`. Optional WC_COUNTERPARTY_PROJECT_ID
      secret to split relay load. COMMITTED + PUSHED (wiktor/bridge-in-e2e: d8ff8699c feature,
      f277263fa ci). Both SSH-signed.

## Epoch/USDC "Fast" route — HERMETIC DOUBLES (user chose the PR-gate path)
Investigation done: Epoch solver is hosted-only + watches REAL Sepolia (can't run vs Anvil), so a
gateable test must stub the allocator+solver. Reconcile is note-id-only (vs AggLayer sender+amount).
Wallet flow: quote (/checkIfDepositNeeded → gates Fast route) → executeEVMToMiden (solveIntent:
approve+depositERC20AndRegister on-chain + createAllocation) → row 'delivering' + registerPendingBridgeIn
by nonce → poll/consume reconcile matches midenNoteId from getIntentStatus.
Build plan:
- [x] epoch/client.ts E2E RPC override (SDK reads use chain default RPC, NOT config.ts override) —
      withE2eRpc() on both builders; EVM→Miden uses buildEpochWalletClient (confirmed via sdk.ts). tsc clean.
- [x] Fake allocator HTTP server (`fake-epoch-allocator.ts`, port 8548): /suggested-nonce, /checkIfDepositNeeded
      (resourceLockRequired:true + quote), /compact, /intentStatus (programmable midenNoteId; chainId as NUMBER).
      CORS for the WKWebView cross-origin fetch. Runs in the playwright node process.
- [x] Anvil doubles: MockUsdc extended (max allowance → SDK skips approve; approve/transferFrom/balanceOf) +
      MockCompact at 0x00..9788 (getForcedWithdrawalStatus→(0,0) Disabled; depositERC20AndRegister asserts
      token==USDC + transferFrom + counts). All 5 selectors verified vs SDK; cast smoke: deposit ok, wrong
      token reverts. Bytecode embedded in evm-doubles.ts.
- [x] Anvil `--block-time 1` for waitForTransactionReceipt confirmations:3.
- [x] Spec `bridge-in-deposit-epoch.ios.spec.ts` + selectBridgeRouteFast helper.
- [x] Extraction agent gave exact shapes; contracts + allocator built to them.
- [x] ✅ GREEN on sim (1.2m): real WC connect → real UI (USDC + Fast/Epoch) → Epoch SDK reads stubbed
      Compact/USDC on Anvil → real depositERC20AndRegister signed by counterparty + broadcast + receipt
      (confirmations:3 via --block-time 1) → createAllocation to fake allocator → 'delivering' → CLI mints
      note + programs allocator's intentStatus → Claim-All → note-id reconcile → 'received'/"Bridged from EVM".
      Asserted: deposit decoded (token=USDC, amount>0), stub depositCount=1, /compact called. One fix
      from evidence: /compact assert was racy (createAllocation runs AFTER the receipt wait) → made it a poll.
- [x] CI: extended e2e-bridge-in.yml — added EPOCH_ALLOCATOR_URL; the `bridge-in-deposit` filter runs BOTH
      deposit specs serially (workers:1), each with its own Anvil (+ Epoch's fake allocator).

## Both bridge-in deposit routes GREEN + committed + pushed. AggLayer (ETH/Slow) + Epoch (USDC/Fast).
Branch wiktor/bridge-in-e2e: d8ff8699c/f277263fa (agglayer feat+ci), e686dbe22/5178e8025 (epoch feat+ci).
CI e2e-bridge-in.yml runs BOTH deposit specs on main. AggLayer re-verified green vs the Epoch build (1.2m).

## Coverage matrix (2x2): bridge-OUT AggLayer is the ONLY uncovered quadrant
| dir | Epoch/Fast | AggLayer/Slow |
| IN  | ✅ new hermetic | ✅ new (Anvil stub) |
| OUT | ✅ existing (real testnet + hosted solver) | ❌ building now |

## Bridge-OUT AggLayer (Miden->EVM "Slow") e2e — IN PROGRESS
Flow: initiateB2AggBridge builds a B2AGG note (MIDEN_AGGLAYER_FAUCET_ID -> MIDEN_BRIDGE_ID, destNetwork 0 +
0x addr) -> proved+submitted on Miden as a bridged-send(agglayer) row; the AggLayer infra claims on EVM
(claimAsset), tracked via the indexer (AGGLAYER_BRIDGE_API). Complications: wallet must HOLD the real
AggLayer faucet token (test can't mint it → needs a faucet override like bridge-in), and the EVM claim
is external/~hours (not gateable) → hermetic doubling needed for the EVM leg.
Investigation (4-facet workflow) done. Decisive finding: the wallet's REAL work for bridge-OUT AggLayer
is the MIDEN leg only (build+prove+submit the B2AGG note → bridged-send row Completed/"Bridged to EVM").
The EVM claimAsset is signed by an EXTERNAL EVM wallet vs real AggLayer L1 infra — NO out-direction double
(midenToEvm.ts is empty) — so faking it = green-on-nothing (row is Completed before any EVM interaction).
Approach: assert the real Miden leg; leave the EVM claim uncovered. Chrome test (no EVM signing needed;
reuses the bridge-out-epoch harness; faster CI).
Two blockers solved via an E2E override (mirrors setAgglayerSenderForE2E): (1) faucet-id gate, (2) a
callback-flag vault-slot mismatch (B2AGG forces Enabled; CLI faucet mints Disabled → 0 balance).
- [x] Wallet-source (E2E-gated): b2agg/constant.ts getAgglayerFaucetId/setAgglayerFaucetForE2E/
      hasAgglayerFaucetOverride; b2agg/index.ts uses them + flips callback flag; SendManager+ReviewTransaction
      route gate uses getAgglayerFaucetId(); store/index.ts installs __TEST_SET_AGGLAYER_FAUCET__ (front hook).
- [x] Chrome harness: bridge.ts bridgeOutSlow (+ faucet-override set after page load, before route gate;
      toBeEnabled guard on bridge-route-slow) + readBridgedSendRows extended (provider/claimStatus/
      outputNoteIds/transactionId).
- [x] Spec bridge-out-agglayer.spec.ts: fund AGG → bridgeOutSlow → assert agglayer row Completed/"Bridged
      to EVM" + 1 output note + real tx id + provider=agglayer (not epoch fallback) + claimStatus pending.
      EVM claim deliberately NOT asserted (external, no double). tsc clean.
- [x] ✅ GREEN on Chrome/testnet (1.4m), FIRST real attempt. Real Send UI (0x recipient → Sepolia →
      AGG token → amount → Slow route → submit) → real B2AGG note create+prove(delegated)+submit →
      bridged-send(agglayer) row Completed/"Bridged to EVM", 1 output note, real tx id, provider=agglayer
      (not epoch fallback), claimStatus pending. The #1 risk (B2AGG note with a Disabled-flag test faucet)
      is RESOLVED — the callback-flag flip works.
- [x] CI: e2e-bridge.yml runs ALL tests/bridge specs (no filter) → auto-covers bridge-out-agglayer.
      Updated the gate header to document both routes. No new job needed.

## 🎉 FULL 2x2 MATRIX COVERED
| dir | Epoch/Fast | AggLayer/Slow |
| IN  | ✅ hermetic (fake allocator + Anvil doubles) | ✅ Anvil bridge stub |
| OUT | ✅ real testnet + hosted solver | ✅ real Miden leg (EVM claim external, uncovered by design) |
Gates: e2e-bridge-in.yml (IN, iOS) + e2e-bridge.yml (OUT, Chrome), both post-merge on main.

## Findings to report to the team
- WALLETCONNECT_PROJECT_ID is NOT set anywhere (repo/CI/release) -> builds fall back to
  DEFAULT_WC_PROJECT_ID in src/lib/walletconnect/config.ts. Fragile: any build not manually
  setting it ships the fallback. Verify the release process sets it.
- Relay rate-limits bursts of connections on the same projectId/IP (intermittent 403).

# Issue #646 - spending limits

- [x] Record approved product decisions and inspect every outgoing initiation path.
- [x] Write the implementation design and security invariants.
- [x] Obtain design approval, then write the TDD implementation plan.
- [x] Implement the data model, atomic policy, and one-time authorization.
- [x] Implement validated configuration reads, writes, revision checks, and all runtime transports.
- [x] Implement strict authentication and Security settings UI.
- [x] Integrate send, swap, bridge, Earn, and dApp flows.
- [ ] Run full local gates, Review Council, and fix every actionable finding.
- [ ] Push a PR with Closes #646, babysit CI, admin squash merge, and verify closure.

## Review

- Task 1: Dexie 1.7 schema, compound account-and-faucet key, authorization index, and strict bigint-safe codec. 60 focused tests green.
- Task 2: rolling 24-hour and 7-day assessment with conservative outgoing history and typed fail-closed errors. 79 focused tests green.
- Task 3: atomic policy recheck, exact one-time two-minute authorization, replay rejection, and all four outgoing initiation routes. 184 focused tests green; TypeScript and scoped lint green.
- Task 4: validated account-scoped configuration, strict weakening classification, revision conflicts, coherent save-versus-queue serialization, bigint-safe transport, and extension/mobile/desktop/store routing. 408 focused tests green; TypeScript and scoped lint green.
- Task 5: fail-closed strict authentication with hardware, passcode, and password paths; verify-only vault access; extension/mobile/desktop transport; stale-result suppression; localized retry UI. 520 focused tests green; TypeScript and scoped lint green.
- Task 6: account-scoped Security settings route, held and configured-zero-balance assets, exact base-unit conversion, unknown-scale guard, strict edit classification, stale-account suppression, and 14 localized bundles with 0 stale keys. 164 focused tests green; TypeScript, scoped lint, i18n lint, and locale parity green.
- Task 7: structured send and swap preflight challenges, exact one-time authorization threading, draft-preserving cancellation, and race or expiry re-challenge. 530 affected tests green; new spending-limit modules clear the 95% gate at 99.73% statements, 97.29% branches, 100% functions, and 99.73% lines.
- Task 8: Agglayer, Epoch bridge, and Earn preflight before external work; exact authorization threading through SDK callbacks; structured final-race re-challenge; cancellation and below-limit regression coverage. 110 focused tests, TypeScript, and scoped lint green.
- Task 9: extension, mobile, and desktop dApp preflight; wallet-owned strict authorization; disconnect and account-switch revalidation; one-shot modal handoff; structured race retry; generalized-send parity. 726 tests across all 37 dApp and confirmation suites, TypeScript, and scoped lint green.
- Task 10: real testnet iOS and Chrome E2E coverage for settings, over-limit
  authentication, dApp sends, and atomic concurrent sends. Fresh iOS screenshots
  verify native per-asset daily and weekly settings plus amount-over, reset, and
  raise-in-Settings messaging. The iOS run passed with retries disabled in 4.2
  minutes using the stable 0.16 CLI required by the current testnet node.
- Task 11: canonical spending-limit identities now bind bare, routed, bech32, and
  hex account or faucet references to one policy and one history. Five regression
  assertions failed before the fix; 126 focused policy, settings, and identity
  tests pass after it, with TypeScript and scoped formatting green.
- Remaining: full gates, Review Council, and delivery.

# Issue #497 - unified store listings

- [x] Inspect the three live listings and current checked-in store assets.
- [x] Record the approved shared-core and platform-tailored design.
- [x] Obtain design approval, then write the implementation plan.
- [x] Build canonical copy, deterministic captures, compositor, and validators.
- [x] Run visual verification against fresh generated montages and native mobile screenshots.
- [ ] Run Review Council, then fix every actionable finding.
- [ ] Push a PR with the publication checklist and babysit CI to green.
- [ ] Admin squash merge, publish all three listings, verify them publicly, and close #497.

## Review

- The capture plan writes 20 raw product images from deterministic testnet fixtures and current iOS,
  Android, extension, confirmation-window, and side-panel surfaces.
- Two complete retries-disabled capture passes produced byte-identical hashes for all 20 raw PNGs;
  two compositor passes produced byte-identical hashes for all 23 upload assets.
- The compositor writes 23 assets: 6 App Store, 9 Google Play, and 8 Chrome Web Store files. The
  validator confirms counts, order, copy limits, dimensions, opacity, alt text, and the approved
  Chrome five-screenshot mapping.
- Fresh montages capped at 1800 pixels show the shared orange visual system without clipping,
  tooltip residue, personal data, stale platform wording, or unsupported claims.
- Fresh iPhone simulator and Android emulator screenshots match every mobile scene's product
  layout, routes, controls, operator roster, and platform wording. All configured public Guardian
  endpoints returned HTTP 200 on 2026-09-16; the capture fixture keeps that reachable state
  deterministic instead of recording transient sync or probe placeholders.
- Review Council, repository-wide gates, PR CI, authorized publication, and public verification are
  still pending.

# Issue #1294 - private-note relay outbox

- [x] Create an isolated worktree from the fetched origin/main.
- [x] Trace delivery sweep, initial relay, SDK outbox, and sync retry behavior.
- [x] Reproduce duplicate retries and existing-outbox recovery in regression tests.
- [x] Implement a bounded, durable fix that preserves private-note recovery.
- [x] Run affected tests, TypeScript, coverage and build checks.
- [x] Apply every actionable finding from the independent advisory check.
- [x] Complete the required four-seat review.

## Review for #1294

- Base: origin/main at 607c4c025.
- Scope: private-note relay retries; preserve the nullifier as the only delivery confirmation.
- Do not attribute the stress-run claim timeout solely to relay retries without a controlled run.
- Regression: 12 real SDK fetch-boundary assertions and 3 sweep assertions failed before their fixes.
- Deployed transport (0.5.0-rc.2, probed 2026-10-01): a duplicate SendNote is a headers-only
  `grpc-status: 13` with `Failed to store note: ConstraintViolation("Unique constraint violation:
  UNIQUE constraint failed: notes.id")`. The helper recognises it from the headers alone.
- Real browser WASM, committed as `playwright/tests/note-relay-outbox.spec.ts` (hermetic, one recorded
  RPC): that duplicate retires the 232-byte outbox entry and the next sync sends nothing; a genuine
  storage failure stays in the outbox and is sent again.
- 607 affected tests pass, including 93 transport tests. The canonical helper has 100% statements,
  branches, functions and lines. Types, scoped lint, formatting, generated-patch verification,
  dependency integrity, changelog and Chrome/mobile builds pass.
- All 843 suites and 17,702 tests pass across the three CI coverage shards. Merged coverage clears
  the 95% gate: statements and lines 98.13%, branches 96.01%, functions 97.26%.
- The local unsharded attempt exhausted the parent process's default heap. The successful shards
  used two workers, a 768 MB worker recycle limit and an 8 GB Node heap; source gates are unchanged.
- Four-seat review: 22 findings fixed across 10 commits, 2 rejected with evidence, 1 deferred by
  decision (relay log lines carry no note identity), 2 P3s left. The helper reads headers only, so the
  earlier trailer-parser rules are gone; `check:deps` now verifies the relay patch on every build.
# Faucet funding follow-up after v1.17.1

- [x] Reproduce the reported testnet target and trace the server's amount-scaled difficulty.
- [x] Confirm the user-approved grant: use each faucet's advertised `base_amount`.
- [x] Add failing tests for metadata-selected grants, invalid metadata, cancellation and worker isolation.
- [x] Fetch and validate the grant before requesting PoW; retain one amount through submission.
- [x] Move nonce hashing into a bundled worker with abort, deadline and cleanup handling.
- [x] Verify 222 focused tests across six suites and types locally; do not run coverage or browsers locally.
- [x] Complete medium internal review; neither review found P0/P1 issues.
- [x] Reproduce and correct the Windows patch-check failure with genuine stale-code refusal controls.
- [ ] Open and admin squash-merge the follow-up PR without waiting for CI, as explicitly requested.
- [ ] Re-cut the withdrawn v1.17.1 from new next without a next CI wait, then promote next to main.
- [ ] Verify the new release packages and report any CI failures separately.

## Evidence

Testnet advertises `base_amount=10000`, decimals 6 and load difficulty 65536. The historical
100000000-unit grant produces target 28144683202 exactly. A live base-grant challenge solved
with the unmodified wallet solver in 1591 ms and passed an independent SHA-256 check; no mint
was submitted. Devnet advertises a 100000000-unit base grant. Funding state disables only its
card action; the nonce search currently executes in the UI realm.

# Live Testnet Guardian faucet consumption

- [x] Reproduce the actual Fund your wallet flow in a fresh isolated Guardian profile.
- [x] Match the missing digest to the canonical V2 receive-policy callback.
- [x] Test a compatible browser SDK against the same pending faucet note.
- [x] Verify fresh-wallet automatic consumption, committed transaction and net vault credit.
- [x] Capture screenshots and source-bound evidence; review the focused change internally.
- [x] Build and verify a production Testnet Chrome package with the proven fix.

Focused live browser verification is explicitly requested. Full coverage and broad suites remain in CI.

# Public faucet regression on both public networks

- [x] Prove fresh Testnet Guardian funding with exactly Web SDK 0.17.1 and Guardian 0.18.0.
- [x] Add the real Fund UI scenario to Testnet and Devnet branch E2E gates.
- [x] Require committed local note consumption and exact net native vault credit.
- [x] Verify the same previously failed note consumes after the exact SDK upgrade.
- [x] Replace the diagnostic SDK archive with official registry 0.17.1 and rerun both network flows.
- [ ] Complete medium internal review, admin squash merge and full v1.17.1 re-cut.

## Current public funding verification

- Existing Guardian onboarding passed on Testnet and Devnet with fast Web SDK 0.17.1 from the signed release source and stable Guardian 0.18.0.
- Testnet consumed 10000 base units, paid 133 and retained 9867. Devnet consumed 100000000, paid 133 and retained 99999867.
- Medium internal review found no P0/P1 issues in the UI funding assertions, CI branch gates, profile ownership or CLI kernel preparation.
- iOS device/simulator and Android arm64/x86_64 committed prover binaries were rebuilt against the exact SDK 0.17.1 kernel.
- Coverage and broad browser suites remain in CI; the authorized same-version replacement does not wait for PR or next CI.

Official registry SDK 0.17.1 is installed with its published integrity and exact native optional dependencies. Both existing onboarding tests passed again: Testnet 32.9 s and Devnet 24.7 s, no retries, actual Fund UI and chain-confirmed consumption. Clean frozen installation, six-bundle relay verification, 83 relay tests, 32 CLI/faucet tests, five CLI pin tests, typecheck and native kernel pin check pass. Exact Rust CLI source preparation also compiles successfully.

## Public faucet queue timing in CI

- [x] Compare the failing next E2E run with its last successful runs.
- [x] Verify exact execution dependencies and compare grant inclusion time with the failure time.
- [x] Track the accepted public faucet note through bounded chain commitment before fixture consumption.
- [x] Add focused delayed-commit and timeout regressions; run lint and type checks.
- [ ] Complete medium internal review and merge the CI fix through a PR.
- [ ] Verify the affected public-network CI jobs and retain the verified v1.17.1 release assets.
- [ ] Reconcile ancestry and atomically fast-forward main and next with the original PR-only policy restored.

Review: both failed native grants committed after their fixture deadlines; CLI 0.17.1 consumed another grant successfully in the same run. The release packages remain sourced from the reviewed funding fix. All 50 focused tests pass, with types, scoped lint and formatting clean. Internal re-review confirmed the existing funding-source regression was repaired and found no remaining P0/P1 issues.

# Hosted Android virtualization workaround

## Plan

- [x] Resolve the failed run from its Playwright and emulator-log artifacts; confirm whether any Testnet loop started.
- [x] Move the workflow to an Intel macOS runner with a matching x86_64 Android image and native visible emulator window.
- [x] Fail early if the runner does not expose usable Hypervisor.framework acceleration; force accelerated emulator launch.
- [x] Run focused helper tests, scoped lint, workflow lint, exact Playwright collection, and get an independent review.
- [x] Publish only to the Android feature branch, preserving `main` and existing unrelated work.
- [x] Reconcile the terminal run artifacts; the user's standing authorization now covers automatic retries through successful completion.

## Findings

- Run `38057296756` produced `expected=0` Playwright tests and failed during global setup because the Apple Silicon macOS larger runner reported `HV_UNSUPPORTED`. No bridge deposit, faucet funding, or Miden transaction was started.
- GitHub documents nested virtualization as unsupported on macOS larger runners. The selected workaround matches an x86_64 AVD to an Intel macOS runner, which has native Hypervisor.framework support in GitHub's standard runner issue history.

## Review/results

- Emulator-control tests pass (15/15); scoped ESLint, actionlint, and `git diff --check` pass. Actionlint required ignoring its stale local runner-label list for the currently documented `macos-26-intel` label.
- Playwright collects exactly one AggLayer bridge-in test configured for 100 sequential loops.
- Independent review found and the workflow now fixes the cross-OS Rust cache-key collision; it found no remaining source-level blocker.
- Recovery commit `a98f77607` was pushed to `codex/android-agglayer-bridge-recovery-20261010`; `main` remains at `89c93124`.
- The selected hosted runner's live Hypervisor.framework availability and terminal 100-loop result remain unverified until a fresh live run is authorized.

# Recover Android Bridge-IN CLI build timeout

## Plan

- [x] Confirm run `38059563408` failed in the pre-install CLI step before APK build or any bridge loop; preserve the dirty `main` worktree.
- [x] Fetch the current `origin/main` and isolate changes in the clean Android recovery worktree.
- [x] Replay current `origin/main` into the feature branch without changing `main`.
- [x] Make CLI compilation bounded and process-tree-aware; retain cargo artifacts across failed builds and preserve the primary failure if cleanup also fails.
- [x] Give the cold CLI build its own job budget while keeping the Android 100-loop job's full 360-minute budget.
- [x] Add focused installer regressions, verify the workflow and scoped diff, and complete an independent code review.
- [x] Push the fix only to the feature branch; after confirming run `38059563408` was terminal failure, dispatch one fresh 100-loop Android run.
- [x] Monitor run `38091647355` to terminal status and reconcile its loop, receipt, and balance evidence.

## Review/results

- Focused installer regressions pass (11/11); Node syntax checks, workflow `actionlint` with the known custom runner labels ignored, both YAML parses, and `git diff --check` pass.
- Independent review confirmed that Cargo target artifacts are cached only after a successful build or confirmed process-tree stop, and that the verified CLI cache remains behind the success gate.
- The Android workflow dispatch must include `-f platform=android`; the existing manual default remains iOS.
- Pushed commit `5c18aeddc` to the recovery branch; run `38091647355` started on SHA `5c18aeddce1985c6a2480c90df5ab47ce45923ec` after confirming the earlier run was completed with failure.
- The formerly failing cold CLI build completed successfully in 32m20s; the verified CLI cache restored in Android, acceleration/AVD and APK build passed.
- Run `38091647355` failed in Android global setup after 19m53s: Playwright reported `expected=0`, with no suite/test started. Its exact emulator log says the host had fewer than six logical cores, reduced the guest to one vCPU, and then QEMU's main/CPU threads stopped responding; `adb devices` showed no device. No bridge loop or Testnet transaction ran.

## Repair Android emulator boot on the Intel runner

- [x] Download and inspect only run `38091647355`'s Playwright summary, emulator log, and failure diagnostics.
- [x] Identify the resource mismatch: the standard Intel runner passed `-accel-check` but did not provide enough host CPU for the AVD to boot.
- [x] Move only the Android workload to the 12-core Intel macOS larger runner and fail early if fewer than six logical CPUs are exposed.
- [x] Run scoped workflow validation and obtain a fresh independent review.
- [x] Push the reviewed repair only to the feature branch.
- [x] Record that the user's standing authorization covers automatic retries through successful completion.

## Emulator repair review/results

- GitHub's official runner reference lists `macos-26-intel` at 4 CPUs/14 GB and the Intel `macos-26-large` runner at 12 CPUs/30 GB. The workflow now uses the latter and checks the emulator's observed six-core minimum before downloading SDK packages.
- The already-completed CLI fix, cache handoff, Hypervisor check, AVD creation, and APK build all passed in run `38091647355`; only emulator boot failed before Playwright collected a test.
- Actionlint (ignoring the local label list for documented custom GitHub runners), workflow YAML parsing, and `git diff --check` pass. Independent staff-engineer review found no blocker; the hosted emulator boot still needs confirmation in a fresh run.
- Repair commit `69dfaa2d153553c9982364b185626b905b6dca84` is pushed; `git ls-remote` confirms the recovery branch points to that exact commit. Remote `main` was not part of the push.

# Start Android Bridge-IN loops without cold build gates

## Plan

- [x] Inspect exact run `38104475519`, cancel it after explicit user approval, and verify that no Android E2E test started.
- [x] Read the CLI job logs and identify the missing reusable cache; the cold CLI compile took 24m29s before the Android job began.
- [x] Add an `android-prepare` mode to the already-registered bridge workflow so the feature branch can build exact-SHA inputs without changing `main`.
- [x] Build CLI/APK in parallel during preparation; warm exact dependencies and only the missing Android API 34 system image; bind artifacts to run, ref, SHA, build flags, and checksums.
- [x] Remove dependency installation, CLI/APK builds, and Android SDK image downloads from the live path; fail closed on missing prepared inputs.
- [x] Start the visible emulator before Playwright setup; overlap CLI initialization, wallet creation, fee discovery, and early WalletConnect.
- [x] Let the first EVM deposit begin while recipient fee grants are prepared; wait for grants before solver delivery, and avoid Testnet funding if WalletConnect fails.
- [x] Enforce the five-minute deadline from workflow `created_at`, fail early when runner queue time has already consumed it, and report dispatch-to-loop plus Android-job-to-loop.
- [x] Bound and check each expensive live setup stage against the same dispatch deadline; validate the exact-SHA artifact before checkout and cache restoration.
- [x] Run static workflow/script validation, inspect the full diff, and record independent review findings.
- [x] Obtain final independent re-review of the process cleanup, asynchronous fee-funding order, and zero-loop exit behavior.
- [x] Independently re-review the SDK PATH fix, explicit cache-save points, and exact-SHA artifact checks; no actionable findings.
- [x] Independently confirm setup-android v3 accepts SDK licenses and removal of the broken-pipe pipeline preserves fail-closed image installation; no findings.
- [x] Publish only to the recovery branch and dispatch `android-prepare` for the reviewed commit; record the first prep run's SDK preflight failure.
- [x] Fix the runner SDK PATH assumption; split cache restore/save so a later prep-stage failure cannot discard already-verified dependency and image caches; rerun static workflow validation.
- [x] Diagnose the next prep failure: image unpacking succeeded, but the redundant license pipeline failed under `pipefail`; remove it because `setup-android` accepts SDK licenses.
- [x] Publish the correction only to the recovery branch and dispatch one preparation-only run against its exact SHA; verify CLI, APK, and packaged manifest artifacts.
- [x] Obtain fresh authorization and dispatch one live 100-loop Testnet run against the prepared SHA; inspect its exact failure logs.

## Evidence

- Run `38104475519` was cancelled at the user's request. The CLI job completed successfully after 24m29s; Android capacity check, Hypervisor check, and AVD creation passed. Dependency install was cancelled, so no APK build, Playwright test, bridge loop, or Testnet transaction started.
- Both the verified CLI cache and resumable Cargo-target cache were missing at the beginning of the run. The 736 MB Cargo cache and 13 MB CLI cache were written only after the cold compile, so GitHub cache availability cannot be assumed for a five-minute start target.
- The preceding Android job spent 4m07s installing dependencies and 8m01s building the APK before Playwright could begin; both builds must move ahead of the live dispatch to satisfy the requested start latency.
- The five-minute clock now starts at workflow `created_at`, so runner queue time counts. A job that reaches its first step after the deadline fails immediately; setup stages check the same deadline, and the Playwright watchdog terminates its process group if loop 1 has not entered by the deadline. WalletConnect starts after onboarding while CLI/Testnet preparation continues. Recipient fee funding starts only after WalletConnect succeeds and overlaps the first EVM deposit; it must finish before Miden delivery. The always-run finalizer records startup failure when an earlier setup step bypasses the watchdog.
- The first-loop marker records entry into loop 1 before the first deposit UI action; it does not claim that a deposit has been submitted. The Android cache includes the API 34 system image and explicitly pinned emulator; platform tools, API 36 and build tools come from the verified hosted runner image.
- Preparation run `38111623729` used commit `85d2f20e64372f4c5edd6eff9d2b96af536f409e`: CLI preparation passed and uploaded its artifact in 31 seconds; the Android dependency install and integrity check passed in 3m49s. SDK preflight then failed immediately because `sdkmanager` was not on `PATH`; no APK artifact, loop, or Testnet transaction was produced. Both live workload jobs were skipped.
- Preparation run `38112184176` used commit `c0e973cbf0b063791b04e8dad8904819ae005a25`: CLI preparation passed in 29 seconds; SDK setup and package checks passed; the verified dependency cache was saved. The API 34 image downloaded and unpacked, then `yes | sdkmanager --licenses` failed because the SDK manager exited before `yes`, causing a broken pipe under `pipefail`; the API image cache and APK were not saved, and both workload jobs were skipped.
- The corrected prep path runs `android-actions/setup-android@v3` to expose the hosted SDK tools and accept licenses, then saves verified dependency and API 34 image caches in explicit steps before later build stages. It no longer runs a redundant license pipeline.
- Preparation run `38112626286` used commit `5cfe2a414b88532bf5ee0d493f733a0cabd262f9` and succeeded. The pinned CLI built and uploaded in 31 seconds; dependency cache verification passed; API 34 image install, verification, and cache save passed; APK build completed in 5m54s; the exact-SHA CLI/APK manifest bound and uploaded successfully. The Android Testnet and iOS jobs were skipped.
- Live run `38113670228` used the same exact SHA. Dispatch-to-Android-job start was 5 seconds. Dependency cache restore took 1m21s; prepared CLI/APK download and verification took 11 seconds; Android image restore took 37 seconds. It failed at 2m31s in `Verify restored Android SDK packages`, specifically `command -v sdkmanager`; no emulator, Playwright test, bridge loop, or Testnet transaction started. The prep job's `setup-android` PATH mutation is runner-local and did not reach this live job.

## Review/results

- `actionlint` and `git diff --check` pass after the prep correction. Earlier workflow YAML parsing, `bash -n` for all workflow run blocks, and `node --check` for the watchdog and embedded Node/GitHub Script blocks passed; scoped ESLint was unavailable because this checkout has no local dependency installation. No repository tests were run; live run `38113670228` failed before Playwright and started zero loops.
- Independent review findings for exact-repository artifact selection, bounded setup, cancellation forwarding, missing startup reports, Testnet fee side effects, and zero-loop success have been addressed. Final read-only re-review found no remaining P0/P1/P2 issues.
- The first two `android-prepare` runs failed before APK build; their artifacts cannot satisfy the next commit's exact-SHA manifest. The latest preparation run succeeded and produced an exact-SHA artifact; its Android Testnet and iOS jobs were skipped.
- The first live run on the prepared SHA failed before emulator startup because the fresh live runner lacked `sdkmanager` on `PATH`. Its startup artifact records zero loops. The cache key previously hashed the entire workflow; the current fix makes preparation restore/save, provenance, manifest verification, and live restore use one package-specific OS/architecture key.

## Repair live Android SDK PATH and keep image cache stable

### Plan

- [x] Inspect exact run `38113670228`'s failed step log and prove the failure occurred before emulator or Playwright startup.
- [x] Confirm `setup-android` ran only in the separate prep job and its PATH update cannot configure the live job's fresh runner.
- [x] Add job-local Android SDK PATH setup before live SDK verification and change the image cache key to encode OS, architecture, and the API 34 image package.
- [x] Run workflow lint and diff checks.
- [x] Address and re-review the cache-key mismatch caught during focused independent review; final review found no remaining findings.
- [x] Push the reviewed correction only to the recovery branch.
- [x] Record the user's standing authorization to prepare, dispatch, repair, and automatically retry failed attempts until a live 100-loop Testnet run succeeds.

### Evidence

- Run `38113670228` reached `Verify restored Android SDK packages` at `2026-10-11T05:08:04Z`; the first `command -v sdkmanager` exited 1. The finalizer and diagnostic artifact uploads completed, and Playwright was skipped.
- Its dependency and Android image caches restored successfully, but the API image key depended on the entire workflow file. An unrelated startup-path edit would otherwise invalidate that cache.
- Independent review confirmed SDK setup ordering and prep fallback-cache behavior, and caught one missed workflow-hash key in the live restore; the live key now matches prep and manifest, and final re-review found no remaining findings.
- Reviewed fix `30b7e888e1193c02a3b043ae0fc41038e1506841` is pushed to the recovery branch. `actionlint`, the diff whitespace check, and the cache-key consistency check pass; the independent re-review found no remaining findings.

## Repair Android eval-based emulator log root

### Plan

- [x] Inspect run `38115187911`'s exact job log and confirm no emulator boot or E2E loop began.
- [x] Trace the `/Users/test-results-android/emulator-logs` path to `__dirname` from the `node -e`/ts-node startup loader.
- [x] Use `GITHUB_WORKSPACE` as the Android helper's CI checkout root while retaining the module-relative local fallback.
- [x] Validate CI/local root selection, run `actionlint` and `git diff --check`, and obtain independent review with no findings.
- [x] Commit and push the reviewed repair to the recovery branch, then prepare its exact-SHA inputs.
- [ ] Dispatch and automatically diagnose/retry failed Android Testnet runs until one records terminal success for all 100 loops.

### Evidence

- Run `38115187911` used reviewed SHA `30b7e888e1193c02a3b043ae0fc41038e1506841`. SDK setup, image restore, acceleration, and AVD creation passed; startup failed at `Start visible emulator boot before Playwright setup` with `EACCES` creating `/Users/test-results-android/emulator-logs`. Playwright, emulator launch, loops, and Testnet transactions did not start.
- The workflow invokes `EmulatorControl.startSingle()` through `node -r ts-node/register -e`. In that eval module, `__dirname` refers to the repository-root working directory. Ascending four directories resolves to `/Users`, while GitHub Actions supplies the exact checkout root as `GITHUB_WORKSPACE`.
- Fix commit `f7cfbfce948e5fe6b6d0fcb8c18c8c197b3e2327` was pushed through the connected GitHub API after shell DNS failed; its tree matches the locally reviewed commit. Preparation run `38115771138` succeeded and uploaded exact-SHA CLI, APK, and combined provenance artifacts.
- Live run `38116228586` used `f7cfbfce948e5fe6b6d0fcb8c18c8c197b3e2327`. The path fix worked: emulator logs were written under the checkout and uploaded. The job then failed before Playwright because the visible emulator did not become available to adb within 45 seconds; the startup report records `firstLoopStarted=false` at 181 seconds after dispatch. No loop or Testnet transaction started.

### Review/results

- The exact root-selection expression resolves `GITHUB_WORKSPACE` to `/Users/runner/work/wallet/wallet` for the eval startup context and preserves the helper-relative `/repo` fallback for local use. `actionlint` and `git diff --check` pass. Local `node_modules` is absent, so no repository Jest/TypeScript checks were available in this checkout.
- Independent review confirms the fix points emulator logs under `test-results-android/emulator-logs`, matching the workflow artifact upload path; no blocker found. Hosted runtime verification confirmed the path fix.
- The user's standing authorization covers exact-SHA preparation and automatic retries through one successful 100-loop run.

## Pin the Android emulator runtime across prep and live runners

### Plan

- [x] Inspect run `38116228586`'s exact emulator log and startup report; confirm zero loops and zero Testnet transactions.
- [x] Compare the failing runner's emulator version with the previously used workflow-installed version and current Android stable release.
- [x] Install, cache, version-check, and provenance-bind the same Android emulator package in preparation and live jobs.
- [x] Replace the unversioned emulator SDK Manager install with the official pinned archive, SHA-256 verification, and build-specific cache/provenance identity after independent review caught the drift risk.
- [x] Run `actionlint`, `git diff --check`, exact cache/provenance key checks, and the namespaced package.xml revision smoke check; independent re-review found no blockers.
- [ ] Push the repair, prepare its exact SHA, and retry Android Testnet automatically until all 100 loops succeed.

### Evidence

- Run `38116228586` used the corrected log-root code and reached emulator startup 132 seconds after dispatch. Emulator `37.1.11.0` started but QEMU's main loop and CPU threads stopped responding; ADB never saw the device. The report records no first loop at 181 seconds after dispatch.
- The earlier Android workflow explicitly installed the `emulator` SDK package and logged version `37.2.12.0`; the new prep/live workflow had relied on the host image, which supplied `37.1.11.0`. The first pin checked for `37.2.12` after asking SDK Manager for latest; independent review identified that the command would not install the pinned release after an upstream update. The current path downloads archive build `16428233`, checks SHA-256 `9fdae8c07ac92155aeb175835669ef9b12adf19130f5557792139fb4ebd01256`, updates the package revision, and binds that archive to the cache and exact-SHA provenance.

### Review/results

- `actionlint`, `git diff --check`, exact cache/provenance checks, and the namespaced package.xml revision smoke check pass. Independent re-review found no blockers in the archive checksum, package revision, cache marker, exact prep/live key, or artifact provenance. Hosted runtime verification must prove that the pinned release resolves QEMU startup.
