/**
 * Miden account seed derivation policy.
 *
 * Two schemes exist. Do not change either scheme. The derivation decides which
 * accounts a seed phrase recovers, so a change makes existing accounts
 * unreachable.
 *
 * | Scheme   | HMAC label       | Path                                                        |
 * |----------|------------------|-------------------------------------------------------------|
 * | `legacy` | `bls12_377 seed` | `m/44'/0'/<walletType>'/<accountIndex>'`                    |
 * | `v1`     | `miden seed`     | `m/44'/5063758'/<walletType>'/<authScheme>'/<accountIndex>'` |
 *
 * `5063758` is the SLIP-44 coin type registered for Miden. The `authScheme`
 * level gives a Falcon key and an ECDSA key at the same index different
 * seeds. Thus two key types never share a secret (issue #918).
 */
import { deriveHardenedPath } from './slip10';

export type KeyDerivation = 'legacy' | 'v1';

export const LEGACY_SEED_LABEL = 'bls12_377 seed';
export const MIDEN_SEED_LABEL = 'miden seed';
/** SLIP-44 coin type for Miden. */
export const MIDEN_COIN_TYPE = 5063758;
export const BIP44_PURPOSE = 44;

export interface MidenDerivationSpec {
  keyDerivation: KeyDerivation;
  /** 0 = on-chain, 1 = off-chain, 2 = guardian. The wallet maps its wallet type to this. */
  walletTypeIndex: number;
  /** 0 = falcon, 1 = ecdsa. Not used by the `legacy` scheme. */
  authSchemeIndex: number;
  /** The wallet's `hdIndex`. */
  accountIndex: number;
}

export function seedLabel(keyDerivation: KeyDerivation): string {
  switch (keyDerivation) {
    case 'legacy':
      return LEGACY_SEED_LABEL;
    case 'v1':
      return MIDEN_SEED_LABEL;
  }
}

export function midenDerivationPath(spec: MidenDerivationSpec): string {
  switch (spec.keyDerivation) {
    case 'legacy':
      return `m/${BIP44_PURPOSE}'/0'/${spec.walletTypeIndex}'/${spec.accountIndex}'`;
    case 'v1':
      return `m/${BIP44_PURPOSE}'/${MIDEN_COIN_TYPE}'/${spec.walletTypeIndex}'/${spec.authSchemeIndex}'/${spec.accountIndex}'`;
  }
}

/**
 * Derive the 32-byte account seed for `spec` from the 64-byte BIP-39 master
 * seed. A negative `accountIndex` gives an invalid path and throws.
 */
export function deriveMidenAccountSeed(masterSeed: Uint8Array, spec: MidenDerivationSpec): Uint8Array {
  const node = deriveHardenedPath(masterSeed, seedLabel(spec.keyDerivation), midenDerivationPath(spec));
  node.chainCode.fill(0);
  return node.secret;
}
