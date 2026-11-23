# GC integration contract

The current release scope is **Arcade discovery, game details, catalog-scoped Activity, synchronized GC balance display and the GC purchase on mainnet**, retaining the existing Arcade design. Coins shows GC balance and a **Buy more GC** entry point that is live while the mainnet sale note is open; there is no weekly claim, reset, next-claim countdown or global GC balance leaderboard.

The purchase uses GeoQuizz's custom sale script. See [Use Gamecoin](https://github.com/guelowrd/gq-thegamenotthemagazine/blob/main/docs/build-your-own-game.md#7-use-gamecoin). Standard PSWAP notes are not eligible for this purchase path.

## Asset and price

Mainnet GC uses faucet `0x34a3510213533f512ec4abe36baf84`, with six decimals. Payment uses the chain's USDCx fee asset, also with six decimals. The wallet accepts a price at or below 0.001 USDCx per GC. It selects the cheapest discovered sale that can supply the entered amount and meet the minimum fill. Equal prices select the larger inventory. The buyer's own sales are excluded because their consumption withdraws inventory.

The amount field starts at 1 GC. The cost is rounded up to a USDCx base unit. The receipt records the GC that the script delivers with this payment. Network fees are separate. There is no fixed package or protocol limit of 100 GC.

Discovery uses the pair's standard PSWAP tag, `1663710438`, but accepts only sale script root `0xfe5c6de19f05ae3c77227128bcf15180fc252b94429a3b030967126077e1db2a`. A sale has seven storage fields and exactly one fungible asset. Each fill consumes its note and creates the remainder with a new ID. Discovery checks nullifiers, retains progress across bounded batches, and checks cached open sales again. A quote uses the eligible notes read so far; later checks can find more offers.

`features.arcadeGcPurchase` remains the purchase switch. The existing `arcade.sale.seller` field remains in the accepted config schema and cache scope for compatibility. It no longer restricts which sellers can supply GC. The script root, asset pair and price limit validate each offer.

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

## Purchase request and acceptance

The SDK's PSWAP consume helpers reject the custom sale root. `buildGcSaleRequest` instead uses the node's authenticated note as an explicit input with argument `[usdcx_paid, 0, 0, 0]`. The fee-aware builder retains the Guardian authentication arguments. The request is built under the WASM lock in the chain-synced Guardian proposal hold, then stored before proposal creation. Existing queue, spending-limit, signing and receipt handling remain in use.

The builder checks the script, unspent state, creator, explicit payment and minimum fill again. It refuses the buyer's own sale. The note ID binds the quoted storage and assets. If another buyer consumes that note, the purchase fails; a new quote must use a live remainder. Never retry an uncertain submission as a fresh purchase without reconciliation.

The old `scripts/dev/gc-sale/buy.mjs` probe used standard PSWAP notes. It does not establish acceptance of this custom-script path. A real Guardian purchase on extension, iOS, Android and desktop still needs supported-surface acceptance. Confirm the wallet's own transaction and GC balance; consumption of a sale note alone can be another buyer's transaction.

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
