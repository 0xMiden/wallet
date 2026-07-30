/**
 * BIP-39 / BIP-44 HD seed derivation for Miden accounts.
 *
 * Extracted verbatim from `lib/miden/back/vault.ts` so the derivation can be
 * shared with frontend-only callers (the guardian auto-detect probe) without
 * dragging the whole vault module graph — service-worker storage, passworder,
 * the WASM client — into the popup bundle. `vault.ts` imports these back, so
 * there is exactly one implementation of the derivation.
 */
import { derivePath } from '@demox-labs/aleo-hd-key';
import * as Bip39 from 'bip39';

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

export function getMainDerivationPath(walletType: WalletType, accIndex: number) {
  return `m/44'/0'/${walletTypeIndex(walletType)}'/${accIndex}'`;
}

export function deriveClientSeed(walletType: WalletType, mnemonic: string, hdAccIndex: number) {
  const seed = Bip39.mnemonicToSeedSync(mnemonic);
  const path = getMainDerivationPath(walletType, hdAccIndex);
  const { seed: childSeed } = derivePath(path, seed.toString('hex'));
  return new Uint8Array(childSeed);
}

/**
 * Build a `deriveColdSeed(hdIndex)` closure that memoizes the expensive part —
 * `Bip39.mnemonicToSeedSync` runs 2048 rounds of PBKDF2-HMAC-SHA512 — across
 * every index it is asked for. Callers that walk a range of HD indices (guardian
 * recovery, the guardian discovery probe) would otherwise pay that cost once per
 * index, which is very visible when it happens on the UI thread.
 *
 * Byte-for-byte equivalent to calling {@link deriveClientSeed} per index.
 */
export function makeColdSeedDeriver(
  mnemonic: string,
  walletType: WalletType = WalletType.Guardian
): (hdIndex: number) => Uint8Array {
  let masterSeedHex: string | null = null;
  return (hdIndex: number) => {
    if (masterSeedHex === null) {
      masterSeedHex = Bip39.mnemonicToSeedSync(mnemonic).toString('hex');
    }
    const { seed: childSeed } = derivePath(getMainDerivationPath(walletType, hdIndex), masterSeedHex);
    return new Uint8Array(childSeed);
  };
}
