import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useSWRConfig } from 'swr';

import { usePageActive } from 'app/layouts/page-active';
import {
  carryForward,
  type EarnPositionsResult,
  fetchEarnPositions,
  getEarnDepositEvmAddresses,
  positionsBudgetDelayMs
} from 'lib/epoch';
import { compareAccountIds } from 'lib/miden/activity/utils';
import type { IEarnDepositExtraInputs } from 'lib/miden/db/types';
import { useAccount } from 'lib/miden/front';
import { fetchFromStorage, putToStorage } from 'lib/miden/front/storage';
import * as Repo from 'lib/miden/repo';
import { getStorageProvider } from 'lib/platform/storage-adapter';
import type { EarnVaultConfig } from 'lib/remote-config/schema';
import { useBridgeConfigSnapshot } from 'lib/remote-config/use-feature-availability';
import {
  BridgeConfigUnavailableError,
  selectEarnVaultCatalog,
  selectEarnVaultLogoUrl,
  selectEarnVaults,
  selectEpochRoutes
} from 'lib/remote-config/values';
import { useRetryableSWR } from 'lib/swr';
import { useLastData } from 'lib/swr/last-data';
import { safeOwnDiagnosticData } from 'lib/telemetry/closed-root-diagnostics';
import {
  EARN_POSITIONS_LOAD_STAGES,
  snapshotUiProducer,
  type UiEvidenceInput,
  validateUiEvidence
} from 'lib/telemetry/ui-producer-diagnostics';

import { buildEarnSummary, loadingEarnSummary, mapEarnPosition, mapEarnVault } from './earn-mapping';
import type { EarnPosition, EarnSummary, EarnVault } from './types';

// The poll and the error retry. Each read sends one request for each owner, so with more than one owner the poll can
// pass the Epoch positions service's 10 requests per minute.
const READ_INTERVAL_MS = 10_000;

/**
 * The prefix of the storage key that holds the last successful read of one SWR key: the prefix, then the key as JSON.
 * A change to the stored shape takes a new version. A wallet reset removes it with every other unkept key.
 */
export const EARN_POSITIONS_STORAGE_PREFIX = 'earn_positions_v1:';

// A stored read larger than this is not stored, and the older copy is removed. Positions are small: one is about
// 400 characters.
const MAX_STORED_CHARS = 32_768;

/** The last successful read of one key: when it began, and its result with no errors. */
interface StoredEarnPositions {
  at: number;
  result: EarnPositionsResult;
}

interface KeyReads {
  /** When the key's last read began, whoever started it. */
  at?: number;
  /** Each on-screen hook's re-arm, called as a read begins, so its next automatic read waits 10 s after it. */
  rearms: Set<() => void>;
}
// Per SWR cache, so a test's fresh cache starts with none.
const keyReads = new WeakMap<object, Map<string, KeyReads>>();

const NO_STORED_READ: Promise<StoredEarnPositions | undefined> = Promise.resolve(undefined);

const ignoreFailedWrite = () => {};

// The failure a read would report for a document that names no positions host, no Epoch route or no Earn vault, as
// the getters phrase it, named from the snapshot the hook keys on: the getters read the realm's, which can differ.
function unconfiguredError(
  positionsUrl: string | undefined,
  chainIds: string,
  listedCount: number
): string | undefined {
  if (!positionsUrl) return new BridgeConfigUnavailableError('epoch.positionsUrl').message;
  if (chainIds === '') return new BridgeConfigUnavailableError('Epoch route').message;
  if (listedCount === 0) return new BridgeConfigUnavailableError('Earn vault').message;
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

/** The stored read of `storageKey`, or undefined when there is none, it has another shape or the read fails. */
async function readStoredPositions(storageKey: string): Promise<StoredEarnPositions | undefined> {
  try {
    const stored = await fetchFromStorage<StoredEarnPositions>(storageKey);
    if (!stored || typeof stored.at !== 'number' || !Array.isArray(stored.result?.positions)) return undefined;
    return { at: stored.at, result: { ...stored.result, errors: [] } };
  } catch (error) {
    console.warn('[earn] stored positions unreadable', error);
    return undefined;
  }
}

/** Stores a successful read of `storageKey` without its errors, or removes the older copy when the read is too large. */
function storePositions(storageKey: string, at: number, result: EarnPositionsResult): Promise<void> {
  const stored: StoredEarnPositions = { at, result: { ...result, errors: [] } };
  if (JSON.stringify(stored).length > MAX_STORED_CHARS) return getStorageProvider().remove([storageKey]);
  return putToStorage(storageKey, stored);
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
 * last read began, whoever started it: the poll and the retry of a failed read fire 10 s after it. A page that comes
 * into view, or mounts, reads at once whatever the age of the last read, since the Earn pages stay mounted behind
 * other tabs. Nothing is read on a timer while the page is off screen (another tab, a page above it, or another Home
 * page), the document is hidden or the device is offline, and reconnect and focus never read. A Retry is the one read
 * outside that, and the next poll waits 10 s after it too.
 *
 * The key needs only the document: the account, the positions host and the Epoch routes it names, never a derived
 * value, so a cold open reads at once. Each successful read is stored under `EARN_POSITIONS_STORAGE_PREFIX` and the
 * key, so a mount in a fresh realm (every extension popup open) shows the last read at once, every position stale,
 * while its own read runs. The stored copy is shown only until this hook sees a live read of the key, and the copy of
 * a key the hook leaves (another account, network or document) is removed. The vaults are the derivation's catalogue
 * (`selectEarnVaultCatalog`), not this read's.
 */
export function useEarnPositions(): {
  summary: EarnSummary;
  /**
   * Each `stale` when the latest read did not load it: the read failed and SWR kept an earlier read's data, its
   * owner failed and it was carried from an earlier read, or it is the stored copy of an earlier session's read. A
   * stale position arms no withdrawal.
   */
  positions: EarnPosition[];
  /** The listed vaults the derivation's catalogue serves, in the document's order. Empty until a derivation holds it. */
  vaults: EarnVault[];
  /**
   * The document lists vaults and the derivation has not settled their catalogue yet (no `derived.epoch.vaults`). A
   * vault lookup reads this as loading, since `isLoading` is the positions read's and can end first. False once the
   * catalogue is read, failed or skipped.
   */
  vaultsPending: boolean;
  /**
   * No data and no error, live, kept or stored, including while the page is covered. A retry after a failure keeps
   * the error and reports false.
   */
  isLoading: boolean;
  /** Any failure: the request's, or one owner's positions. What the positions surfaces report. */
  error?: string;
  errorDiagnostics?: UiEvidenceInput;
  /**
   * The failure of the request itself (the owner lookup, or a document that names no Earn). What the vault surfaces
   * report. A failed owner does not set it, and neither does the vault catalogue, which the config derivation reads.
   */
  loadError?: string;
  /**
   * The network configures no Earn at all: its document (mainnet's) names no positions host, no Epoch route or no
   * Earn vault. `error` still names what is missing, but no read or retry can succeed, so the page says Earn is not
   * on this network. It reads the document only, never the derivation; a snapshot with no accepted document says
   * nothing about the network and keeps its load error and Retry.
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
  const chainIds = selectEpochRoutes(config)
    .map(route => route.chainId)
    .join(',');
  const listed = selectEarnVaults(config);
  const catalog = selectEarnVaultCatalog(config);
  const configured = Boolean(positionsUrl) && chainIds !== '' && listed.length > 0;
  // Only a loading snapshot is a wait: a loaded one that names none settles at once, as the read would have failed.
  const unconfigured = config.status === 'ready' ? unconfiguredError(positionsUrl, chainIds, listed.length) : undefined;
  const notOnNetwork = config.status === 'ready' && config.config !== null && unconfigured !== undefined;

  // A covered page holds a null key, never `isPaused`: SWR sends a shared key's Retry and timed read to its first
  // subscriber, and a paused one swallows them. The Earn pages stay mounted behind other tabs, so the key coming back
  // is the page coming into view, and it reads again then whatever the age of its last read. The read goes to the
  // configured host and routes of the network, so the key names them: none reads nothing, and a document that moves
  // them reads anew. The account stays second: a receipt invalidates every key of its account by it.
  const key = ['earn-positions', account.publicKey, account.evmAddress, config.network, positionsUrl, chainIds];
  const id = JSON.stringify(key);
  const storageKey = EARN_POSITIONS_STORAGE_PREFIX + id;

  // The stored copy is read once per key the hook mounts with, and only for a key that can read.
  const storedRead = useMemo(
    () => (configured ? readStoredPositions(storageKey) : NO_STORED_READ),
    [configured, storageKey]
  );
  const [stored, setStored] = useState<{ storageKey: string; value: StoredEarnPositions }>();
  useEffect(() => {
    let current = true;
    storedRead.then(value => {
      if (current && value) setStored({ storageKey, value });
    });
    return () => {
      current = false;
    };
  }, [storedRead, storageKey]);

  // The key this render shows, so a read that lands after the key moved stores nothing; and the key whose live read
  // this hook has seen, after which the stored copy never shows again (a receipt that clears the key's data must not
  // bring back what it cleared).
  const currentStorageKey = useRef(storageKey);
  currentStorageKey.current = storageKey;
  const liveSeen = useRef<string | null>(null);

  // The stored copy of a key the hook leaves (another account, network or document) is removed.
  const previousStorageKey = useRef(storageKey);
  useEffect(() => {
    const previous = previousStorageKey.current;
    previousStorageKey.current = storageKey;
    if (previous !== storageKey) getStorageProvider().remove([previous]).catch(ignoreFailedWrite);
  }, [storageKey]);

  const {
    data: liveData,
    error: swrError,
    isValidating,
    mutate
  } = useRetryableSWR(
    onScreen && configured ? key : null,
    async (): Promise<EarnPositionsResult> => {
      const reads = readsOf(cache, id);
      const fromActivity = await getEarnDepositEvmAddresses(account.publicKey);
      const walletAddress = account.evmAddress?.toLowerCase();
      const owners = [...new Set(walletAddress ? [...fromActivity, walletAddress] : fromActivity)];
      const count = owners.length > 10 ? 1 : owners.length;
      while (count > 0) {
        const delay = positionsBudgetDelayMs(count);
        if (delay === 0) break;
        await new Promise<void>(resolve => setTimeout(resolve, delay));
      }
      const startedAt = Date.now();
      reads.at = startedAt;
      reads.rearms.forEach(rearm => rearm());
      const next = await fetchEarnPositions({ accountId: account.publicKey, owners });
      // An owner this read fails for keeps what it last loaded: `data` is what this render shows for this key, and
      // SWR calls the fetcher of the last render. On a cold mount that is the stored copy, which may land after the
      // render that started this read.
      const previous = data ?? (liveSeen.current === id ? undefined : (await storedRead)?.result);
      const result = carryForward(previous, next);
      if (currentStorageKey.current === storageKey) {
        storePositions(storageKey, startedAt, result).catch(ignoreFailedWrite);
      }
      return result;
    },
    {
      // A page that comes into view, or mounts, reads at once; the 3 s dedupe below folds the pages that come at once.
      revalidateIfStale: true,
      // SWR's poll and error retry run on their own clocks, blind to a Retry or another page's read: the timer below
      // starts those reads instead.
      refreshInterval: 0,
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      dedupingInterval: 3_000,
      shouldRetryOnError: false
    }
  );
  if (liveData !== undefined) liveSeen.current = id;

  // One timer per on-screen hook, for its current key: it fires 10 s after the key's last read began, re-arming from
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
  // The stored copy stands in only for a key with no live or kept data that this hook has not seen loaded.
  const fromStore =
    shown?.data === undefined && liveSeen.current !== id && stored?.storageKey === storageKey
      ? stored.value.result
      : undefined;
  const data = shown?.data ?? fromStore;
  const readError = shown?.error ?? unconfigured;
  const configurationFailed = shown?.error === undefined && unconfigured !== undefined;
  // No data and no error (live, kept or stored): a page mounted covered reads as loading, not empty.
  const isLoading = data === undefined && !readError;
  const fundingAsset = config.network === 'testnet' ? 'USDCx' : undefined;

  // A listing's logo is a path relative to the base URL of this snapshot's network document.
  const logoUrlOf = useCallback((listing: EarnVaultConfig) => selectEarnVaultLogoUrl(config, listing), [config]);

  // The document decides which vaults show, in which order and under which entry; the catalogue is already in its
  // order, so each listing takes its own vault.
  const vaults = useMemo(
    () =>
      listed.flatMap(listing => {
        const vault = catalog?.find(item => item.marketUid.toLowerCase() === listing.marketUid);
        return vault ? [mapEarnVault({ ...vault, listing }, fundingAsset, logoUrlOf(listing))] : [];
      }),
    [catalog, listed, fundingAsset, logoUrlOf]
  );
  // The document lists vaults and the derivation has not settled its catalogue: a vault missing from `vaults` may
  // still come, whatever the positions read reports.
  const vaultsPending = listed.length > 0 && config.derived?.epoch.vaults === undefined;

  // A position the document leaves without a protocol takes the newest local earn-deposit for this account, owner and
  // market, so a market the document no longer lists stays withdrawable. The read is the transactions table.
  const [depositProtocols, setDepositProtocols] = useState(() => new Map<string, '1delta' | 'dummy-lending'>());
  useEffect(() => {
    const missing = (data?.positions ?? []).some(
      position => mapEarnPosition(position, listed, logoUrlOf).epochProtocol === undefined
    );
    // Drop a previous account's protocols before the read returns, so they cannot label this account's position.
    setDepositProtocols(current => (current.size === 0 ? current : new Map()));
    if (!missing) return;
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
        const previous = newestAt.get(key);
        if (previous !== undefined && previous >= tx.initiatedAt) continue;
        newestAt.set(key, tx.initiatedAt);
        found.set(key, protocol);
      }
      setDepositProtocols(found);
    })();
    return () => {
      cancelled = true;
    };
  }, [account.publicKey, data, listed, logoUrlOf]);

  return useMemo(() => {
    // Owner queries never reject: each failure resolves in `errors`, while what loaded before may still show.
    const failedOwners = new Set(data?.errors.map(({ owner }) => owner));
    const loadError = readError ? errorText(readError) : undefined;
    const stale = Boolean(readError) || fromStore !== undefined;
    const firstError = data?.errors[0];
    const error = firstError?.error ?? loadError;
    const observed = snapshotUiProducer(readError, 'earnPositionsLoadError', 'notice');
    const suppliedStage =
      firstError?.error !== undefined ? safeOwnDiagnosticData(firstError, 'stage') : observed?.earnPositionsLoadStage;
    const stage =
      firstError?.error === undefined && configurationFailed
        ? 'configuration'
        : (EARN_POSITIONS_LOAD_STAGES.find(value => value === suppliedStage) ?? 'unrecorded');
    const outcome =
      firstError?.error !== undefined && data !== undefined && data.errors.length < data.owners.length
        ? 'partial_failure'
        : 'complete_failure';
    const errorDiagnostics = error
      ? validateUiEvidence('earnPositionsLoadError', 'notice', {
          kind: 'earn_positions_load',
          earnPositionsLoadStage: stage,
          earnPositionsLoadOutcome: outcome
        })
      : undefined;
    return {
      positions: (data?.positions ?? []).map(position => {
        const mapped = mapEarnPosition(position, listed, logoUrlOf);
        const recovered = depositProtocols.get(
          `${position.owner.trim().toLowerCase()}:${position.marketUid.trim().toLowerCase()}`
        );
        return {
          ...mapped,
          ...(mapped.epochProtocol === undefined && recovered ? { epochProtocol: recovered } : {}),
          stale: stale || failedOwners.has(position.owner)
        };
      }),
      vaults,
      vaultsPending,
      summary: data ? buildEarnSummary(data.positions) : loadingEarnSummary(),
      isLoading,
      // Surface a load failure so the UI can show "couldn't load - retry" instead
      // of a misleading empty "$0 / no positions". Prefer the positions service's
      // own per-owner error; fall back to an SWR-level throw (e.g. the owner
      // lookup failed) so no failure mode reads as "you have nothing".
      error,
      errorDiagnostics,
      loadError,
      notOnNetwork,
      refetch: () => {
        // Every positions request is bounded, so a read out always settles and frees Retry.
        if (!isValidating) void mutate();
      }
    };
  }, [
    data,
    fromStore,
    listed,
    logoUrlOf,
    vaults,
    vaultsPending,
    isLoading,
    readError,
    configurationFailed,
    notOnNetwork,
    isValidating,
    mutate,
    depositProtocols
  ]);
}
