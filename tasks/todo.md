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

## Remaining — the deposit half (unknowns resolved; mechanical build)
- [ ] Anvil (chain 11155111) bring-up in the harness; counterparty broadcasts here.
- [ ] client.ts rpcUrl E2E override so app EVM reads (gas/nonce/receipt) hit Anvil.
- [ ] Deposit contracts on Anvil: AggLayer bridgeAsset target (+ Compact/USDC for Epoch) —
      minimal-real or permissive-with-calldata-assert (avoid the "green on any calldata" trap).
- [ ] AggLayer/Epoch doubles as needed (AggLayer receipt path can skip the indexer via pre-set phase).
- [ ] data-testids on bridge-in UI (Cross Chain, token drawer, route, review) for real-UI nav.
- [ ] Full spec: Receive -> Cross Chain -> connect (proven) -> ETH+Slow -> deposit -> confirm
      (real sign via counterparty -> Anvil) -> row created -> solver delivers note -> received.
- [ ] CI gate (mobile job + Anvil; handle relay rate-limit reliability).

## Findings to report to the team
- WALLETCONNECT_PROJECT_ID is NOT set anywhere (repo/CI/release) -> builds fall back to b54ef53.
  Fragile: any build not manually setting it ships the fallback. Verify the release process sets it.
- Relay rate-limits bursts of connections on the same projectId/IP (intermittent 403).
