import { useEffect, useMemo } from 'react';

import { useSWRConfig } from 'swr';

import { usePageActive } from 'app/layouts/page-active';
import { fetchEarnPositions, getEarnDepositEvmAddresses } from 'lib/epoch';
import { useAccount } from 'lib/miden/front';
import { useRetryableSWR } from 'lib/swr';
import { useLastData } from 'lib/swr/last-data';

import { buildEarnSummary, loadingEarnSummary, mapEarnPosition, mapEarnVault } from './earn-mapping';
import type { EarnPosition, EarnSummary, EarnVault } from './types';

// The poll, the spacing of the reads a page starts on its own, and the error retry: the Epoch positions service
// allows 10 requests per minute, and each read sends one request for each owner.
const READ_INTERVAL_MS = 30_000;

interface KeyReads {
  /** When the key's last read began, whoever started it. */
  at?: number;
  /** Each on-screen hook's re-arm, called as a read begins, so its next automatic read waits 30 s after it. */
  rearms: Set<() => void>;
}
// Per SWR cache, so a test's fresh cache starts with none.
const keyReads = new WeakMap<object, Map<string, KeyReads>>();

function readsOf(cache: object, id: string): KeyReads {
  const byKey = keyReads.get(cache) ?? new Map<string, KeyReads>();
  keyReads.set(cache, byKey);
  const reads = byKey.get(id) ?? { rearms: new Set<() => void>() };
  byKey.set(id, reads);
  return reads;
}

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
 * account's positions after a switch. The hook, not SWR, times every read it starts on its own from when the key's
 * last read began, whoever started it: the poll and the retry of a failed read fire 30 s after it, and a return or a
 * mount reads only once it is 30 s old (a key with no data always reads). Nothing is read on a timer while the page
 * is off screen (another tab, a page above it, or another Home page), the document is hidden or the device is
 * offline, and reconnect and focus never read. A Retry is the one read outside that, and the next poll waits 30 s
 * after it too.
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
  const { cache } = useSWRConfig();

  // A covered page holds a null key, never `isPaused`: SWR sends a shared key's Retry and timed read to its first
  // subscriber, and a paused one swallows them. SWR reads `revalidateIfStale` only when the key comes back or the hook
  // mounts, so a key with data reads again then only once its last read is 30 s old.
  const key = ['earn-positions', account.publicKey, account.evmAddress];
  const id = JSON.stringify(key);
  const lastRead = keyReads.get(cache)?.get(id)?.at;
  const due = lastRead === undefined || Date.now() - lastRead >= READ_INTERVAL_MS;
  const {
    data: liveData,
    error: swrError,
    isValidating,
    mutate
  } = useRetryableSWR(
    onScreen ? key : null,
    async () => {
      const reads = readsOf(cache, id);
      reads.at = Date.now();
      reads.rearms.forEach(rearm => rearm());
      const fromActivity = await getEarnDepositEvmAddresses(account.publicKey);
      const walletAddress = account.evmAddress?.toLowerCase();
      const owners = [...new Set(walletAddress ? [...fromActivity, walletAddress] : fromActivity)];
      return fetchEarnPositions({ accountId: account.publicKey, owners });
    },
    {
      revalidateIfStale: due,
      // SWR's poll and error retry run on their own clocks, blind to a Retry or another page's read: the timer below
      // starts those reads instead.
      refreshInterval: 0,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 3_000,
      shouldRetryOnError: false
    }
  );

  // One timer per on-screen hook, for its current key: it fires 30 s after the key's last read began, re-arming from
  // every read that begins meanwhile. A read that fails is retried by it too, which SWR's poll never does while the
  // key holds an error.
  useEffect(() => {
    if (!onScreen) return;
    const reads = readsOf(cache, id);
    const armedAt = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = () => {
      // Armed first: a read that begins re-arms from its own start, and one that does not leaves this in place.
      timer = setTimeout(fire, READ_INTERVAL_MS);
      if (document.visibilityState === 'hidden' || navigator.onLine === false) return;
      void mutate();
    };
    const rearm = () => {
      clearTimeout(timer);
      timer = setTimeout(fire, Math.max(0, (reads.at ?? armedAt) + READ_INTERVAL_MS - Date.now()));
    };
    reads.rearms.add(rearm);
    rearm();
    return () => {
      clearTimeout(timer);
      reads.rearms.delete(rearm);
    };
  }, [onScreen, cache, id, mutate]);

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
