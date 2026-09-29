import { useMemo } from 'react';

import { usePageActive } from 'app/layouts/page-active';
import { fetchEarnPositions, getEarnDepositEvmAddresses } from 'lib/epoch';
import { useAccount } from 'lib/miden/front';
import { useRetryableSWR } from 'lib/swr';
import { useLastData } from 'lib/swr/last-data';

import { buildEarnSummary, loadingEarnSummary, mapEarnPosition, mapEarnVault } from './earn-mapping';
import type { EarnPosition, EarnSummary, EarnVault } from './types';

/**
 * What a detail screen for one earn item (a vault or a position) has: `loadFailed` when the last load
 * errored, `pending` while the item is missing and a load may yet bring it. A failed load is never
 * pending, so a screen shows its error rather than an empty page.
 */
export function earnItemLoadState(
  found: unknown,
  { isLoading, error }: { isLoading: boolean; error?: string }
): { loadFailed: boolean; pending: boolean } {
  const loadFailed = Boolean(error);
  return { loadFailed, pending: isLoading && !found && !loadFailed };
}

/**
 * Live earn positions for the current account, mapped to the earn-flow display
 * shapes. Owners are the union of past earn-deposit rows (survives address
 * changes) and the wallet-derived `evmAddress` (survives reinstall/restore
 * before any local activity exists). First load yields an empty list + a
 * summary with no figures yet. A failed refresh keeps the last data this key loaded (SWR
 * keeps a key's data across its own revalidations); `keepPreviousData` is NOT
 * set, because the key carries the account and it would serve the previous
 * account's positions after a switch. The 30s refresh stops while the page is off screen (another tab, a page
 * above it, or another Home page).
 */
export function useEarnPositions(): {
  summary: EarnSummary;
  positions: EarnPosition[];
  vaults: EarnVault[];
  /**
   * No data (live or kept) and no error, including while the page is covered. A retry after a failure keeps the
   * error and reports false.
   */
  isLoading: boolean;
  /** Any failure: the request's, or one owner's positions. What the positions surfaces report. */
  error?: string;
  /**
   * The vault read's failure: the request's, or every owner failing so no vault loaded. A read with any
   * vault is not failed, though one owner's positions may be.
   */
  loadError?: string;
  /**
   * Re-fetch now (backs the error-state Retry), unless a read is already out: that read brings the result, and a
   * second would spend the service's 10-per-minute limit.
   */
  refetch: () => void;
} {
  const account = useAccount();
  const onScreen = usePageActive();

  // A covered page holds a null key, never `isPaused`: SWR sends a shared key's Retry and error retry to its first
  // subscriber, and a paused one swallows them. `revalidateIfStale` reads a returning key again, deduped for 3 s.
  const key = ['earn-positions', account.publicKey, account.evmAddress];
  const {
    data: liveData,
    error: swrError,
    isValidating,
    mutate
  } = useRetryableSWR(
    onScreen ? key : null,
    async () => {
      const fromActivity = await getEarnDepositEvmAddresses(account.publicKey);
      const walletAddress = account.evmAddress?.toLowerCase();
      const owners = [...new Set(walletAddress ? [...fromActivity, walletAddress] : fromActivity)];
      return fetchEarnPositions({ accountId: account.publicKey, owners });
    },
    {
      revalidateOnMount: true,
      revalidateIfStale: true,
      // The Epoch positions service allows 10 requests per minute, and each tick sends one request for each owner.
      refreshInterval: 30_000,
      revalidateOnFocus: false,
      dedupingInterval: 3_000
    }
  );
  const data = useLastData(key, onScreen, liveData);
  // No data (live or kept) and no error: a page mounted covered reads as loading, not empty.
  const isLoading = data === undefined && !swrError;

  return useMemo(() => {
    // Owner queries never reject: a full outage resolves with only errors and no vaults, which is a failed
    // vault load too. Any vault makes the per-owner errors positions-only.
    const outage = data && data.vaults.length === 0 ? data.errors[0]?.error : undefined;
    const loadError = swrError ? (swrError instanceof Error ? swrError.message : String(swrError)) : outage;
    return {
      positions: (data?.positions ?? []).map(mapEarnPosition),
      vaults: (data?.vaults ?? []).map(mapEarnVault),
      summary: data ? buildEarnSummary(data.positions) : loadingEarnSummary(),
      isLoading,
      // Surface a load failure so the UI can show "couldn't load - retry" instead
      // of a misleading empty "$0 / no positions". Prefer the positions service's
      // own per-owner error; fall back to an SWR-level throw (e.g. the owner
      // lookup failed) so no failure mode reads as "you have nothing".
      error: data?.errors[0]?.error ?? loadError,
      loadError,
      refetch: () => {
        // Every positions request is bounded, so a read out always settles and frees Retry.
        if (!isValidating) void mutate();
      }
    };
  }, [data, isLoading, swrError, isValidating, mutate]);
}
