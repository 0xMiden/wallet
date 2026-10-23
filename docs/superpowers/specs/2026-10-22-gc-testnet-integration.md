# GC integration: scope supersession

The weekly-allowance design is superseded. The current approved contract is
[fixed purchase package plus conditional 10-GC starter allocation](../../arcade/gc-integration.md).
Coins contains balance and Buy more GC; no weekly claim/reset/countdown remains in the product.

Retain weekly distributor code, tests, deployment records and
[historical Testnet evidence](../../arcade/canonical-gc-claims.md) for reference. That evidence does not
establish the registration gift or purchase route. Do not delete work or close dependent PRs blindly.

Issues [#1452](https://github.com/0xMiden/wallet/issues/1452),
[#1515](https://github.com/0xMiden/wallet/issues/1515) and
[#1691](https://github.com/0xMiden/wallet/issues/1691) track the UI, integration contract and starter/purchase
dependencies. Any starter allocation depends on confirmed reliable duplicate-free distribution; otherwise no free
allocation is offered. Purchasing is independent. For an approved starter allocation, registration is
the eligibility source; durable network/account allocation status, prior-gift reconciliation
and the payout service contract remain dependencies. Do not infer an additional activation-date cutoff.
Live purchases stay disabled until a real route and acceptance exist. Mainnet activation needs separate
review. Games remain responsible for their economic rules; wallet-explore owns the catalog.
