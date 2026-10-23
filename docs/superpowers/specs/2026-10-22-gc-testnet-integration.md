# GC Testnet integration

The current approved contract is maintained in [the GC integration guide](../../arcade/gc-integration.md).
[Issue #1452](https://github.com/0xMiden/wallet/issues/1452) tracks implementation and remaining acceptance;
[issue #1515](https://github.com/0xMiden/wallet/issues/1515) tracks the shared integration contract.
[Deployment and acceptance notes](../../arcade/canonical-gc-claims.md) separate native Testnet evidence
from offline checks, publication dependencies and unvalidated surfaces.

The settled scope uses our existing Testnet GC, a separately funded inventory distributor, explicit
10-GC/account/fixed-Monday-week claims in Coins, ordinary transfers and user-paid network fees. Unspent
GC carries over; missed weeks do not accumulate. Play/replay/social sharing remain free. Games own their
stakes, scoring, payouts and refunds; there is no blanket 1-GC submission fee or global ranking.
wallet-explore remains the catalog source. GQ is read-only reference material; no game changes or new
game implementation are authorized by this specification.

Mainnet weekly claims remain disabled and require separate reviewed activation. The wallet stack and
Testnet evidence do not establish merged or released functionality. Interactive extension acceptance
remains open; local Android was explicitly skipped. Registry publication, current-head CI, review,
merge and release acceptance remain separate gates.
