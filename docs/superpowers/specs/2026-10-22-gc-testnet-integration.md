# GC Testnet integration

Reviewed scope: Testnet first, implemented as incremental stacked PRs on the existing Arcade work.

## Outcome

A user can open Arcade in Bread, discover a reviewed Testnet game, see a verified GC balance, explicitly claim the weekly allocation, receive spendable GC, transfer it, and use exactly 1 GC plus disclosed network fees for the reviewed paid action in one integrated game. Playing, replaying and sharing remain free, including at zero GC.

Testnet is the first acceptance environment. Mainnet activation requires a separate reviewed deployment decision and verified network-specific configuration.

## Review and repository boundaries

- Use wallet issue #1452 as the umbrella. Continue with contained stacked PRs above #1512, #1650 and #1693, each carrying only its own change. Reconcile the base with current main before extending the stack.
- Bring forward the useful native UI from #1512, visual polish from #1650, and Coins-only weekly claim UI from #1693. Preserve current main behavior, including Activity's All / Pending / Transfer / Swap / Earn / Others categories and Mainnet faucet hiding.
- Keep the current Arcade design. Discovery shows games; the Coins shortcut holds the balance, allocation and Claim controls. Do not revive the old global Rankings or private-balance snapshot flow.
- Keep catalog publication in 0xMiden/wallet-explore. Do not migrate Explore catalogs to wallet-config or require wallet-config #10. Wallet-config retains its existing network/feature-policy responsibilities; add GC configuration there only if its existing configuration contract is the appropriate home.
- This issue is the review entry point. Keep separate components in their existing repositories. Contract/service, wallet-explore, documentation or game changes get linked PRs where those components belong.
- Keep and update the existing Arcade PRs; do not replace them with one combined PR. Merge reviewed stack layers bottom-up, retargeting children before a parent branch is deleted. Preserve the local #1744 onboarding work separately.

## Canonical-token alignment approved October23,2026

Reuse Gaylord's existing canonical GC issuer on each verified network and the existing PSWAP shop. Weekly free claims distribute canonical GC from a separately funded distributor; do not deploy a competing minting faucet. Mainnet activation remains a separate reviewed decision. Prior experimental Testnet issuers and evidence do not establish canonical integration.

## Product contract

- GC is an ordinary transferable fungible token with six decimals. No transfer ban or game allowlist. Reuse the existing PSWAP shop for optional GC purchases; purchases never create another weekly entitlement.
- An account may explicitly claim 10 GC once per calendar week, resetting Monday at 00:00 UTC, independent of its balance.
- Unspent GC carries over. Missed weeks do not accumulate. Sending GC away does not create a new entitlement. This is per account, not per person; no identity or Sybil-prevention system is implied.
- Users fund all claim and leaderboard-submission network costs. Display those separately from the GC amount before approval. No wallet/team-funded user-fee subsidy.
- Paid game actions use 1GC under each game's disclosed policy. GQ's champion/rival challenge stakes are the recommended reference, not a universal mandatory game treasury. Each game owns score validation, ranking, ties, payout recipients, deadlines, settlement and refunds. Distinguish recoverable/winnable stakes from nonrefundable fees. Playing, replaying and social result sharing remain free; sharing a paid on-chain challenge is separate.
- Unknown balance is unknown, not zero. A submitted or accepted operation is not a confirmed claim. No optimistic GC credit or fictional success in real flows.

## First gate: prove the transaction architecture

Before deploying a distributor or enabling canonical Claim, inspect the current protocol/SDK and demonstrate a minimal controlled local/test transaction design that satisfies the product contract. Record:

1. The existing canonical issuer identity, decimals and mint governance, plus the separate distributor account/authentication, inventory, configuration and funding ownership.
2. The authoritative account/network/week identity and clock. Weekly entitlement must survive concurrent devices, local reset, recovery and reinstalls.
3. How recipient authentication, replay prevention and atomic eligibility consumption work together with canonical inventory distribution. An arbitrary mint API or client-side cooldown is insufficient.
4. Who executes and technically pays every transaction in claim request, distributor payout, note receipt/consumption and any refund. Show exactly how the user funds every cost. A faucet HTTP request does not automatically charge the user issuer-side fees.
5. Where durable operation records live, how they recover after crashes and lost responses, and which finalized evidence proves delivery or a terminal failure.
6. What happens to a funded request across the Monday boundary, a changing fee quote, insufficient funding, an expired request or an issuer outage. Bind approvals to their intended account/network/week/amount; do not silently repurpose an old approval.

Prefer the smallest protocol-supported design. Whether weekly enforcement belongs fully in contract storage or in a reviewed distribution service remains a technical decision for this gate. Do not present a feasibility assumption as implemented security. If the fee or atomicity requirements cannot be met, return a concrete decision to Brian rather than weakening them.

## Implementation work

### Canonical inventory and weekly distribution

Implement authenticated claims against funded canonical inventory, authoritative weekly eligibility, durable idempotency/status, delivery tracking, inventory replenishment and the fee mechanism proven above. The distributor cannot mint or change canonical mint governance. Operator credentials stay in the established secret-management system, outside repositories and public artifacts. Include deployment artifacts, configuration validation and operator recovery instructions.

Separate the distribution decision from receipt availability. Concurrent/replayed requests must resolve to one logical allocation for the intended account/network/week. A retry after an uncertain response must reconcile the existing operation before distributing again. A confirmed failure must name what remains refundable or retryable.

### Wallet

Replace #1693's unavailable service adapter with real balance, eligibility, claim and reconciliation interfaces. Reuse the existing wallet signing, fee-review, transaction, native-proving and note-receipt paths. Avoid a parallel transaction engine.

Show eligible, approval, submitting, pending/awaiting receipt, confirmed, already claimed/next availability, stale/offline, unavailable, wrong network, insufficient fee funds and actionable terminal failures. Preserve operation identifiers across wallet restart and isolate account/network state. Refresh from authoritative evidence after receipt; do not increase balances in the UI first.

Normal Activity keeps the six categories. The Arcade shortcut may show an explicitly labeled game-origin scope without replacing those categories. Describe this feed as wallet transactions associated with catalog games, not a complete gameplay or outcome feed.

### Catalog and reference game

Use the published wallet-explore contract. Map its existing categories into Finance / Arcade / Others in the reader unless a separately reviewed compatible publication change is necessary. Preserve catalog versions, accepted floors, cached fallback, icons, URLs, recents and launch permissions.

Inventory the existing mini-apps and confirm each launch URL, target network, owner and listing metadata before publishing it. A wallet listing does not certify a game's score or rewards contract.

Integrate one existing suitable game as the end-to-end reference. Select it after inspecting current code, permissions and score-validation support; the choice is not yet made. It must support free play/share and a separate explicit 1-GC leaderboard submission. Document the score-validation trust boundary and bind a submission/result identifier to its GC payment so retries do not create duplicate results or charges. If only an untrusted score demo is available, label it as a demo and do not count it as acceptance of a functioning verified leaderboard.

Measure proving and receipt performance on the actual Bread mobile/browser path. Prior native-only or offline proof checks do not establish that a game is usable in the wallet.

### Evidence and rollout

Run unit/protocol tests at meaningful boundaries, then prove the real Testnet flow in Bread on iOS, Android and the extension before calling the cross-platform feature complete. Compile other affected targets and state exactly which were exercised. Use the wallet frontend skill and real light/dark, narrow-screen layout checks. Use real balances and receipts for the acceptance flow; isolated labeled fixtures can test failure states.

A deployment record identifies the commit, network, asset, contract/account policy, service/config versions, operator and rollback/disable procedure. Mainnet configuration stays disabled until the separate Mainnet review.

## Acceptance checklist

- [ ] Architecture gate proves controlled minting, atomic weekly entitlement, recipient binding, complete user-funded fees and recoverable receipts.
- [ ] First claim delivers exactly 10 GC; another claim that week cannot issue another allocation, even across devices/reinstall/recovery.
- [ ] Next Monday, carryover, missed weeks, high/zero balances and transfers behave as specified.
- [ ] Duplicate taps, concurrent requests, replay, wrong account/network, outages, lost responses, delayed notes and issuer/wallet restart do not double issue or falsely report success.
- [ ] Fee approval names the actual assets/costs; insufficient funds, rejected approval and quote/fee changes are handled without a hidden subsidy.
- [ ] Verified balance is refreshed after confirmed receipt; ordinary GC transfers work.
- [ ] Arcade retains the reviewed discovery and Coins design, and current main Activity behavior remains intact.
- [ ] Approved catalog entries launch and return through Bread; wallet-explore compatibility and version floors remain intact.
- [ ] One integrated game's free play/replay/share works at zero GC; its explicit leaderboard submission debits exactly 1 GC plus disclosed network fees under its reviewed payment-routing/refund rules and records one result after reconciliation.
- [ ] Real Testnet evidence is recorded for supported wallet surfaces. Fixtures and untested surfaces are identified separately.
- [ ] Each stack layer is independently reviewable and carries only its own delta. No Mainnet activation is included.

## Open items resolved during design/feasibility

Issuer/claim architecture and fee funding, GC decimals/identity, operational ownership and deployment target, the reference game and its score-validation contract, and reviewed mini-app listing inventory. These are explicit implementation gates, not assumed completed work.

## Why this is needed

The three Arcade PRs currently provide separate UI layers on an older base. The production claim adapter is unavailable, and a token deployment alone would not supply weekly eligibility, user-funded issuance, receipt recovery or game integration. A coordinated Testnet stack gives one reviewable path from UI through spendable GC to a real game submission while preserving current wallet behavior.


Related: #1515 (shared integration contract), #1691 (issuer and claim capability). Existing UI PRs: #1512, #1650, #1693.
