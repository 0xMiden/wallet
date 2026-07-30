import { useMemo } from 'react';

import { fetchEarnPositions, getEarnDepositEvmAddresses } from 'lib/epoch';
import { useAccount } from 'lib/miden/front';
import { useRetryableSWR } from 'lib/swr';

import { buildEarnSummary, mapEarnPosition, mapEarnVault } from './earn-mapping';
import type { EarnPosition, EarnSummary, EarnVault } from './types';

/**
 * Live earn positions for the current account, mapped to the earn-flow display
 * shapes. Owners are the union of past earn-deposit rows (survives address
 * changes) and the wallet-derived `evmAddress` (survives reinstall/restore
 * before any local activity exists). First load yields an empty list + an
 * empty-state summary; `keepPreviousData` holds last-good data across the
 * 10s refresh.
 */
export function useEarnPositions(): {
  summary: EarnSummary;
  positions: EarnPosition[];
  vaults: EarnVault[];
  isLoading: boolean;
  error?: string;
} {
  const account = useAccount();

  const { data, isLoading } = useRetryableSWR(
    ['earn-positions', account.publicKey, account.evmAddress],
    async () => {
      const fromActivity = await getEarnDepositEvmAddresses(account.publicKey);
      const walletAddress = account.evmAddress?.toLowerCase();
      const owners = [...new Set(walletAddress ? [...fromActivity, walletAddress] : fromActivity)];
      return fetchEarnPositions({ accountId: account.publicKey, owners });
    },
    { revalidateOnMount: true, refreshInterval: 10_000, dedupingInterval: 3_000, keepPreviousData: true }
  );

  return useMemo(
    () => ({
      positions: (data?.positions ?? []).map(mapEarnPosition),
      vaults: (data?.vaults ?? []).map(mapEarnVault),
      summary: buildEarnSummary(data?.positions ?? []),
      isLoading,
      error: data?.errors[0]?.error
    }),
    [data, isLoading]
  );
}
