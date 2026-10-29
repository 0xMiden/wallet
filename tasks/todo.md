# Follow-up to #1790: describe wallet-file contents accurately

## Plan

- [x] Verify wallet-file export and restore behavior against the current implementation and #1617's accepted choice.
- [x] Align the Terms, Privacy Policy, and Support FAQ with conditional phrase inclusion, imported-account secrets, and operator state-loss recovery.
- [x] Add the changelog entry without changing the Terms version or effective date.
- [x] Inspect the final diff and run the applicable lightweight documentation checks.
- [ ] Review the open PR with Review Council 0.7.8; replace incomplete Luna proof with Sol, then fix actionable P0-P2 findings.
- [ ] Push the final reviewed head, watch its CI, and merge only after the wallet PR gate passes.

## Review

- `git diff --check` passed through `ci-local run`; wallet-file claims were cross-checked against the current exporter/parser and existing backup tests.
- Prettier passes for the edited Privacy Policy paragraph. The Terms, Support FAQ, changelog, and task plan also fail on the unmodified `origin/main` baselines, so I left their existing Markdown formatting intact.
- Review Council and current-head CI: pending.

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

## Native mobile companion 2026-10-13

- [x] Record failing geometry and lifecycle regressions.
- [x] Implement optional geometry and covered native foreground ownership.
- [x] Remove redundant entry hint, document contract and add unreleased changelog.
- [x] Minimize through the standard app path, retain the document and fence deferred snapshot/hide ownership.
- [x] Run 429 focused noncoverage tests, typecheck, targeted lint and the pinned mobile build.
- [x] Complete current-main native gates: 31 iOS passes plus one recorder skip, and 90 Android passes.
- [x] Complete integrated simulator geometry/minimize acceptance through the production Provider.
- [x] Correct generic plugin privacy image ownership with actual-plugin RED-to-GREEN controls and ten fallback cases.
- [x] Verify all 2,688 source frames and every transition of three real full-app OS resumes after the plugin correction.

Review: focused native review has no actionable source finding. First real OS recording exposed the host in 8 of 529 source frames; retaining covered snapshot ownership removes that exposure in all 425 source frames of the second recording. Coverage remains CI-only with every threshold unchanged at 95%. Final integrated acceptance passes in the production Provider: same-document minimize/restore, shared native/game headers and three real OS resumes without Explore or the white Bread privacy image. Publication belongs to the companion PR.

## Wallet #1586 Android Auth Tab emulator acceptance

- [x] Read the current PR, Auth Tab spec, CI workflow contract, lessons and decision profile; preserve the implemented production behavior.
- [x] Add a focused, manually dispatched CI acceptance lane using one API 34 Google Play emulator and actual Chrome.
- [x] Serve the auth dApp and redirect fixture from the local emulator host over HTTPS with a test CA limited to the debug fixture host.
- [x] Exercise Chrome Auth Tab success and cancellation, then a real unsupported Custom Tabs provider through the existing fallback.
- [x] Fix workflow-lint findings from the first current-head CI run.
- [ ] Run the full Auth Tab acceptance inside the bounded Android runner and preserve failure evidence.
- Mutation predictions for the workflow harness checks: changing the emulator action, Play Store target, boot timeout, job timeout, preparation order, or script path must fail the runner contract test; removing PIN setup or the Playwright invocation from the script, or restoring `adb wait-for-device`, must fail that same test; removing Gradle shutdown or moving Playwright before the Firefox probe must fail the ordering test; adding ADB logcat to post-step evidence, removing its timeout, or removing the script's timed EXIT evidence must fail the evidence-bound test.
- [x] RED: push regression tests in commit `63a6270`; CI confirms both TLS bypass assertions and the recreated-Activity pending-result assertion fail, with CodeQL flagging disabled certificate validation.
- [x] Merge the latest `origin/main` after the frozen red run, then update the workflow harness tests for the main-only Guardian push and the Auth Tab dispatch job's 90-minute timeout and Play Store image.
- [x] GREEN: enforce TLS verification and clear abandoned restored Activity results before a new Auth Tab request can register.
- [x] Run the two named workflow harness suites through the guarded local route (39 tests) and the TLS fixture suite (4 tests); Android verification remains CI-only.
- [ ] Record exact CI source SHA, emulator image, browser package versions, queried Auth Tab capability and nonzero executed test count.
- [ ] Run source review and current-head CI, fix all actionable findings, then update PR #1621 and complete its authorized merge gates.

## Wallet #1586 acceptance plan review

The single-emulator lane avoids the known GMS contention of the existing two-emulator jobs. Chrome proves the result-channel path; Firefox is selected as the default Custom Tabs provider for the unsupported path. Both browsers must be queried on-device and the suite must fail if either browser is missing or reports an unexpected capability. The local fixture uses a synthetic login handle and never logs callback data. The test CA is generated per run, installed only in the disposable emulator, and trusted by the debug wallet only for the fixture host.

## iOS wallet canvas bottom 2026-10-13

- [x] Prove native viewport reaches the edge and body safe-area padding shortens the canvas.
- [x] Capture actual dark Explore before and after a single body-padding override.
- [x] Move iOS safe-area reservation into navigation and CTA controls while retaining keyboard inset.
- [x] Audit every full-height bottom control and measure actual React ancestry with compiled CSS.
- [x] Verify actual WK geometry, visible/hidden nav and CTA/keyboard clearance.
- [x] Run full noncoverage unit, lint, typecheck and fresh mobile/native gates.
- [x] Capture fresh light/dark Explore, actual scrolled lists and keyboard/CTA acceptance screenshots.

Criterion: "lets have the wallet fo to very bottom of iphone screens too", with the gesture bar overlaid. Native WK frame and window end at 874 points, adjusted scroll inset is zero; existing body padding 34 stops both canvas and footer at 840. Overriding only body padding moves both to 874, confirming the CSS cause. The physical screenshot's apparent strip is its body background/shadow, not a native black frame gap.

Final canvas acceptance: native suite33 passes with2 opt-in skips, Android90 passes, full ESLint and TypeScript pass. Twelve actual React DOM cases with compiled CSS verify final controls, scrolling and single-floor recovery clearance. Fresh final-build simulator screenshots show dark Explore, light Language/Settings after scrolling, and Send with and without the keyboard. The simulator captures omit the home-indicator stroke; the page background reaches the actual bottom, and native home-indicator behavior is unchanged. Full noncoverage unit verification passes 23,358 tests across 1,020 suites, with four tests and one suite skipped.

Review: final corrected full noncoverage run passes 23,358 tests across 1,020 suites, with four tests and one suite skipped. Full lint and typecheck pass, native gates pass 33 iOS and 90 Android tests, and 12 actual React geometry cases pass. Fresh final App screenshots show the canvas reaching the bottom while controls and keyboard CTAs remain clear. Coverage remains CI-only at unchanged 95% thresholds.

# Transaction failure reporting

- [x] Trace all runtime terminal failure writes and reporting consent boundaries.
- [x] Add a worker-safe Sentry reporter with a closed diagnostic schema.
- [x] Report guarded transaction failures, including tracking phases and later node verdicts.
- [x] Capture safe custom-request authentication facts locally, without transmitting values.
- [x] Prove the actual wire excludes user data and respects consent withdrawal.
- [x] Run focused noncoverage tests, type and lint checks; keep coverage gates unchanged in CI.
- [x] Run the required independent review and fix actionable findings.
- [x] Prepare the verified feature branch for publication after applicable gates.

## Design

Handled transaction failures reach Sentry independently of whether a popup remains open. Emit only after a committed failure transition, so retries and no-op writes do not produce duplicate terminal reports. Distinguish an unknown submission outcome from a final failure. Historical backup bookkeeping is not a new execution failure.

Report only fixed transaction/stage/route categories, shipped dependency versions, known protocol error identities, and locally derived authentication-format/commitment-match categories. Do not transmit requests, addresses, note/account/transaction identifiers, amounts, signatures, salts, commitments, URLs or a persistent user identifier. Reuse the existing consent and crash egress protections. Integrate the merged privacy-diagnostics API from main.

## Review

Independent review found stale authentication diagnostics after retry and pending reports surviving stop/re-enable boundaries. Retry diagnostics are cleared per attempt, and both capture and transport consent awaits reject stopped reporting generations. Re-review found no remaining actionable findings.

Validation: 934 tests across 34 focused Jest suites and 29 native SDK tests pass. Type checking, full ESLint, i18n and E2E harness lint, native prover pin validation and the background build pass; the expected background artifact exists. Wire regressions reject raw failure data and prove both consent races. The optional whole-repository noncoverage run was stopped while exercising unchanged password derivation; full-suite testing and the unchanged 95% coverage thresholds remain CI gates. No local coverage was run.

# Cross-chain swaps through 1Click (#1738)

Spec: https://github.com/0xMiden/wallet/issues/1738

User decisions: build the config-gated integration before Miden is listed; delegate bounded implementation tasks; complete independent review on finished code.

Architecture: preserve the PSWAP form when both networks are Miden. Add remote-configured 1Click assets and a server-side partner-key proxy. Verify signed quotes and exact request binding before exposing deposit instructions. Ordinary Miden sends retain Guardian, spending limits and native fees, with a persisted deadline enforced immediately before broadcast. Track swaps durably and resume polling from the app root. Incoming SUCCESS remains arriving until an exact destination note is available locally.

- [x] Inspect the issue, fresh main, API contract and existing swap/bridge/send flows.
- [x] Confirm the unmet listing prerequisite and the user's config-gated choice.
- [x] Implement validated config, signed quote/status client, EVM transfer and partner-key service with tests.
- [x] Implement durable swap tracking, local note confirmation and deadline-safe ordinary sends with tests.
- [x] Integrate network selection, quote/review/deposit UI, contacts and history using shared components and localization.
- [x] Read the connected external wallet token/native balances, reserve gas, and recheck the exact transfer before signing while retaining the session on amount edits.
- [x] Implement the cost-bounded mainnet swap-out/swap-back harness using existing funded accounts and actual returned principal.
- [x] Complete two Chrome acceptance cases: one actual WalletConnect scenario and one ordinary Guardian send. The WalletConnect pairing survives amount edits, sends only the revised 0.0002 ETH transfer after confirmation, and an unrelated same-amount note remains arriving while the exact linked note completes the swap.
- [x] Add mocked testnet 1Click E2E alongside mainnet, following the existing Epoch test harness.
- [x] Gate the entire integration with wallet-config features.nearIntents, default false, plus an explicit false mainnet flag in the config repository.
- [x] Complete production fixes for confirmed P0-P2 findings and verify their regression assertions.
- [ ] Complete the final independent review and pass current-head CI after publication; prepare the feature PR and final evidence, retaining external activation requirements.

## Integration contracts

Shared types live in src/lib/one-click/types.ts. Core worker publishes exact exported signatures before implementation consumers begin. Config is swap.oneClick with serviceUrl and explicit midenAssets (assetId, faucetId, decimals). Missing config or no validated mapped Miden asset disables all cross-chain starts. No fabricated production mappings or partner key is committed.

The existing send API gains optional final oneClick metadata rather than changing its positional arguments. Tracking uses ordinary transaction rows with extraInputs.oneClick; incoming tracking-only rows use a dedicated supported transaction shape determined by the tracking worker. The deposit quote, route, addresses, amounts, asset identities, deadline and service URL are persisted before external transfer, so a restart cannot lose an in-flight deposit.

Delivery note IDs must be resolved from the provider's destination transaction hashes through an explicitly configured Miden receipt adapter on the quote service. The current 1Click listing supplies no Miden receipt contract. Until exact IDs are available the wallet conservatively retains arriving, never completes by matching an unrelated amount.

## Verification constraints

Use resource-guarded local checks for lightweight commands only. Full suites, coverage and builds run in CI; global coverage thresholds remain 95% for all metrics. Record expected-red evidence before fixes. The mainnet E2E harness must reuse existing funded accounts and recycle principal with an out-and-back swap. A live run remains unavailable until Miden is listed and activation prerequisites are configured. The user authorized autonomous review and current-head CI for wallet PR #1742, followed by an admin squash merge after required checks pass. Feature activation, wallet release and partner proxy deployment remain unauthorized; `features.nearIntents` stays false. Cap screenshots at 1800px and review affected UI states. Make review dependencies available before independent review begins.

## Review

Production snapshot 802 passed 30,236 unit tests across 1,196 suites, with four existing test skips. Its unchanged 95% coverage gate passed at 98.14% lines/statements, 97.57% functions and 95.97% branches; the Chrome build and 25 mock UI tests passed. The corrected visual source passed all 20 cases after proving the new contrast and fixture assertions fail against the old rendering. The real Guardian Miden scenario passed; the inbound WalletConnect scenario exposed a relay origin rejection. A dedicated test project now allows the stable E2E extension origin, and both browser and counterparty configuration are prepared. Corrected expected-red CI run 39878428301 manually confirmed all 61 intended functional failures and 23 passing controls, including 14 Worker passes and two Worker cases exposing 502 instead of the expected 400. Fixed-snapshot unit CI passed 23/23 tests with full TypeScript; strict seven-file lint and format checks passed with zero warnings. Both Chrome acceptance cases passed, including one actual WalletConnect scenario and one ordinary Guardian send, with no skips, retries, flaky cases or browser errors. Pairing survived the amount edit, exactly one revised 0.0002 ETH transfer was sent, an unrelated same-amount note remained arriving, and the exact linked note completed the swap. Fresh resized screenshots showed 0.0002 ETH, 0.0002 MLOCAL and the matching minimum-received amount. Current-head CI awaits publication, and final independent review remains pending. The funded mainnet loop requires Miden listing and enabled configuration; activation remains off.

Current validation: 1,217 tests passed across 38 suites, including the exact 598 retained and 90 required titles, with zero skips or runtime failures. Full TypeScript and source ESLint passed, as did canonical formatting for all 31 files. The formatter workflow itself reported failure solely because its temporary changed-path guard counted the workflow file; its formatting step passed. Coverage includes ambiguous or failed EVM intent holds, atomic persisted markers, trusted EVM asset tuples, terminal outbound success, safe pre-submission checkpoint recovery, and fork and Dependabot Guardian workflow eligibility. The architecture guidance documents the same boundaries. Final independent finished-code review and current-head CI remain pending.

Follow-up regressions keep refunded deposits terminal in Activity while preserving the provider refund phase, hash, and attempt marker, and keep unsupported prototype-named chains on the manual recipient path while supported Ethereum routes still work. Expected-red CI executed 110 assertions: 106 passed, including all 7 named controls, and 4 intended functional assertions failed. Fixed CI passed 865 tests across 21 suites, including 662 exact-core tests and all 87 required titles; full TypeScript, full source ESLint, 18 style checks, and diff checks passed. Independent finished-code review and current-head CI remain pending.

- Mainnet 1Click E2E uses $2 as the total round-trip safety cap, including both swaps and network gas. Optimize for the cheapest viable route and minimum viable amount; do not treat the cap as a target. Reuse the funded accounts and recycle actual received principal.

- Additional acceptance: a mocked testnet E2E runs alongside nightly mainnet, following Epoch. It exercises deterministic wallet execution and status/failure paths while retaining real funded-mainnet settlement coverage.

- Swap-in balance contract: read the selected chain for the connected address; compare base units exactly, retain native gas, refresh stale reads, and refuse unverified or insufficient funds before the transfer request. Amount edits retain the WalletConnect session and invalidate the old quote/review.

2026-10-22 12:22UTC: user explicitly confirmed hermetic local-chain mocked E2E, matching Epoch. The dedicated localhost/localnet gate is confirmed. Real mainnet acceptance remains additive.

2026-10-22 12:30UTC: user explicitly accepted Chrome for the mocked suite provided WalletConnect works there. Required acceptance drives real Bread UI, actual WalletConnect handshake to test counterparty, amount edit without reconnection, and one revised-amount transfer. No phone runner is required.

2026-10-22 recovery: the initial independent review was incomplete and its evidence remains preserved. The user chose to fix confirmed findings before fresh verification. Config PR #24 completed review with zero findings and all 152 CI checks passed. Wallet preflight passed 175 checks across eight suites; dedicated mocked Chrome and visual acceptance remain CI gates. Eligibility now recognizes explicitly enabled 1Click-only routes while preserving place restrictions.

2026-10-22 authorization update: the user explicitly requested deployment of the matching feature-eligibility service after tests and finished-code review. Keep nearIntents false. This authorizes that service deployment only; wallet PR merge/release and the new partner proxy deployment are not authorized.
# NEAR Intents eligibility service deployment

The service must recognize explicitly enabled valid 1Click-only configurations while preserving existing location restrictions and default-off behavior. Prepare a service-only deployment from protected main without a wallet release.

- [x] Carry over the validated capability predicate and its regressions.
- [x] Add a manual-main deployment path pinned to the workflow commit, retaining the protected environment and release-tag path.
- [x] Verify worker tests, workflow contracts and CI dry run.
- [x] Complete independent finished-code review and fix actionable findings.
- [x] Merge service-only PR #1746 using the explicitly authorized admin squash merge after all 15 required checks pass.
- [x] Deploy the reviewed service and verify its live revision and backward compatibility, retaining nearIntents false.

Service validation: 145 Node tests passed with zero skips, all five targeted mutations failed at their named assertions, and all 15 required checks passed. PR #1746 merged as 76148bdb5b23cc66913dbe2af386f96eb442a549. Deployment run 39818501102 succeeded, and live health reports ready at that revision. The four configured wallet origins and rejected-origin cases match pre-deployment behavior. The daily query cap remains 10,000, and nearIntents stays false.
# #1752: retain swap fill progress after cancellation

## Plan

- [x] Claim the PR and merge current `origin/main` at `8a2ab67` into the designated worktree at `cf855a2`.
- [x] Complete one normal internal review on the merged candidate. Do not use Review Council for this wallet PR.
- [x] Fix stale failed rows after requeue and invalidate settled-history gap work when its reader is inactive.
- [x] Bound transaction page limits and timestamp ties, serialize gap traversal, and refresh mutable bridge/Earn status.
- [x] Replace the P1 source-pattern and vacuous-result tests with behavioral regression tests.
- [x] Run focused checks through `ci-local`; 238 tests, TypeScript, ESLint, formatting, and `git diff --check` pass.
- [x] RED: prove an older Unconfirmed history row updates to Failed after the reconciler records a never-committed verdict.
- [x] GREEN: include Unconfirmed rows in the older loaded activity-status refresh set.
- [x] Re-run affected tests and static gates, then complete normal internal re-review on the final merged-main head.
- [ ] Push the reviewed merged-main candidate and monitor exact-head CI.
- [ ] Confirm all required exact-head checks and the wallet pre-merge CI event gate pass, then squash-merge.

## Internal review

- Fixed P1: refreshed rows replace stale failed rows after requeue.
- Fixed P1: gap fill and `loadMore` stop after unmount, offscreen transition, or switching away from Settled.
- Fixed P1 test proof: behavioral regressions replace source-spelling and vacuous-result assertions.
- Fixed P2 behavior: page bounds, timestamp tie handling, serialized gap traversal, and mutable bridge/Earn status refresh.
- Simplified unused `fromEnd` and duplicate resolver reads while retaining the getter and shared linked-row behavior.
- Deferred P2 test-proof gap under the session rule: the mixed-status cursor fixture does not model displaced-row backfill.

# Follow-up to #1790: describe wallet-file contents accurately

# Release Guardian forgot-password canonicalization

- [x] Inspect main workflow history, failed trace and actual stale-state rejection.
- [x] Prove reset-before-canonical regression red in isolated CI (40229470185: both intended assertions fail).
- [x] Gate destructive reset on the existing Guardian settlement ledger.
- [x] Verify focused CI, types and lint; hand off for normal review.

Evidence: expected-red 40229470185 failed both intended reset-order assertions. Green 40230016357 passed 106 tests in three suites, TypeScript, named ESLint and formatting. Product recovery checks are unchanged; the test now waits for its funded Guardian backup to canonicalize before destructive reset. Normal review and funded release validation remain with the release coordinator.

# Release Swap amount-anchor fixtures

- [x] Inspect same-workflow main history, traces, screenshots and exact final quote amounts.
- [x] Prove amount-anchor and quote-drift regression red in isolated CI (40231995182: three intended failures).
- [x] Make each scenario choose one typed amount and verify the other before signing.
- [x] Preserve no-price refusal; supply a valid price when exercising balance and zero-amount gates.
- [x] Verify focused CI, types, lint and formatting; hand off for normal review and full Swap rerun.

Expected-red 40231995182 failed all three intended helper assertions. Green 40232273778 passed 262 tests in four suites, TypeScript, named ESLint and Prettier. The candidate changes only harness inputs and fixture expectations to match #1823 exact-receive semantics; production financial guards are unchanged. Normal review, integration and full Swap E2E remain with the release coordinator.

# Release Swap guard loading-side follow-up

- [x] Identify the exact failed boundary in full run 40232658245 and its trace.
- [x] Prove absent-pay-input regression red in CI (40239138581: intended wrong-field value failure, 262 other tests passed).
- [x] Bind amount edits and assertions to their existing pay/receive side containers.
- [ ] Verify focused green CI and hand off for normal review and full Swap integration.

# Issue 1948: storage-loss recovery

- [x] Inventory storage, recovery, lifecycle and submission boundaries; approve design and plan from the issue brief.
- [x] Prove storage-loss and stop-on-failure regressions in isolated CI.
- [x] Implement cross-realm health, retained-vault consistency and lifecycle handling.
- [ ] Implement encrypted bounded independent journal and user-controlled external backup.
- [ ] Coordinate prebroadcast evidence and submitted-transaction reconciliation.
- [ ] Add strict durability, bounded reconstructible storage and SDK dependency evidence.
- [ ] Validate focused tests, mutations, platform UI, builds and unchanged 95% coverage gates in CI.
- [ ] Complete finished-code Council review and hand off exact source and remaining dependencies to root.

Review: pending. Implementation approval comes from issue #1948 under walletissues step 4. Root retains merge and release authority.
