import { useMemo, useState } from 'react';

import BigNumber from 'bignumber.js';

import { getTokensBaseMetadata, putToStorage, searchAssets, useAllTokensBaseMetadata } from 'lib/miden/front';
import { getNativeDisplayMetadata } from 'lib/miden/metadata/native';
import { getNativeAssetId } from 'lib/miden-chain/native-asset';

import { FAUCET_ID_STORAGE_KEY } from './constants';
import { getFaucetIdSetting } from './faucet-id-setting';
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

export { getFaucetIdSetting } from './faucet-id-setting';

export async function setFaucetIdSetting(faucetId: string): Promise<void> {
  // Persist through the SAME platform storage adapter `getFaucetIdSetting`
  // reads from (`fetchFromStorage`). The previous `localStorage.setItem` wrote
  // to raw localStorage, which the extension's `fetchFromStorage` (chrome /
  // prefixed store) never reads - so the Settings write reported success but
  // never took effect (#590).
  await putToStorage(FAUCET_ID_STORAGE_KEY, faucetId);
}

export const getTokenId = async (faucetId: string) => {
  const nativeId = await getNativeAssetId().catch(() => null);
  if (faucetId === nativeId) return (await getNativeDisplayMetadata()).symbol;
  if (await isMidenFaucet(faucetId)) return (await getTokensBaseMetadata(faucetId))?.symbol ?? 'Unknown';
  return 'Unknown';
};

export const isMidenFaucet = async (faucetId: string) => {
  return faucetId === (await getFaucetIdSetting());
};
