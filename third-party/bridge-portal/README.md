# Bridge portal core

Source: https://github.com/0xMiden/bridge-portal/tree/cb52c470395273e05e84460fdadc59652d9ef5b3
License: MIT (verbatim LICENSE alongside this file).

Adapted source paths:
- src/bridge/core/{assets,models,rules,quote,routes,receipt-route,balance-cap,activity-status,provider,submission}.ts
- src/app/components/bridge/use-bridge-transfer.ts (ReviewedTransfer moved to client-independent core/review.ts)
- src/app/lib/bridge-submission.ts (review binding and post-valuation recheck, not external-wallet execution)

Wallet destinations: src/lib/bridge/core/ and src/lib/bridge/catalog.ts. The wallet's accepted remote-config snapshot and verified metadata replace bundled release configuration. Existing wallet financial engines retain execution, signing and tracking ownership.

Verbatim test references under src/lib/bridge/testing/:
- portal-connections.json: src/config/wallet-config/token-connections.json
- portal-mainnet.json: src/config/wallet-config/mainnet.json
- portal-testnet.json: src/config/wallet-config/testnet.json

These references are not imported by runtime code. Test fixtures model the portal's explicit src/config/wallet-config/epoch-mainnet.ts rollout as accepted test input; runtime never installs that overlay or overrides feature switches. The retired Epoch faucet and unverified directional outputs are not new starts. Reference coverage is not a claim of current deployment availability.
