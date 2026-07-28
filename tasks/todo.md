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

## Both bridge-in deposit routes GREEN. AggLayer (ETH/Slow) + Epoch (USDC/Fast). Committing + pushing.

## Findings to report to the team
- WALLETCONNECT_PROJECT_ID is NOT set anywhere (repo/CI/release) -> builds fall back to b54ef53.
  Fragile: any build not manually setting it ships the fallback. Verify the release process sets it.
- Relay rate-limits bursts of connections on the same projectId/IP (intermittent 403).
