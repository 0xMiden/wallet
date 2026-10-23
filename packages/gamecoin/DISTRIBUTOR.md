# Canonical GC distributor v2

This module is an offline protocol implementation. No account in its fixtures is deployed or funded.
Legacy `funded.rs`, `claim.masm` and `funded-*.masm` are retained unchanged for experimental deployment recovery.

The distributor is a separate public BasicWallet network account. Its fixed code has no faucet,
mint policy, owner, upgrade procedure or arbitrary transaction-script authorization. BasicWallet
withdrawals require successful authentication: only the exact claim/deposit roots and the standard
expiration transaction script are allowed. A plain P2ID cannot bypass the input allowlist. Standard
fee-manager FPI exports remain available for sender-side zero-fee quotes; no companion sponsorship
note is required. Fee-policy mutation remains authority-gated without an installed authority.

`distributor_builder(seed, gc_faucet, native, genesis)` builds an account locally. `build()` preserves
the uncreated account and its public creation seed; `build_existing()` is for MockChain tests.
`CanonicalDistribution::from_account` exposes distributor ID/code, GC faucet, native faucet, genesis,
ABI version and both roots from the concrete account. GC must be callback-free, as canonical Testnet
GC is. The configured network native asset may use standard callbacks; those need foreign account
inputs during execution. A standard callback-enabled native faucet is covered by conservation tests.

## Approval ABI

Both scripts use 36 storage felts. Version/domain 2 is incompatible with the old issuer protocol.

| Offset | Field |
| --- | --- |
| 0–3 | Standard P2ID receipt script root |
| 4–7 | Receipt serial bound to the complete approval |
| 8–11 | Canonical GC asset ID |
| 12–15 | GC amount value word: claim exactly 10,000,000; deposit exact incoming GC amount |
| 16–19 | Receipt tag and reserved layout fields |
| 20–21 | Sender/receipt target suffix, prefix |
| 22–23 | Approved Monday UTC week and expiry seconds; deposits use zero salt |
| 24–27 | Distributor code commitment |
| 28 | Finite reclaim block height |
| 29 | ABI version 2 |
| 30–31 | Distributor suffix, prefix |
| 32–35 | Network genesis commitment |

Claim receipt domain `0x47435232`; deposit receipt domain `0x47434432`. The receipt serial hashes
`[domain,2,0,0]`, note script root, request serial, outer metadata, attachment commitment, asset
commitment, storage 0–3 and storage 8–35. Changing budget, sender, reclaim height, target, genesis,
version or metadata changes receipt identity. Receipt ID additionally depends on the actual refund.
Receipt sender and network target are the distributor; receipt GC asset issuer is the canonical faucet.

Claims carry exactly one native budget asset. The checked account payout procedure itself requires
its configured claim root, network, distributor ID, standard P2ID root, sender, 10GC descriptor,
unexpired approval and the authenticated reference block's Monday UTC week. It checks and writes
the sender/week map atomically and debits held canonical GC into the receipt. An insufficient vault,
duplicate entitlement, wrong binding or insufficient fee budget fails the entire transaction; neither
budget nor entitlement is consumed. Existing claimant balance never enters the entitlement check.
Missed weeks do not accumulate. A Sunday reference proof can commit on Monday; a Monday reference
cannot execute the old Sunday approval. This preserves the existing reference-time policy and does
not impose inclusion-time expiry.

## Replenishment and creation

`deposit_note` carries exactly canonical GC plus a native execution budget in a routed note.
`bootstrap_deposit_note` creates the same fully bound request without a network-target attachment,
for nonce-zero account creation only. Both require the exact distributor ID, code and genesis.
Unrouted deposits are rejected after creation; claims always require routing. Deposits create one
P2ID refund receipt, credit exact canonical GC inventory and never touch the weekly entitlement map.
A deposit must leave a positive native refund. An exact-fee deposit is rejected, avoiding any reliance
on empty output-note support. Claims can refund zero native because their receipt always carries GC.

Transactions contain only claims or only deposits. For `N` inputs the actual network fee `F` is split
in input order as `floor(F/N) + (index < F mod N)`. Every input must cover its own share; a deposit
must exceed that share. Each refund is `budget-share`; pre-existing native reserves are unchanged.
Auth pays for the final settlement cycle bound and checks that bound. Tested batches include 16
claims and two deposits. The intrinsic output cap is not an operational throughput guarantee: the
protocol's global advice-memory budget can reject large batches.

The sender can reclaim all request assets after the approved reference reclaim height. Distributor
execution requires an earlier reference height. Competing proofs still share one nullifier, so only
one commits. Receipts require explicit standard P2ID collection.

## Offline artifacts and deployment gate

Run from this package using its pinned Rust toolchain:

```sh
cargo test
cargo run --example distributor_vector > distributor-vector.json
```

The vector includes the deterministic uncreated account bytes and public account seed, exact code
and script roots, claim/deposit/bootstrap note bytes, storage, commitments and IDs. Seed `[42;32]`
is a public reproducibility fixture, not an approved funding target. Preserve the exact reviewed
uncreated account bytes and seed when preparing a real deployment; changing code/storage changes
its identity. Obtain the network genesis and canonical faucet identity from independently verified
network configuration before preparing the actual account. The fixture uses the verified Testnet
GC/native identities but is construction evidence only.

Before any live action: review protocol code, roots, configuration and unsigned bootstrap/deposit
artifacts; review the exact funding recipient; obtain the separately authorized GC holder or mint
signers' approval. Bootstrap deposits must actually be created by a funded signer, then consumed to
create the account. Later refill and claim notes use the routed path. Testnet's observed 3GC supply
cannot cover one 10GC allocation without additional separately authorized minting. This protocol
never mints, modifies mint signers or assumes access to their keys. Mainnet activation remains gated.
