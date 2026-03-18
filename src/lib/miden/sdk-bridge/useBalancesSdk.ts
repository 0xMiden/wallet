import { useCallback, useMemo } from 'react';

import { useAccount } from '@miden-sdk/react';
import type { AssetBalance } from '@miden-sdk/react';

import { MidenTokens, TOKEN_MAPPING } from 'lib/miden-chain/constants';
import { TokenBalanceData } from 'lib/miden/front/balance';
import { AssetMetadata, MIDEN_METADATA, DEFAULT_TOKEN_METADATA } from 'lib/miden/metadata';

const DEFAULT_MIDEN_FAUCET_ID = TOKEN_MAPPING[MidenTokens.Miden].faucetId;

/**
 * Adapter hook that bridges the SDK's `useAccount()` assets
 * to the wallet's `TokenBalanceData[]` format.
 *
 * Replaces the old `fetchBalances` + WASM client lock + polling approach
 * with the SDK's reactive account data that refreshes after each sync.
 */
export function useBalancesSdk(
  accountId: string,
  tokenMetadatas: Record<string, AssetMetadata>
): {
  data: TokenBalanceData[];
  mutate: () => Promise<void>;
  isLoading: boolean;
  isValidating: boolean;
} {
  const { assets, isLoading, refetch } = useAccount(accountId);

  const data = useMemo(() => {
    if (!assets || assets.length === 0) {
      return [makeZeroMiden()];
    }

    const balances: TokenBalanceData[] = [];
    let hasMiden = false;

    for (const asset of assets) {
      const tokenId = asset.assetId;
      const isMiden = tokenId === DEFAULT_MIDEN_FAUCET_ID;

      if (isMiden) hasMiden = true;

      const metadata = isMiden
        ? MIDEN_METADATA
        : (tokenMetadatas[tokenId] ?? sdkMetadataToWallet(asset) ?? DEFAULT_TOKEN_METADATA);

      const decimals = metadata.decimals;
      const balance = Number(asset.amount) / 10 ** decimals;

      balances.push({
        tokenId,
        tokenSlug: metadata.symbol,
        metadata,
        fiatPrice: 1,
        balance,
        change24h: 0
      });
    }

    if (!hasMiden) {
      balances.push(makeZeroMiden());
    }

    return balances;
  }, [assets, tokenMetadatas]);

  const mutate = useCallback(async () => {
    await refetch();
  }, [refetch]);

  return {
    data,
    mutate,
    isLoading,
    isValidating: isLoading
  };
}

function makeZeroMiden(): TokenBalanceData {
  return {
    tokenId: DEFAULT_MIDEN_FAUCET_ID,
    tokenSlug: 'MIDEN',
    metadata: MIDEN_METADATA,
    fiatPrice: 1,
    balance: 0
  };
}

function sdkMetadataToWallet(asset: AssetBalance): AssetMetadata | null {
  if (!asset.symbol || asset.decimals == null) return null;
  return {
    decimals: asset.decimals,
    symbol: asset.symbol,
    name: asset.symbol
  };
}
