# Bridge portal core

Source: https://github.com/0xMiden/bridge-portal/tree/cb52c470395273e05e84460fdadc59652d9ef5b3
License: MIT (verbatim LICENSE alongside this file).

Adapted source paths:
- src/bridge/core/{assets,models,rules,quote,routes,receipt-route,balance-cap,activity-status,provider,submission}.ts
- src/app/components/bridge/use-bridge-transfer.ts (ReviewedTransfer moved to client-independent core/review.ts)
- src/app/lib/bridge-submission.ts (review binding and post-valuation recheck, not external-wallet execution)
- src/bridge/providers/epoch/{epoch-quote,epoch-execute}.ts (Miden-source quote/send adapter and exact reviewed minimum)
- src/bridge/providers/agglayer/{provider,flows,approval,deposit,quote,agglayer,exit-hash,agglayer-status,status-schema,activity-observation}.ts (used quote, exact-approval, deposit, identity and observation behavior adapted to native wallet owners)
- src/bridge/providers/agglayer/{deposit,agglayer-execute,agglayer-status}.test.ts and fixtures/synthetic-withdrawal.json (adapted regression scenarios and verbatim synthetic fixture)
- src/bridge/providers/xreserve/{deposit-quote,deposit-terms,deposit-preflight,cctp-quote,cctp-schema,circle-api.server,circle-http.server,circle-response,deposit,cctp-deposit,approval,flows,withdrawal-quote.server,cctp-message,cctp-status,arc-status-server}.ts (client-safe quote, validation, exact-approval, source/forwarded receipt and read-only withdrawal preparation behavior)
- src/bridge/providers/xreserve/{cctp-quote,cctp-deposit,deposit,approval,replacement,withdrawal-quote,status}.test.ts (adapted cases) and fixtures/cctp-hook.json (verbatim per-frame protocol reference)

Wallet destinations: src/lib/bridge/core/, src/lib/bridge/catalog.ts, src/lib/bridge/providers/epoch/ and the reviewed-minimum parser in src/lib/epoch/bridge.ts. The wallet's accepted remote-config snapshot and verified metadata replace bundled release configuration. Existing wallet financial engines retain execution, signing and tracking ownership.

Verbatim test references under src/lib/bridge/testing/:
- portal-connections.json: src/config/wallet-config/token-connections.json
- portal-mainnet.json: src/config/wallet-config/mainnet.json
- portal-testnet.json: src/config/wallet-config/testnet.json

Agglayer adaptations live in src/lib/bridge/providers/agglayer/, with the existing src/lib/agglayer/ and native bridge-receive/bridge-in consumers retaining note construction, exit identity, queue submission, destination claim and completed-consume ownership. Source receipt, indexer readiness and locally consumed delivery remain separate. Pending approvals are wallet-row facts, never a second store or permission to resume an uncertain source. The wallet's existing bounded indexer reads and watcher replace portal polling; relative API routes, server withdrawal recovery and external Miden-wallet execution are not copied. The synthetic withdrawal fixture is reference-only and never runtime configuration.

Circle adaptations live in src/lib/bridge/providers/xreserve/ and the existing src/lib/usdcx/ owners. Public configured Circle endpoints replace relative portal API routes; no server credentials, external Miden signer, manual withdrawal completion, extra poller or payout-scan budget is copied. The existing receive wrapper/native queue and exact payout mint/local consume remain authoritative. Generic exact token approval execution/recovery is shared in src/lib/bridge/evm/token-approval.ts without a second approval store. Source CCTP MessageSent has a placeholder nonce; a unique original-transaction-scoped attested immutable transfer supplies the nonce bound to Arc Executed. The published underlying token messenger is retained, with one bounded documented localMessageTransmitter() getter in new-source preflight; source and Arc receipts are reused, not scanned again. The wallet's existing forward-then-executor frame order is preserved; the verbatim fixture uses the other valid composable order, and tests compare each exact frame/payload. Durable destination attempt facts stay on the original row; hashless uncertainty is never retry permission.

The Epoch adapter delegates to the existing wallet collateral, queue and tracking owners. The retained Epoch 2.0.1 API exposes provider validity, not a quote expiry, so the portal's synthetic 60-second lifetime is not copied. Its EVM-source fixed-input receive API needs a newer SDK and is not claimed or simulated here.

These references are not imported by runtime code. Test fixtures model the portal's explicit src/config/wallet-config/epoch-mainnet.ts rollout as accepted test input; runtime never installs that overlay or overrides feature switches. The retired Epoch faucet and unverified directional outputs are not new starts. Reference coverage is not a claim of current deployment availability.
