import { useEffect, useMemo, useState } from 'react';

import { useSWRConfig } from 'swr';

import { usePageActive } from 'app/layouts/page-active';
import {
  carryForward,
  EARN_CATALOG_ERROR_OWNER,
  type EarnPositionsResult,
  fetchEarnPositions,
  getEarnDepositEvmAddresses
} from 'lib/epoch';
import { compareAccountIds } from 'lib/miden/activity/utils';
import type { IEarnDepositExtraInputs } from 'lib/miden/db/types';
import { useAccount } from 'lib/miden/front';
import * as Repo from 'lib/miden/repo';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import { BridgeConfigUnavailableError, selectEarnMarket, selectEarnVaults } from 'lib/remote-config/values';
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

// The failure a read would report for a config that names no positions host or Earn market, as the getters phrase it,
// named from the snapshot the hook keys on: the getters read the realm's, which can differ.
function unconfiguredError(positionsUrl: string | undefined, marketUid: string | undefined): string | undefined {
  if (!positionsUrl) return new BridgeConfigUnavailableError('epoch.positionsUrl').message;
  if (!marketUid) return new BridgeConfigUnavailableError('Earn market').message;
  return undefined;
}

/** The text of a failure that a read rejected with. */
const errorText = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));

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
  /**
   * Each `stale` when the latest read did not load it: the read failed and SWR kept an earlier read's data, or its
   * owner failed and it was carried from an earlier read. A stale position arms no withdrawal.
   */
  positions: EarnPosition[];
  vaults: EarnVault[];
  /**
   * No data and no error, live or kept, including while the page is covered. A retry after a failure keeps the
   * error and reports false.
   */
  isLoading: boolean;
  /** Any failure: the request's, one owner's positions, or the vault catalogue's. What the positions surfaces report. */
  error?: string;
  /**
   * The failure of the vault read: the request's, or the vault catalogue's (reported under EARN_CATALOG_ERROR_OWNER).
   * What the vault surfaces report. Vaults carried from an earlier load may show beside it. A failed owner does not
   * set it: the catalogue does not come from the owners, so their failure says nothing about a vault.
   */
  loadError?: string;
  /**
   * The network configures no Earn at all: its document (mainnet's) names no positions host or no Epoch route.
   * `error` still names what is missing, but no read or retry can succeed, so the page says Earn is not on this
   * network. A market read that failed is a configured Earn that is down, and is not this; nor is a snapshot with no
   * accepted document, which says nothing about the network and keeps its load error and Retry.
   */
  notOnNetwork: boolean;
  /**
   * Re-fetch now (backs the error-state Retry), unless a read is already out: that read brings the result, and a
   * second would spend the service's 10-per-minute limit.
   */
  refetch: () => void;
} {
  const account = useAccount();
  const onScreen = usePageActive();
  const { cache } = useSWRConfig();
  const config = useBridgeConfigSnapshot();
  const positionsUrl = config.config?.['bridge-providers'].epoch.positionsUrl;
  const marketUid = selectEarnMarket(config)?.marketUid;
  const listed = selectEarnVaults(config);
  // Only a loading snapshot is a wait: a loaded one that names neither settles at once, as the read would have failed.
  const unconfigured = config.status === 'ready' ? unconfiguredError(positionsUrl, marketUid) : undefined;
  const notOnNetwork =
    config.status === 'ready' &&
    config.config !== null &&
    (!positionsUrl || config.derived?.epoch.market.state === 'skipped');

  // A covered page holds a null key, never `isPaused`: SWR sends a shared key's Retry and timed read to its first
  // subscriber, and a paused one swallows them. SWR reads `revalidateIfStale` only when the key comes back or the hook
  // mounts, so a key with data reads again then only once its last read is 30 s old. The read goes to the configured
  // host and market, so the key names them: none reads nothing, and a config that lands or moves them reads anew.
  const key = ['earn-positions', account.publicKey, account.evmAddress, positionsUrl, marketUid];
  const id = JSON.stringify(key);
  const lastRead = keyReads.get(cache)?.get(id)?.at;
  const due = lastRead === undefined || Date.now() - lastRead >= READ_INTERVAL_MS;
  const {
    data: liveData,
    error: swrError,
    isValidating,
    mutate
  } = useRetryableSWR(
    onScreen && positionsUrl && marketUid ? key : null,
    async (): Promise<EarnPositionsResult> => {
      const reads = readsOf(cache, id);
      reads.at = Date.now();
      reads.rearms.forEach(rearm => rearm());
      const fromActivity = await getEarnDepositEvmAddresses(account.publicKey);
      const walletAddress = account.evmAddress?.toLowerCase();
      const owners = [...new Set(walletAddress ? [...fromActivity, walletAddress] : fromActivity)];
      // An owner this read fails for keeps what it last loaded: `data` is what this render shows for this key, and
      // SWR calls the fetcher of the last render.
      return carryForward(data, await fetchEarnPositions({ accountId: account.publicKey, owners }));
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

  // A covered page keeps its key's last data and error together, so a failure notice stays while the page slides out
  // and while it is covered; another key keeps neither.
  const shown = useLastData<{ data: EarnPositionsResult | undefined; error: unknown }>(
    key,
    onScreen,
    liveData !== undefined || swrError !== undefined ? { data: liveData, error: swrError } : undefined
  );
  const data = shown?.data;
  const readError = shown?.error ?? unconfigured;
  // No data and no error (live or kept): a page mounted covered reads as loading, not empty.
  const isLoading = data === undefined && !readError;

  // A position the catalogue and the document both leave without a protocol takes the newest local
  // earn-deposit for this account, owner, and market. The read is the transactions table, so it does
  // not ask the positions service.
  const [depositProtocols, setDepositProtocols] = useState(() => new Map<string, '1delta' | 'dummy-lending'>());
  useEffect(() => {
    const missing = (data?.positions ?? []).some(
      position => mapEarnPosition(position, listed).epochProtocol === undefined
    );
    if (!missing) {
      setDepositProtocols(current => (current.size === 0 ? current : new Map()));
      return;
    }
    // Drop a previous account's protocols before the read returns, so they cannot label this account's position.
    setDepositProtocols(current => (current.size === 0 ? current : new Map()));
    let cancelled = false;
    void (async () => {
      const rows = await Repo.transactions.filter(tx => tx.type === 'earn-deposit').toArray();
      if (cancelled) return;
      const found = new Map<string, '1delta' | 'dummy-lending'>();
      const newestAt = new Map<string, number>();
      for (const tx of rows) {
        if (tx.type !== 'earn-deposit' || tx.restoredFromBackup) continue;
        if (!compareAccountIds(tx.accountId, account.publicKey)) continue;
        const extra: IEarnDepositExtraInputs | undefined = tx.extraInputs;
        if (!extra) continue;
        const protocol = extra.protocol;
        if (protocol !== '1delta' && protocol !== 'dummy-lending') continue;
        const owner = extra.evmRecipient.trim().toLowerCase();
        const marketUid = extra.marketUid.trim().toLowerCase();
        if (!owner || !marketUid) continue;
        const key = `${owner}:${marketUid}`;
        const at = tx.initiatedAt;
        const previous = newestAt.get(key);
        if (previous !== undefined && previous >= at) continue;
        newestAt.set(key, at);
        found.set(key, protocol);
      }
      if (!cancelled) setDepositProtocols(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [account.publicKey, data, listed]);

  return useMemo(() => {
    // Owner and catalogue queries never reject: each failure resolves in `errors`, while what loaded before may still
    // show. An owner's failure is positions-only; the catalogue's failure is the vaults'.
    const failedOwners = new Set(data?.errors.map(({ owner }) => owner));
    const catalogError = data?.errors.find(({ owner }) => owner === EARN_CATALOG_ERROR_OWNER)?.error;
    const loadError = readError ? errorText(readError) : catalogError;
    // The document decides which vaults show, in which order and under which entry, also for a vault carried from an
    // earlier read or read before the document changed.
    const vaults = listed.flatMap(listing => {
      const vault = data?.vaults.find(item => item.marketUid.toLowerCase() === listing.marketUid);
      return vault ? [{ ...vault, listing }] : [];
    });
    // Deposit more opens a vault this screen is showing. A position whose route id is not among them has none.
    const renderedVaultIds = new Set(vaults.map(vault => vault.listing.id));
    return {
      positions: (data?.positions ?? []).map(position => {
        const mapped = mapEarnPosition(position, listed);
        const recovered = depositProtocols.get(
          `${position.owner.trim().toLowerCase()}:${position.marketUid.trim().toLowerCase()}`
        );
        return {
          ...mapped,
          ...(mapped.epochProtocol === undefined && recovered ? { epochProtocol: recovered } : {}),
          vaultId: renderedVaultIds.has(mapped.vaultId) ? mapped.vaultId : '',
          stale: Boolean(readError) || failedOwners.has(position.owner)
        };
      }),
      vaults: vaults.map(vault => mapEarnVault(vault, config.network === 'testnet' ? 'USDCx' : undefined)),
      summary: data ? buildEarnSummary(data.positions) : loadingEarnSummary(),
      isLoading,
      // Surface a load failure so the UI can show "couldn't load - retry" instead
      // of a misleading empty "$0 / no positions". Prefer the positions service's
      // own per-owner error; fall back to an SWR-level throw (e.g. the owner
      // lookup failed) so no failure mode reads as "you have nothing".
      error: data?.errors[0]?.error ?? loadError,
      loadError,
      notOnNetwork,
      refetch: () => {
        // Every positions request is bounded, so a read out always settles and frees Retry.
        if (!isValidating) void mutate();
      }
    };
  }, [data, listed, isLoading, readError, notOnNetwork, isValidating, mutate, config.network, depositProtocols]);
}
