# Bridge portal core

Source: https://github.com/0xMiden/bridge-portal/tree/cb52c470395273e05e84460fdadc59652d9ef5b3
License: MIT (verbatim LICENSE alongside this file).

Adapted source paths:
- src/bridge/core/{assets,models,rules,quote,routes,receipt-route,balance-cap,activity-status,provider,submission}.ts
- src/app/components/bridge/use-bridge-transfer.ts (ReviewedTransfer moved to client-independent core/review.ts)
- src/app/lib/bridge-submission.ts (review binding and post-valuation recheck, not external-wallet execution)
- src/bridge/providers/epoch/{epoch-quote,epoch-execute}.ts (Miden-source quote/send adapter and exact reviewed minimum)

Wallet destinations: src/lib/bridge/core/, src/lib/bridge/catalog.ts, src/lib/bridge/providers/epoch/ and the reviewed-minimum parser in src/lib/epoch/bridge.ts. The wallet's accepted remote-config snapshot and verified metadata replace bundled release configuration. Existing wallet financial engines retain execution, signing and tracking ownership.

Verbatim test references under src/lib/bridge/testing/:
- portal-connections.json: src/config/wallet-config/token-connections.json
- portal-mainnet.json: src/config/wallet-config/mainnet.json
- portal-testnet.json: src/config/wallet-config/testnet.json

The Epoch adapter delegates to the existing wallet collateral, queue and tracking owners. The retained Epoch 2.0.1 API exposes provider validity, not a quote expiry, so the portal's synthetic 60-second lifetime is not copied. Its EVM-source fixed-input receive API needs a newer SDK and is not claimed or simulated here.

These references are not imported by runtime code. Test fixtures model the portal's explicit src/config/wallet-config/epoch-mainnet.ts rollout as accepted test input; runtime never installs that overlay or overrides feature switches. The retired Epoch faucet and unverified directional outputs are not new starts. Reference coverage is not a claim of current deployment availability.
