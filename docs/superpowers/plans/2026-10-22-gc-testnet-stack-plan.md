# GC Testnet stack implementation plan

Implement issue #1452 as contained PRs above #1512 → #1650 → #1693. The reviewed specification is [GC Testnet integration](../specs/2026-10-22-gc-testnet-integration.md).

## Constraints

- Keep wallet-explore as the catalog source, including its schema and version floors. No dependency on wallet-config #10.
- Preserve current main's Activity categories and Mainnet faucet hiding. Keep discovery focused on games and allocation controls on Coins.
- GC is transferable, with six decimals. Each account can explicitly claim 10 GC per calendar week, resetting Monday at 00:00 UTC. Balance and transfers do not affect entitlement; missed weeks do not accumulate.
- Users fund every claim and leaderboard transaction. Unknown balances and uncertain outcomes cannot become zero balances or successful claims.
- No Mainnet activation, global rankings, paid refills or gameplay charge. Only a per-game leaderboard submission costs 1 GC plus disclosed network fees.
- Keep each PR's own delta reviewable. Merge reviewed layers bottom-up; retarget children before deleting merged parent branches.

## 1. Reconcile the existing UI stack

1. Reconcile #1512 with current main, preserving normal Activity behavior.
2. Restore main's wallet-explore source, schema, snapshots, cache, version floors and CSP. Map tools/defi to Finance, games to Arcade and nft/learn to Others in the reader.
3. Verify against actual wallet-explore catalogs with a separate policy/eligibility fixture. Cover grouping, exact launch URLs, cached fallback, stale versions, network isolation and light/dark layouts.
4. Bring #1650 forward with its translated design changes, then #1693 with Coins-only weekly controls. Adapt browser assertions to each layer's intended UI.
5. Run focused tests, type checking, builds and independent review before updating the existing PRs. Production Claim stays unavailable.

## 2. Prove the issuer and fee architecture

1. Inspect exact SDK/protocol 0.17 dependencies; older local checkouts are not authoritative.
2. In isolated protocol tests, prove controlled issuance, authenticated recipient binding, an authoritative account/week map and all user-funded fees.
3. Test duplicate and concurrent requests, expired or stale-week requests, fee changes and underfunded requests when the issuer already holds reserves. No failed request may consume an entitlement or spend another user's funds.
4. Prove the public SDK can construct the request and query the issuer policy. Record how request fees, issuer fees, receipt fees and change/refunds reach their intended recipients.
5. Define recovery from lost responses, delayed notes, reinstall and issuer interruption using finalized chain evidence.
6. Publish the validated protocol as its own stack layer. Keep deployment and wallet writes disabled until the architecture gate passes. If a protocol limit forces a product change, present the concrete decision before weakening the contract.

## 3. Connect the wallet and prove Testnet claims

After the protocol interface is proven, implement read, prepare, approve, submit and reconcile through the existing wallet backend, transaction pipeline, fee review and note-receipt paths. Persist operation identifiers before dispatch and isolate account/network state. Do not build a second transaction engine.

Add controlled Testnet deployment/configuration and record claim → receipt → balance → transfer evidence. Exercise duplicate taps, rejected approvals, insufficient funds, uncertain responses, restart and week boundaries. Native and browser evidence must identify the exact build and account/network; mocks do not establish acceptance.

## 4. Integrate one game and publish its catalog entry

Select an existing licensed game after checking current source, permissions, network and score validation. Keep free play, replay and sharing separate from the explicit 1-GC leaderboard submission. Bind the result identifier to its payment and reconciliation so retries cannot duplicate charges or results. Specify payment recipients and refunds in the game's reviewed contract.

Publish the approved listing through a linked wallet-explore PR. Measure proving and receipt behavior in Bread on the supported mobile/browser surfaces. An untrusted score demo or native-only proof is not acceptance of a verified leaderboard.

## Review gates

Review atomic weekly enforcement, reference-block clock behavior, fee funding and refunds, recovery after lost responses and exact payment/receipt provenance. Each code layer needs fresh review and executable boundary tests. Report unavailable or untested behavior explicitly; do not infer readiness from a compiled UI.
