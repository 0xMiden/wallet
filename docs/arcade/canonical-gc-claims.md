# Canonical GC wallet binding

The backend supports two independently scoped claim protocols. The approved Testnet asset is our existing
GC issuer `0x97924b9a77ed54917ff6d6364ae661`. The active Testnet distributor is
`0x5f2b2136d78f755114d00efe84b7aa`, committed at block474315 with10GC of existing inventory.
It does not mint. Mainnet remains disabled.

The exact v1 binding is retained as cleanup-only configuration. Bread checks that history first and
keeps pending requests, receipts and refundable native budgets accessible before switching to new v2
claims. A prepared approval stays with its original backend even if cleanup finishes during review.
New v1 claims are disabled, including a race where recovery disappears during preparation.

A reviewed v2 deployment must provide `distribution.protocolVersion = 2`, `distributorId`,
`distributorCodeCommitment`, `gcFaucetId`, and the configured
`bread::gc::distributor::weekly_claims` map. The existing `issuerId` and
`issuerCodeCommitment` fields are legacy authority aliases: for v2 they must equal the distributor
ID and code. Conflicting aliases or incomplete v2 bindings are rejected. The GC faucet must differ
from both distributor and native asset.

Request routing, target attachment, foreign account input, receipt metadata sender, deployment code
and weekly entitlement map belong to the distributor. The allocation descriptor, receipt asset and
verified wallet GC balance use the canonical faucet. The v2 request retains 36 storage felts, sets
ABI version 2 at offset 29, distributor suffix/prefix at offsets 30/31, and receipt domain
`0x47435232`. Genesis, account, week, distributor, code, faucet and version remain bound throughout
quotes, persisted scope, recovery and receipt admission. A v1 quote cannot be reused with v2.

Canonical scopes have separate queue identities and retain their full distribution binding across
restart. Legacy scope keys are unchanged. An explicit deployment selects its GC faucet; this never relabels balances from a different issuer.
The chosen Testnet faucet is the same asset used in the existing trial; its v1 operations retain their
original protocol scope. This Testnet distributor starts a fresh weekly ledger; existing v1 allocations
are not copied into its map. Using the funded test account for both deployments tests protocol isolation,
not global weekly-history migration. A Mainnet migration requires a separate entitlement decision. Authenticated NoteFiles, Guardian fee-aware
builders, WASM locks, outgoing queue holds, duplicate prevention and uncertain-submit reconciliation
continue to use the ordinary wallet pipeline.

Run offline construction checks from the repository root:

```sh
node scripts/verify-gc-request.mjs
node scripts/verify-gc-distributor-request.mjs
```

These use the installed real Web SDK and the Rust fixture to compare note bytes, storage,
commitments, routing and serialized request output. They do not connect or write to a network.
The distributor fixture and its public seed are construction evidence only and must never become
a funding recipient or an active deployment. Live activation requires separately reviewed account
artifacts, roots, configuration and funding authorization. Token verification follows registry
publication; this change does not add a local verified badge override.

## Testnet deployment evidence

- Funding request `0x249ba374ba33f8995da5d28eb655b516f6e1643578f42dc9a671bf681888fc1c`: committed474299, moving10GC and210native units into the bound bootstrap note. Sender fee119native units.
- Distributor creation `0x92d43b8fa378a433fbf99d784132313b5753761e05b79baa0e1a09a91fa3fc08`: committed474315, inventory10GC, native reserve0. Deposit fee119of210;91returned in native-only P2ID receipt.
- Refund collection `0xca0ea22933135ec9db30b503d52716a2cc696f1875f1adc0e8e58a57e318cfad`: committed474336,91received and119fee paid. Inventory remains10GC.

Deployment is confirmed separately from Bread native claim acceptance. Token-list PR4 remains a registry
publication dependency; the wallet does not grant a verified badge by overriding its token list. Game
repositories are read-only references. This change does not publish or modify any game.
