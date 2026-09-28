/**
 * BIP-39 / SLIP-0010 HD seed derivation for Miden accounts.
 *
 * The derivation is in `@miden/hd-key`. This module maps the wallet enums
 * (`WalletType`, `AuthScheme`, `KeyDerivation`) to the numeric path levels
 * the package takes. Thus one place decides which path an account uses.
 * Frontend-only callers (the guardian auto-detect probe) import this module
 * without the vault module graph; `vault.ts` imports it too.
 */
import { deriveMidenAccountSeed, midenDerivationPath, mnemonicToSeed } from '@miden/hd-key';
import type { AuthScheme, KeyDerivation } from 'lib/shared/types';
import { WalletType } from 'screens/onboarding/types';

// Maps a wallet type to its BIP-44 namespace index. hdIndex/accIndex is allocated
// PER privacy bucket (public vs non-public), so distinct wallet types can share
// an index; both the Miden and the EVM derivation must namespace by this to keep
// their keys distinct across wallet types.
export function walletTypeIndex(walletType: WalletType): number {
  switch (walletType) {
    case WalletType.OnChain:
      return 0;
    case WalletType.OffChain:
      return 1;
    case WalletType.Guardian:
      return 2;
    default:
      throw new Error('Invalid wallet type');
  }
}

// Maps an auth scheme to the `v1` scheme path level, so a Falcon key and an
// ECDSA key at the same index never share a seed. Unused by `legacy`.
export function authSchemeIndex(authScheme: AuthScheme): number {
  switch (authScheme) {
    case 'falcon':
      return 0;
    case 'ecdsa':
      return 1;
    default:
      throw new Error('Invalid auth scheme');
  }
}

export interface ClientSeedSpec {
  keyDerivation: KeyDerivation;
  walletType: WalletType;
  authScheme: AuthScheme;
  hdIndex: number;
}

function toDerivationSpec(spec: ClientSeedSpec) {
  return {
    keyDerivation: spec.keyDerivation,
    walletTypeIndex: walletTypeIndex(spec.walletType),
    authSchemeIndex: authSchemeIndex(spec.authScheme),
    accountIndex: spec.hdIndex
  };
}

export function getMainDerivationPath(spec: ClientSeedSpec): string {
  return midenDerivationPath(toDerivationSpec(spec));
}

export function deriveClientSeed(mnemonic: string, spec: ClientSeedSpec): Uint8Array {
  const masterSeed = mnemonicToSeed(mnemonic);
  try {
    return deriveMidenAccountSeed(masterSeed, toDerivationSpec(spec));
  } finally {
    masterSeed.fill(0);
  }
}

/**
 * Build a `deriveSeed(spec)` closure that computes the master seed once.
 * `mnemonicToSeed` runs 2048 rounds of PBKDF2-HMAC-SHA512, which is slow on
 * the UI thread. Callers that derive under several schemes or walk a range of
 * HD indices (the restore probes, guardian recovery, the guardian discovery
 * probe) pay that cost once instead of once per derivation.
 *
 * The output is equal to {@link deriveClientSeed} for the same spec.
 */
export function makeSeedDeriver(mnemonic: string): (spec: ClientSeedSpec) => Uint8Array {
  let masterSeed: Uint8Array | null = null;
  return (spec: ClientSeedSpec) => {
    if (masterSeed === null) {
      masterSeed = mnemonicToSeed(mnemonic);
    }
    return deriveMidenAccountSeed(masterSeed, toDerivationSpec(spec));
  };
}

/** Guardian cold keys are always ECDSA under the 3-key model. */
const COLD_KEY_AUTH_SCHEME: AuthScheme = 'ecdsa';

/**
 * Build a `deriveColdSeed(hdIndex, keyDerivation)` closure for Guardian cold
 * keys. One closure serves a `v1` scan and a `legacy` scan, and computes the
 * master seed once (see {@link makeSeedDeriver}).
 */
export function makeColdSeedDeriver(
  mnemonic: string,
  walletType: WalletType = WalletType.Guardian
): (hdIndex: number, keyDerivation: KeyDerivation) => Uint8Array {
  const deriveSeed = makeSeedDeriver(mnemonic);
  return (hdIndex: number, keyDerivation: KeyDerivation) =>
    deriveSeed({ keyDerivation, walletType, authScheme: COLD_KEY_AUTH_SCHEME, hdIndex });
}
