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
 * empty-state summary. A failed refresh keeps the last data this key loaded (SWR
 * keeps a key's data across its own revalidations); `keepPreviousData` is NOT
 * set, because the key carries the account and it would serve the previous
 * account's positions after a switch.
 */
export function useEarnPositions(): {
  summary: EarnSummary;
  positions: EarnPosition[];
  vaults: EarnVault[];
  isLoading: boolean;
  error?: string;
  /** Force an immediate re-fetch (backs the error-state Retry). */
  refetch: () => void;
} {
  const account = useAccount();

  const {
    data,
    isLoading,
    error: swrError,
    mutate
  } = useRetryableSWR(
    ['earn-positions', account.publicKey, account.evmAddress],
    async () => {
      const fromActivity = await getEarnDepositEvmAddresses(account.publicKey);
      const walletAddress = account.evmAddress?.toLowerCase();
      const owners = [...new Set(walletAddress ? [...fromActivity, walletAddress] : fromActivity)];
      return fetchEarnPositions({ accountId: account.publicKey, owners });
    },
    { revalidateOnMount: true, refreshInterval: 10_000, dedupingInterval: 3_000 }
  );

  return useMemo(
    () => ({
      positions: (data?.positions ?? []).map(mapEarnPosition),
      vaults: (data?.vaults ?? []).map(mapEarnVault),
      summary: buildEarnSummary(data?.positions ?? []),
      isLoading,
      // Surface a load failure so the UI can show "couldn't load — retry" instead
      // of a misleading empty "$0 / no positions". Prefer the positions service's
      // own per-owner error; fall back to an SWR-level throw (e.g. the owner
      // lookup failed) so no failure mode reads as "you have nothing".
      error:
        data?.errors[0]?.error ??
        (swrError ? (swrError instanceof Error ? swrError.message : String(swrError)) : undefined),
      refetch: () => {
        void mutate();
      }
    }),
    [data, isLoading, swrError, mutate]
  );
}
