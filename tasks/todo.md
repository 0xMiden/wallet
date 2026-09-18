# Issue 64: imported account backup and restore

- [x] Add a strict versioned backup parser with legacy compatibility.
- [x] Export one authenticated and internally consistent backend snapshot.
- [x] Validate every imported secret before publishing a restored vault.
- [x] Export complete version 2 encrypted wallet files.
- [x] Restore encrypted-file onboarding without changing seed recovery.
- [x] Restore current-design account import and encrypted-file export entry points.
- [x] Prove the same imported account ID can sign before export and after restore.
- [ ] Complete full verification, visual grading, Review Council, PR, CI, and merge.

## Issue 64 review

- `yarn check:deps`: passed.
- `yarn tsc --noEmit`: passed.
- `yarn lint`, `yarn lint:i18n`, and `yarn lint:e2e`: passed.
- Prettier checked every changed TypeScript file: passed.
- Locale source and generated-bundle parity: the keys this change adds are deliberately absent from every
  non-English bundle, so they reach the DeepL job as untranslated rather than being stamped current. The suite
  is red locally until that job runs and commits; `pr.yml` runs `translations` first and every other job needs
  it, so the gate sees the translated files.
- Affected Jest verification: 19 suites and 933 tests passed.
- `E2E_NETWORK=testnet yarn playwright test --config playwright.e2e.config.ts playwright/e2e/tests/imported-account-backup-restore.spec.ts --retries=0`: 1 test passed in 20.0 seconds.
- The E2E artifact scan found no private-key material and no capture archives.
- `yarn build:desktop`, `yarn build:mobile`, `yarn build:extension`, `yarn test:e2e:blockchain:build`, and `E2E_NETWORK=testnet yarn test:e2e:mobile:build`: passed. The iOS build ended with `BUILD SUCCEEDED`.
- Expected desktop, mobile, extension, and iOS Simulator application artifacts were present after their builds.
- `git diff --check`, forbidden-dash scan, and attribution scan: passed.
- Full `yarn test:coverage --runInBand`: 661 suites and 11,282 tests passed in 3,336.302 seconds. Coverage was 97.40% statements, 95.32% branches, 96.49% functions, and 97.40% lines, above every 95% threshold.

| Approved visual criterion | Pass / Fail | Fresh desktop and iOS evidence |
| --- | --- | --- |
| Recover offers Seed Phrase and Encrypted Wallet File | Pass | Both complete choices and descriptions are visible. |
| File selection is usable | Pass | The drop zone, device picker, JSON restriction, and Import action are visible without clipping. |
| Wrong password is separate and clear | Pass | The selected filename remains visible and `Incorrect password. Try again.` appears at the password field. |
| A valid encrypted file advances successfully without exposing secrets | Pass | Desktop advances to password creation and iOS advances to passcode setup; no secret text is visible. |
| Mobile content has no horizontal clipping or occlusion | Pass | The actual iOS Simulator frames show every relevant label, card, input, and action inside the viewport. |

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
- WALLETCONNECT_PROJECT_ID is NOT set anywhere (repo/CI/release) -> builds fall back to b54ef53.
  Fragile: any build not manually setting it ships the fallback. Verify the release process sets it.
- Relay rate-limits bursts of connections on the same projectId/IP (intermittent 403).
