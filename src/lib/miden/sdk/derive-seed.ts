/**
 * BIP-39 / SLIP-0010 HD seed derivation for Miden accounts.
 *
 * The derivation itself lives in `@miden/hd-key`. This module maps the
 * wallet's enums (`WalletType`, `AuthScheme`, `KeyDerivation`) to the numeric
 * path levels the package takes, so there is exactly one place that decides
 * which path an account uses. It is shared with frontend-only callers (the
 * guardian auto-detect probe) without dragging the vault module graph into the
 * popup bundle; `vault.ts` imports these back.
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
 * Build a `deriveSeed(spec)` closure that memoizes the expensive part —
 * `mnemonicToSeed` runs 2048 rounds of PBKDF2-HMAC-SHA512 — across every spec
 * it is asked for. Callers that derive under several schemes or walk a range
 * of HD indices (the restore probes, guardian recovery, the guardian discovery
 * probe) would otherwise pay that cost once per derivation, which is very
 * visible when it happens on the UI thread.
 *
 * Byte-for-byte equivalent to calling {@link deriveClientSeed} per spec.
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
 * keys. One closure serves both a `v1` scan and a `legacy` scan, and pays the
 * PBKDF2 cost once (see {@link makeSeedDeriver}).
 */
export function makeColdSeedDeriver(
  mnemonic: string,
  walletType: WalletType = WalletType.Guardian
): (hdIndex: number, keyDerivation: KeyDerivation) => Uint8Array {
  const deriveSeed = makeSeedDeriver(mnemonic);
  return (hdIndex: number, keyDerivation: KeyDerivation) =>
    deriveSeed({ keyDerivation, walletType, authScheme: COLD_KEY_AUTH_SCHEME, hdIndex });
}
