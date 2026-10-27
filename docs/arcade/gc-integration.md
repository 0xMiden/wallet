# GC integration contract

The current release scope is **Arcade discovery, game details, catalog-scoped Activity, synchronized GC balance display and the GC purchase on mainnet**, retaining the existing Arcade design. Coins shows GC balance and a **Buy more GC** entry point that is live while the mainnet sale note is open; there is no weekly claim, reset, next-claim countdown or global GC balance leaderboard.

The purchase is the PSWAP fill described below (`lib/miden/arcade/gc-sale.ts` and the Arcade GC purchase section of `CLAUDE.md`): the wallet finds the live sale note by its tag, lets the user enter the GC to buy (1 GC by default), prices it from the note's own terms with the cost rounded up so the script never delivers less than asked, and queues a consume row whose fee-aware fill request is built from the node's copy of the note in the Guardian proposal's hold. The fixed 1 USDCx for 1,000 GC package below is superseded by the entered amount; the acceptance requirements still describe the fill's validation. `scripts/dev/gc-sale/buy.mjs` filled the mainnet note end to end on 2026-10-26 with a throwaway wallet. This branch does not implement a gift. The optional starter gift is not a release gate.

## Asset and price

Use existing Mainnet GC issuer `0x34a3510213533f512ec4abe36baf84`, six decimals, and the PSWAP purchase
model. Testnet display/testing retains issuer `0x97924b9a77ed54917ff6d6364ae661`; other trial assets must
not be relabeled. Neither a ticker nor a balance grants a verified badge: normal network-specific
registry review/publication remains required.

The final approved Bread package is **exactly 1 USDCx principal for 1,000 GC**, with no amount input
or package selector. Network fees are separate. This uses the existing **0.001 USDCx per GC** rate;
do not reprice the reference sale notes.

Require actual backed inventory for the full package, with the principal unchanged. Do not silently
partially fulfill, overpay a cheaper sale or retain a difference. Keep buying disabled until terms,
inventory, fee approval, atomic execution, receipt/recovery and native acceptance are validated.

The reference is [GQ's public shop](https://github.com/guelowrd/gq-thegamenotthemagazine/blob/b73356c436307b414cfb9fc0e07a9d821721bbe0/web/src/lib/shop.ts)
and [configuration](https://github.com/guelowrd/gq-thegamenotthemagazine/blob/b73356c436307b414cfb9fc0e07a9d821721bbe0/web/src/config.ts).
It is read-only reference material. No changes or deployment there are part of Bread integration.

## Registration gift: dependency, not delivered functionality

The starter allocation is conditional: eligible registered accounts, including existing registered
accounts without a prior starter gift, receive **10 GC once** only if the distribution owner confirms
reliable delivery without duplicates. Otherwise there is no free allocation. Purchasing is independent
of this dependency; gift availability is not a launch prerequisite. Release approval is separate.
Do not advertise a gift or credit it optimistically before delivery is confirmed.
The specific onboarding subsidy does not sponsor later purchase or game gas.

The inspected [wallet registration adapter](../../src/lib/mainnet-access.ts) reports account admission;
it does not expose a GC grant amount, operation ID or receipt. The node's
[funding-service documentation](https://github.com/0xMiden/node/blob/e8b7b923d8ae8c17efcd2e767803948d37c71848/bin/funding-service/README.md)
describes native-asset funding, not a GC starter allocation. Its accepted requests are held in memory;
this is not an exactly-once registration-gift ledger. Source inspection does not establish the deployed
service configuration.

Issue [#1691](https://github.com/0xMiden/wallet/issues/1691) must identify the onboarding-service owner
and agree the network/issuer, funded inventory or authorized issuance source, one-time allocation
identity, recipient binding, receipt/status API and recovery after retries/lost responses/restarts.
Require durable distribution status and deduplication for network + account, including reconciliation
with any prior gift. Specify who funds gift delivery and any receipt-consumption cost. Account admission is not proof of
GC delivery. Credit balance only from confirmed wallet state, never from registration success.

## Native purchase: acceptance before enablement

A game URL is not a native purchase route. Before enabling Buy more GC, implement and review:

1. Discovery and validation of the intended PSWAP script, GC/payment assets, network, unspent sale,
   available inventory, minimum fill and integer rounding.
2. A quote binding the exact sale(s), exactly 1,000 GC received, exactly 1 USDCx principal, expiry
   and all separate user-paid network fees. No amount selector, smaller delivery or silent principal change.
   Revalidate the quote before approval/submission; show changed or unavailable inventory honestly.
3. The normal Guardian signing, fee review and transaction queue, with durable operation identifiers
   before dispatch and reconciliation before retrying uncertain submissions.
4. Confirmed receipt/finality and balance refresh, plus insufficient funds, consumed/changed sale,
   rejection, lost responses, delayed receipts and recovery. No optimistic credits or duplicate buys.
5. Real supported-surface acceptance using backed inventory in a separately approved environment.

### Atomic PSWAP feasibility: source findings, not purchase acceptance

The installed SDK exposes a single-note PSWAP consume request. The reference game consumes a PSWAP
input in one wallet transaction; its UI cap is not a protocol requirement. The picker selects one eligible sale and does not aggregate. A single matching backed
sale with enough inventory for 1,000 GC can therefore be expressed as a candidate one-transaction package. Exact Guardian execution and
result validation still need acceptance in Bread.

The installed miden-standards 0.17.1 PSWAP model computes proportional output with integer rounding,
and a payment at or above the note's requested amount returns its full offered amount. Overpayment is
permitted by that primitive, so validate exact seller terms before constructing an approved request.

If more than one sale is needed, a combined request must consume all selected notes atomically and
prove aggregate principal exactly 1 USDCx and GC received exactly 1,000, while validating each note's
minimum fill, remainder, asset and rounding. Calling the single-note helper repeatedly is not an atomic
package. No combined Guardian transaction or real quote/inventory has been validated by this UI change.
If the full exact package cannot be supplied in one approved transaction, show unavailable.
Confirm our own transaction and correct GC receipt/balance reconciliation; sale-note consumption alone
is insufficient because another buyer may have consumed it.

The existing Coins UI has no sale scanner, executable quote or approved purchase route. It therefore
shows the planned package without a live quote or availability guarantee and keeps buying disabled. Mainnet activation requires separate review.

## Balance and game contract

Coins reads existing synchronized wallet vault rows, checks their selected-network provenance and
selects only the configured issuer. Missing/loading/wrong-network or malformed data remains unknown;
an authenticated empty vault can display zero. Do not add a starter allocation optimistically.
Balance refresh uses the existing wallet pipeline; a screen refresh does not prove finality.

Play and replay remain free at zero GC. Social sharing and other result posting are managed per game.
Optional paid on-chain record/challenge actions follow the game's disclosed rules. Each game owns its
stake, score validation, payout recipient, ties, deadlines, settlement and refunds. Disclose those terms,
GC amount, user-paid gas and public result data before approval. Preserve immutable action/result and
transaction identities to reconcile retries without double charges.
No universal submission price, shared wallet payout contract or global ranking is implied.

## Catalog

[wallet-explore](https://github.com/0xMiden/wallet-explore) remains the catalog source; wallet-config #10
is not a catalog prerequisite. Follow the current network-specific schema, versions/floors, cached
fallback, URL/icon restrictions and launch permissions. The existing reader accepts item ID, localized
name/tagline, URL, category and `isExchange`, with optional icon/brand color. Published game category
`games` maps to Arcade. See the [schema](../../src/lib/explore-config/schema.ts) and
[source](../../src/lib/explore-config/source.ts). A listing does not certify scoring or payout security.
A new game implementation needs separately agreed scope and repository.

## Retained history and review boundaries

Keep completed weekly protocol, tests, deployment records and PRs for reference. The weekly product
scope is superseded; do not delete operations or blindly close dependent PRs. Existing claim recovery
and receipt history remain separate migration/recovery considerations; this retained UI branch does not include weekly issuance services or their controls.
The existing weekly branches retain recovery implementations and operation history. Any outstanding historical funded operation needs an explicit recovery
access decision before release.

[Historical weekly Testnet evidence](https://github.com/0xMiden/wallet/blob/2f0af8d2856ff22af9ffc0a22a2a8eb48c0fd16d/docs/arcade/canonical-gc-claims.md) proves that implementation's native iOS
flows, not starter gifts or purchases. Interactive purchase acceptance has not occurred on any surface.
Local Android remains skipped/unvalidated. Unit checks, builds, current-head CI and maintainer review apply to this UI change. Purchase, starter-gift, registry publication and release acceptance remain separate follow-up decisions; old weekly stack PRs are not dependencies of this branch.
