# @miden/hd-key

SLIP-0010 hardened-only key derivation and BIP-39 mnemonic helpers for the Miden Wallet (issue #918).

## Scope

- `slip10.ts`: the master key from a seed and hardened child keys. See "Which SLIP-0010 rule" below. The HMAC label is a parameter: SLIP-0010 uses it only for domain separation.
- `miden.ts`: the Miden account seed policy (labels, coin type, path layout, scheme versions).
- `mnemonic.ts`: `@scure/bip39` with the English wordlist fixed.

The package imports nothing from the wallet. The wallet maps its enums to the numeric path levels in `src/lib/miden/sdk/derive-seed.ts`.

## Which SLIP-0010 rule

SLIP-0010 has one HMAC-SHA512 chain and two rules to make a child key from its output `I = I_L || I_R`. The curve selects the rule:

| Curve | Master secret | Hardened child secret | Validity | Retry | Non-hardened |
|---|---|---|---|---|---|
| secp256k1, nist256p1 | `I_L` | `(I_L + k_parent) mod n` | must be in `[1, n)` | yes, re-HMAC with `0x01 ‖ I_R ‖ ser32(i)` (master: with `I` as the new seed) | yes |
| ed25519, curve25519 | `I_L` | `I_L` | each 32-byte string, the all-zero string included | no | no |

This package uses the **second rule for each wallet key, on each curve**. The name is only a label. The package does not use the ed25519 curve.

The reason is the use of the output. The derived 32 bytes are **not a signing key**. They are a seed for an SDK key constructor (`AuthSecretKey.ecdsaWithRNG` or `AuthSecretKey.rpoFalconWithRNG`). The SDK makes the key from that seed. For ECDSA, the SDK reduces the seed into a valid secp256k1 scalar. For Falcon, the seed feeds a lattice sampler, and `mod n` has no meaning. Thus:

- A `mod n` addition and a retry loop on bytes that are not a scalar have no effect that we want. They also tie one seed to one curve.
- The derivation the wallet used before issue #918 (`@demox-labs/aleo-hd-key`) used the same rule. The `legacy` scheme must keep it, or its golden vectors do not match.
- With no retry, the derivation is a fixed number of HMAC calls.

The cost is interoperability. A Miden ECDSA key is never equal to a BIP-32 wallet key for the same phrase. The package cannot reproduce the secp256k1 test vectors of the specification as-is. This is a decision (issue #918). `slip10.test.ts` checks the hardened secp256k1 vector with the scalar addition applied in the test. This shows that the HMAC chain, the label and the data layout are correct for that curve.

## Schemes

| Scheme   | HMAC label       | Path                                                         |
|----------|------------------|--------------------------------------------------------------|
| `legacy` | `bls12_377 seed` | `m/44'/0'/<walletType>'/<accountIndex>'`                     |
| `v1`     | `miden seed`     | `m/44'/5063758'/<walletType>'/<authScheme>'/<accountIndex>'` |

- `walletType`: 0 on-chain, 1 off-chain, 2 guardian.
- `authScheme`: 0 falcon, 1 ecdsa. The `legacy` scheme has no scheme level, so a Falcon key and an ECDSA key at the same index had the same seed. `v1` gives them different seeds.
- `5063758` is the SLIP-44 coin type registered for Miden.

Both schemes must stay byte-for-byte stable forever. The derivation decides which accounts a seed phrase recovers, so a change to a label or a path orphans every existing wallet. `miden.test.ts` freezes golden vectors for both schemes; do not recompute them from the code under test.

## Rules

- The seed must be 16 to 64 bytes (128 to 512 bits). Each 32-byte secret is valid, the all-zero secret included.
- An index must be an integer from 0 to 2^31 - 1. The package applies the hardened offset. The offset is not a parameter.
- Each path segment must be hardened. A segment must not have a leading zero. The master path `m` is valid.
- Inputs are `Uint8Array`, not hex strings. The package clears each intermediate buffer after use.

## Reference

The code was checked against the audited MetaMask `key-tree` package to make sure it does not repeat known bugs. `slip10.test.ts` runs the official SLIP-0010 ed25519 test vectors 1 and 2 with the standard `ed25519 seed` label, and the hardened chains of secp256k1 test vector 1 with the `Bitcoin seed` label.

## Build

```bash
yarn build:hd-key   # from the repo root: tsc -> packages/hd-key/dist/, also run by the root postinstall
```

The wallet uses the package through a `link:` dependency and its built `dist/`. Jest maps `@miden/hd-key` to `src/`, so unit tests need no build step. Do not run `yarn install` inside the package. Its dependencies resolve from the root `node_modules`.
