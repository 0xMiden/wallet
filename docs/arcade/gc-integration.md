# GC integration contract

This guide describes the approved Bread GC contract and the current **unmerged Testnet stack**.
It does not announce a production release. Native iOS Testnet evidence is recorded in
[deployment and acceptance notes](canonical-gc-claims.md). Interactive extension acceptance is still
unvalidated; local Android setup was explicitly skipped. Successful builds are not interactive acceptance.

## Network and asset selection

| Binding | Testnet acceptance |
| --- | --- |
| GC token issuer | `0x97924b9a77ed54917ff6d6364ae661` |
| GC precision | 6 decimals; 10 GC = 10,000,000 base units |
| Inventory distributor | `0x5f2b2136d78f755114d00efe84b7aa` |
| Network-fee asset | USDCX, `0x4cbdcaffe75f0a317482224dae6436`, 6 decimals |

The token issuer identifies balances and payout assets; the distributor identifies request routing,
weekly entitlement and receipt sender. They are not interchangeable. The distributor transfers funded
inventory and cannot mint or change issuer governance. Do not relabel another asset with the GC symbol.

The future Mainnet target is `0x34a3510213533f512ec4abe36baf84`; it requires separate reviewed activation.
Weekly Mainnet claims remain disabled. A network-specific registry entry must be reviewed and published
before the wallet displays its verified badge. Reading an authoritative balance does not confer that badge.

## Weekly allowance

An account can explicitly claim 10 GC once per fixed calendar week, starting Monday at 00:00 UTC,
regardless of balance. Unspent GC carries over. Missed weeks create no catch-up allowance. Ordinary
transfers do not renew eligibility. This is per account, not per person; it does not prevent Sybil accounts.

A Sunday approval remains Sunday's allocation if its payout arrives Monday; Monday starts a separate
allowance. Approvals bind the account, network, protocol, allocation week, amount and expiry. They cannot
be silently rolled into another week. This binding does not guarantee an inclusion-time Monday cutoff.

The **Coins subpage** contains the balance, allowance, explicit claim and recovery controls. Opening
Arcade does not claim. Discovery remains focused on games. There are no global rankings or private-balance
snapshot submissions.

## Claim, receipt and recovery lifecycle

1. Read balance and authoritative weekly status independently. Unknown balance stays unknown. For a new
   v2 request, read the distributor vault at the same block as entitlement. Missing, duplicate or
   insufficient stock disables a new funded request; it does not hide existing receipts or recovery.
2. Prepare a quote and review the request fee, execution budget, receipt-fee estimate and expiry.
   The existing wallet approval/queue pipeline persists the exact reviewed request and operation identity.
   Checking stock does not reserve inventory against another claimant before inclusion.
3. Submission acceptance is pending, not delivery. Reconcile the stored operation and chain evidence
   before retrying an uncertain outcome. Never fabricate a GC credit from a submitted request.
4. Authenticate the payout receipt, then separately review and approve receipt collection. The receipt
   carries exactly 10 GC plus unused execution budget. Receipt consumption has its own network fee.
5. Refresh the wallet balance from confirmed state after collection. Ordinary balance reads use the
   wallet's local synchronized account; network sync is a separate process. Refreshing a screen does not
   prove that a submitted transaction committed. Keep pending/freshness states explicit.
6. Retain pending operations across restart and reconcile public requests after recovery/reinstallation.
   Expose request-budget reclaim only when authoritative evidence supports it. Retained v1 configuration
   is cleanup-only: old pending requests, receipts and recoveries remain accessible before new v2 claims.
   A prepared quote stays with its original backend.

The user pays request, distributor execution, receipt and recovery network costs. Show the fee asset
and amount separately from GC. Execution uses only its actual fee and returns unused budget with the
receipt. Refund collection itself costs a network fee, which can exceed a small refund. Do not promise
fixed fees, gas-free claims or sponsorship.

[`WeeklyClaimService`](../../src/lib/arcade/weekly-claim.ts) defines the internal wallet
`read` / `prepare` / `submit` boundary and status/review types. It is **not a public mini-app claim API**.
Use the existing supported wallet connection and transaction interfaces for a game's installed SDK;
this guide introduces no new callable API or guarantee that arbitrary game notes are consumable.

## Games, results and payments

Play, replay and social result sharing remain free at zero GC. An optional paid on-chain action is
separate from those actions. Each game owns its stake, payout destination, score validation, ties,
deadlines, settlement and refund rules. There is no universal 1-GC submission price or shared wallet
payout contract. GQ's champion/rival model is a read-only reference, not a mandatory model.

Before approval, show the game/action/result identity, selected GC issuer/network, GC amount, network
fee, public result disclosures and actual payout/refund conditions. Bind the immutable result or
challenge identifier to the payment. Preserve identifiers and reconcile uncertain outcomes before
retrying, so retries do not produce duplicate results or charges. A local score is not a confirmed
on-chain result; catalog listing is not certification of scoring or settlement security.

After returning to Bread, refresh confirmed wallet state. Catalog-origin Activity classifies wallet
transactions; it is not a complete gameplay or outcome feed. A new game implementation requires a
separately agreed repository/scope. Reference-game inspection does not authorize changes or deployment.

## Catalog registration

[wallet-explore](https://github.com/0xMiden/wallet-explore) is the catalog source. Submit reviewed entries
there using its current network-specific schema and review process. The wallet reads `<network>.json`
from that repository and retains version floors and cached/bundled fallback; wallet-config is not the
catalog and wallet-config #10 is not a prerequisite.

The current reader accepts an item ID, localized name/tagline, URL, category and `isExchange`, with
optional icon and brand color. Published game items use category `games`; the wallet maps that into its
Arcade grouping. Confirm the owner, launch URL, network, metadata and supported wallet permissions
before publication. Preserve the schema's URL restrictions, document versions, section references and
icon rules. See the actual [schema](../../src/lib/explore-config/schema.ts) and
[source](../../src/lib/explore-config/source.ts), rather than inventing registration fields or endpoints.

Catalog publication, accepted-version compatibility and launch/return behavior need separate checks on
the supported build. Registration does not enable a claim deployment or approve a game's payout policy.

## Evidence and release gates

- Native iOS Testnet claim, receipt/refund, restart persistence, ordinary transfers and automatic
  distributor replenishment are confirmed in the open stack. Protocol tests and SDK parity complement
  those observations; they do not prove every concurrent-device/reinstall scenario.
- Interactive extension acceptance remains open. Android local testing was skipped; CI compilation does
  not establish Android behavior. Record light/dark and narrow-layout checks for each exercised surface.
- Current-head CI, maintainer review, bottom-up merges, token-registry publication, catalog compatibility
  and release-build acceptance are separate gates. A passing previous head is not a passing current head.
- The Testnet v2 distributor starts a fresh ledger; v1 flags were not migrated. This proves isolation,
  not a Mainnet entitlement migration. Mainnet activation needs a separate decision and review.

Public capability descriptions must distinguish approved design, Testnet observations, merged code and
released behavior. No launch date or Mainnet weekly-claim availability follows from these Testnet checks.
