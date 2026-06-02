import { useMemo, useState } from 'react';

import BigNumber from 'bignumber.js';

import { fetchFromStorage, searchAssets, useAllTokensBaseMetadata } from 'lib/miden/front';
import { getNativeAssetId } from 'lib/miden-chain/native-asset';

import { FAUCET_ID_STORAGE_KEY } from './constants';
import { Asset, Token, FA2Token } from './types';

export async function toTransferParams(assetSlug: string, toPublicKey: string, amount: BigNumber.Value) {
  const asset = assetSlug;

  if (isMidenAsset(asset)) {
    return {
      to: toPublicKey,
      amount: amount as any
    };
  } else {
    return {
      to: 'not a public key',
      amount: 420
    };
  }
}

export function toTokenSlug(contract: string, id: BigNumber.Value = 0) {
  return contract === 'aleo' ? 'aleo' : `${contract}_${new BigNumber(id).toFixed()}`;
}

export function isFA2Token(token: Token): token is FA2Token {
  return typeof token.id !== 'undefined';
}

export function isMidenAsset(asset: Asset | string): asset is 'miden' {
  return asset === 'miden';
}

export function isTokenAsset(asset: Asset): asset is Token {
  return asset !== 'miden';
}

export function useFilteredAssets(assets: { slug: string; id: string }[]) {
  const allTokensBaseMetadata = useAllTokensBaseMetadata();

  const [searchValue, setSearchValue] = useState('');
  const [tokenId, setTokenId] = useState<number>();
  const [searchValueDebounced] = useDebounce(tokenId ? toTokenSlug(searchValue, tokenId) : searchValue, 300);

  const filteredAssets = useMemo(
    () => searchAssets(searchValueDebounced, assets, allTokensBaseMetadata),
    [searchValueDebounced, assets, allTokensBaseMetadata]
  );

  return {
    filteredAssets,
    searchValue,
    setSearchValue,
    tokenId,
    setTokenId
  };
}

function useDebounce(_arg0: string, _arg1: number): [any] {
  throw new Error('Function not implemented.');
}

/**
 * Returns the faucet ID the wallet should treat as the native asset, or `null`
 * if discovery hasn't completed yet (first install + offline, or a transient
 * RPC failure).
 *
 * Resolution order:
 *   1. user override (dev-mode escape hatch, written from EditMidenFaucetId)
 *   2. discovered native asset ID (BlockHeader.nativeAssetId())
 *   3. `null` — callers must tolerate unknown-native-asset by falling through
 *      comparisons to "not MIDEN" so the rest of the UI still works
 *
 * No hardcoded fallback by design — if we guessed wrong, MIDEN-tagged UI
 * would render under the wrong token ID until discovery corrected it. Better
 * to show no MIDEN branding than to show it under a stale ID.
 */
export async function getFaucetIdSetting(): Promise<string | null> {
  const override = (await fetchFromStorage(FAUCET_ID_STORAGE_KEY)) as string | null;
  if (override) return override;
  try {
    return await getNativeAssetId();
  } catch (err) {
    console.warn('getFaucetIdSetting: native asset discovery failed', err);
    return null;
  }
}

export function setFaucetIdSetting(faucetId: string) {
  localStorage.setItem(FAUCET_ID_STORAGE_KEY, faucetId);
}

export const getTokenId = async (faucetId: string) => {
  const isMiden = await isMidenFaucet(faucetId);
  return isMiden ? 'MIDEN' : 'Unknown';
};

export const isMidenFaucet = async (faucetId: string) => {
  return faucetId === (await getFaucetIdSetting());
};
