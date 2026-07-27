# Bridge-IN e2e harness — REAL WalletConnect on iOS simulator (user-chosen)

Philosophy: production path. iOS simulator + native Reown real WalletConnect + real signing
by a headless WC counterparty wallet. Cross-chain DELIVERY stays a local solver double (CLI
note delivery to real localnet Miden) — the one thing that can't be real cheaply.

## Make-or-break de-risk (do FIRST)
- [ ] Can a headless WC counterparty wallet (@reown/walletkit) pair with the app's native
      Reown plugin on the iOS sim, and can the test extract the `wc:` pairing URI?
      (URI lives in the native Capacitor sheet — may need a test-only native hook.)
- [ ] Does the mobile in-page backend load the bridge-in reconciliation + test hooks?
      (No SW on iOS — verify installBridgeInTestHooks path works in the Capacitor context.)
- [ ] iOS buildable on this branch's SDK? (memory: guardian consume RefCell panic on 0.15.5 — check.)

## Then build
- [ ] Headless WC counterparty wallet (Node): pair off URI, approve eip155:11155111, sign eth_sendTransaction against Anvil.
- [ ] Test hook to surface the `wc:` URI from native Reown (if not already exposed).
- [ ] Anvil (chain 11155111) + Epoch/AggLayer doubles + CLI solver-double note delivery.
- [ ] iOS Playwright spec: Receive -> Cross Chain -> connect (real WC) -> deposit (real sign) -> real note -> received.
- [ ] Config plumbing: AggLayer sender override (done), AGGLAYER_BRIDGE_API + allocator URL for doubles.
- [ ] CI: iOS bridge-in gate.

## Already done (platform-agnostic, keep)
- [x] AggLayer sender runtime E2E override (bridge-in.ts) — for pointing at the CLI solver account.
- [x] bridge-in test hooks scaffold (bridge-in-test-hooks.ts) — verify it loads in mobile context.
- Foundation up: real localnet Miden node + prover + note-transport verified; miden-client CLI works.
