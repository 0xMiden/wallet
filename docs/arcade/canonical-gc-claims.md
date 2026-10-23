# Canonical GC wallet binding

The backend supports two independently scoped claim protocols. The approved Testnet asset is our existing
GC issuer `0x97924b9a77ed54917ff6d6364ae661`; Mainnet targets the existing GQ GC, with activation gated. The pinned Testnet deployment
continues to use the experimental v1 protocol; its assets, roots, request rows and budget recovery
remain unchanged. No canonical v2 deployment is activated by this change. Mainnet remains disabled.

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
original protocol scope. A newly deployed distributor starts a new ledger, so acceptance uses an account
without a prior allocation and cannot establish migration of another deployment's weekly map. Authenticated NoteFiles, Guardian fee-aware
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
