# Distributor v2 acceptance checks

Offline evidence for the canonical distributor implementation in commit
`8920d63be10952493fd70175d836ca6b4eaf80fa`. The acceptance expansion changes tests and this report only;
production MASM, Rust builders, fixture bytes and protocol roots remain unchanged.
No network deployment, funding, minting or signer action forms part of this evidence.

Run from this package using its pinned Rust 1.98.1 toolchain and protocol/standards/testing 0.17.1:

```sh
cargo test --locked
cargo test --test distributor_claims callback_native_bootstrap -- --nocapture
cargo test --test distributor_claims committed_claim_renews -- --nocapture
cargo test --test distributor_claims direct_payout -- --nocapture
```

The full suite passes 47 tests: 30 distributor tests, 16 preserved legacy funded tests, and one
legacy protocol probe. No local coverage run is used. The three acceptance cases below also pass
individually. Rust sources are formatted with the installed stable rustfmt because the pinned
1.98.1 toolchain does not include rustfmt.

## Callback-enabled native asset

The test creates a synthetic standard network faucet with its real send/receive callbacks enabled,
uses it as MockChain's native fee asset, and supplies its foreign account inputs. This exercises
callback execution, rather than merely setting a callback bit on a configuration value. Canonical GC
uses the verified callback-free Testnet identity; distributor creation uses deterministic fixture
seed `[42;32]`. These fixtures do not represent the live native faucet's deployed state.

| Committed transaction | Inputs | Actual fee | Final measured cycles |
| --- | ---: | ---: | ---: |
| Unrouted nonce-zero bootstrap deposit | 1 | 119 | 54,429 |
| Routed claim batch | 2 | 119 | 76,773 |
| Routed replenishment batch | 2 | 119 | 70,725 |

Each transaction asserts `actual_fee >= 7 * (ilog2(final_cycles) + 1)`. Each input receives its exact
budget minus its fair integer fee share; refunds plus actual fee equal total input budgets. The
native reserve remains zero. Canonical inventory moves from bootstrap 100GC to 80GC after claims,
then to 120GC after two 20GC deposits. Every transaction is submitted to MockChain and proved in a
new block; every consumed request nullifier is checked after commitment. This supplements the
existing singleton callback-native execution test.

## Calendar-week renewal

One account claims and commits in its initial week, claims and commits in the next week, then skips
two weeks and claims again. Every receipt contains exactly 10GC, so the distributor loses 30GC total.
A duplicate after the second committed claim rejects as already claimed. The map contains entries
only for the three claimed weeks, with both skipped weeks still empty. This proves renewal without
catch-up allocations on the same persistent account state.

## Direct transaction-script attacks

Each attack runs alongside an otherwise valid claim, so rejection must also roll back the claim's
inventory debit and entitlement write:

- Calling the actual checked payout root directly rejects because no input note is active during
  transaction-script execution.
- A real `SendNotesTransactionScript` attempting a 1GC BasicWallet withdrawal rejects because its
  transaction-script root is outside the allowlist.
- Calling `set_fee_policy` with the currently installed valid fee-policy root rejects because the
  distributor has no authority configuration. The test does not rely on an invalid proposed root.

After each rejection, the committed vault, complete storage, current week entry, active fee-policy
root and request nullifier remain unchanged. The same valid claim then executes and commits,
returning exactly 10GC, preserving the pre-existing native reserve and writing the entitlement once.
