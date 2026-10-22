# Recoverable Testnet GC claims

Continuation of the approved #1452 scope and [integration specification](2026-10-22-gc-testnet-integration.md). Testnet only; no Mainnet activation or catalog migration.

## Funding and settlement

Replace the experimental issuer with an issuer accepting one public, funded GC claim note. The note carries the user's native fee budget as its own assets, binds the sender, issuer, network, allocation, approved week, expiry and receipt routing, and has a finite reclaim height. Its fee policy returns zero additional sponsorship for this exact validated note shape: this prevents Guardian's standard authentication from creating an additional, unreclaimable sponsorship note. Zero sponsorship is not zero network cost.

On the issuer path, validate the note and current entitlement before accepting its budget or minting exactly 10 GC. Maintain the atomic account/week map. On the reclaim path, only the original sender may recover the unconsumed native budget after the reclaim height; reclaim never mints GC. Competing issuer/reclaim executions consume the same note, so only one can commit.

The issuer authentication preserves the standard network account's note/transaction allowlists, effect check, native fee payment, sponsorship conservation and nonce behavior. Only funded CLAIM inputs and the canonical expiration transaction script are permitted. Each input creates exactly one GC receipt, in input order; no other outputs are permitted before fee payment. Support ordinary node batches: a single-claim-only restriction would consume other claimants' node retry budgets during contention.

For N claims, pay the actual protocol TX_FEE F, then divide it deterministically: each input pays floor(F/N), and the first F modulo N inputs pay one additional base unit. Each budget must cover its own share. Add each unused budget to that claimant's existing public P2ID receipt carrying GC. No separate successful-claim refund transaction is needed. A bounded post-payment cycle allowance covers settlement and the extra receipt assets, with measured worst-case tests and a runtime cycle-bound check where available. Require the final native reserve to equal the initial reserve: no old balances may subsidize a claim, and no surplus may accumulate. Underfunding or failed assertions must roll back issuance and eligibility.

The issuer reference height must be below the signed reclaim height; the sender reclaim path requires a reference at or above it. A previously proved issuer transaction can race against a reclaim; consensus permits only one consumption, but does not promise reclaim priority. Receipt recipient commitments and serials are deterministic before dispatch, while the final receipt note ID is discovered after fee settlement determines its asset commitment.

Preserve the standardized network-account storage, fee interface, native fee asset and expiration-script allowlist needed by the node executor. Do not assume source compatibility proves deployment compatibility: test automatic execution on the actual Testnet.

Bootstrap uses one fully bound, public but unrouted funded claim. The initial issuer transaction accepts an absent routing attachment only at nonce zero, preserving every weekly, code, asset, fee and refund check. This avoids quoting an issuer before it exists. It grants no administrative authority: the sender only funds and receives its own normal weekly allocation. Every later request must carry the standard network target.

## Clock decision

Miden 0.17.1 exposes reference-block time, not future inclusion time. Brian approved the following semantics on 2026-10-23: a Sunday-approved claim may arrive Monday, counts only against Sunday's week, and Monday starts a new 10-GC allowance. Bind each approval to its authenticated reference week and expiry; never repurpose it. Fresh Monday references reject old-week approvals. Receipt delay does not move an allocation into a different week, and unapproved missed weeks do not accumulate. Retain executable boundary tests; do not describe a strict inclusion-time cutoff as implemented.

## Wallet and recovery

Reuse Guardian custom requests, the existing transaction queue, fee review and receipt consumption. Persist deterministic request/preimage identifiers before dispatch, scoped by genesis/account/issuer/week. Unknown submission outcomes stay pending and reconcile before any retry. Reinstall recovery reads authenticated weekly state and public request/receipt history; local storage is not entitlement authority.

Derive the receipt serial with domain-separated Poseidon2 over the claim script root, request serial, public metadata, attachment commitment, asset commitment and all claim storage except the derived receipt serial itself. This binds every approved field and the entire outer note identity. Match a consumed request and its exact public receipt in the same committed block; the Web SDK does not expose a public issuer-transaction history API, so never invent a transaction ID. Receipt issuance and the user's later receipt consumption remain separate evidence.

Approval separates the request fee, maximum issuer budget, expected receipt fee and possible failed-request reclaim fee. Issuance is not delivery: report a completed claim only after consuming the canonical receipt and refreshing the real balance. Unknown balances stay unknown.

## Token identity and stack

The current trial issuer cannot install replacement code. Do not relabel its existing tokens as tokens from the replacement issuer. Record the replacement's exact account/code/storage roots and genesis before registry publication. Publish its six-decimal GC identity in `0xMiden/token-list/testnet.json`, with maintainer review, then refresh the wallet's bundled snapshot. Leave `wallet-explore` as the catalog source.

Keep the protocol/refund delta above #1751, request/recovery and wallet activation as separate dependent wallet PRs, and token-list as a companion PR targeting that repository's main. Each PR carries only its own commits. No unreviewed merge is implied.

## Required evidence

Real protocol transactions must cover exact budget = actual fee + receipt refund; zero/nonzero initial reserves; underfunding; zero surplus; wrong sender/issuer/asset/amount; duplicate week; expiry; reclaim before/after height; competing reclaim/issuer outcomes; Guardian generation with zero extra sponsorship; and the authenticated Sunday/Monday boundary. Follow with native Bread claim, uncertain-response/restart recovery, receipt consumption, balance and ordinary transfer. Report unsupported surfaces and pending registry publication explicitly.
