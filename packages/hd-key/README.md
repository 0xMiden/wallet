# @miden/hd-key

SLIP-0010 hardened-only key derivation and BIP-39 mnemonic helpers for the Miden Wallet (issue #918).

## Scope

- `slip10.ts`: the master key from a seed and hardened child keys, with the ed25519 rule of SLIP-0010 (`k_i = I_L`, no curve arithmetic, no retry). The derived 32 bytes are a seed for an SDK key constructor, never a curve scalar. The HMAC label is a parameter: SLIP-0010 uses it only for domain separation.
- `miden.ts`: the Miden account seed policy (labels, coin type, path layout, scheme versions).
- `mnemonic.ts`: `@scure/bip39` with the English wordlist fixed.

The package imports nothing from the wallet. The wallet maps its enums to the numeric path levels in `src/lib/miden/sdk/derive-seed.ts`.

## Schemes

| Scheme   | HMAC label       | Path                                                         |
|----------|------------------|--------------------------------------------------------------|
| `legacy` | `bls12_377 seed` | `m/44'/0'/<walletType>'/<accountIndex>'`                     |
| `v1`     | `miden seed`     | `m/44'/5063758'/<walletType>'/<authScheme>'/<accountIndex>'` |

- `walletType`: 0 on-chain, 1 off-chain, 2 guardian.
- `authScheme`: 0 falcon, 1 ecdsa. The `legacy` scheme has no scheme level, so a Falcon key and an ECDSA key at the same index shared a secret. `v1` separates them.
- `5063758` is the SLIP-44 coin type registered for Miden.

Both schemes must stay byte-for-byte stable forever. The derivation decides which accounts a seed phrase recovers, so a change to a label or a path orphans every existing wallet. `miden.test.ts` freezes golden vectors for both schemes; do not recompute them from the code under test.

## Rules

- The seed must be 16 to 64 bytes (128 to 512 bits). Every 32-byte secret is valid, the all-zero secret included.
- An index must be an integer from 0 to 2^31 - 1. The hardened offset is applied inside the package and is not a parameter.
- Every path segment must be hardened and must not have a leading zero. The master path `m` is valid.
- Inputs are `Uint8Array`, never hex strings. Intermediate buffers are cleared after use.

## Reference

The implementation follows MetaMask `key-tree` v10.1.1, audited by Cure53 in February 2023 and April 2024. The checks above map to audit findings MM-02-003 (seed length), MM-02-004 (master key bounds) and MM-02-007 (the all-zero ed25519 key is valid). `slip10.test.ts` runs the official SLIP-0010 ed25519 test vectors 1 and 2 with the standard `ed25519 seed` label.

## Build

```bash
yarn build:hd-key   # from the repo root: tsc -> packages/hd-key/dist/, also run by the root postinstall
```

The wallet consumes the package through a `link:` dependency and its built `dist/`. Jest maps `@miden/hd-key` to `src/` so unit tests need no build step. Do not run `yarn install` inside the package; its dependencies resolve from the root `node_modules`.
