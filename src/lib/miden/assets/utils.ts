import { useMemo, useState } from 'react';

import BigNumber from 'bignumber.js';

import { MidenTokens, TOKEN_MAPPING } from 'lib/miden-chain/constants';
import { fetchFromStorage, searchAssets, useAllTokensBaseMetadata } from 'lib/miden/front';

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

export async function getFaucetIdSetting() {
  const faucetId = (await fetchFromStorage(FAUCET_ID_STORAGE_KEY)) as string | null;
  return faucetId ?? TOKEN_MAPPING[MidenTokens.Miden].faucetId;
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
