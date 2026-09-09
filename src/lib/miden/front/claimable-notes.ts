import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getUncompletedTransactions } from 'lib/miden/activity';
import { getQuarantinedNoteIds } from 'lib/miden/note-quarantine';
import { isExtension, isIOS } from 'lib/platform';
import { SerializedConsumableNote, SyncData, WalletMessageType } from 'lib/shared/types';
import { getIntercom, useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';

import { isMidenFaucet } from '../assets';
import { midenClientProxy } from '../back/miden-client-proxy';
import { toNoteTypeString } from '../helpers';
import { AssetMetadata, MIDEN_METADATA } from '../metadata';
import { claimingTxIdByNoteId } from './claiming-tx-map';
import { onNotesRefresh } from './note-refresh';
import { fetchFromStorage, putToStorage } from './storage';
import { isSyncFused, noteNonEvictionSyncFailure, noteSyncSuccess, noteSyncWatchdogEviction } from './sync-fuse';
import type { ConsumableNoteDto } from '../sdk/consumable-notes';
import { assertWasmHoldCurrent, runWhenClientIdle, withWasmClientLock } from '../sdk/miden-client';
import { isSyncWatchdogEviction, WASM_LOCK_SYNC_WATCHDOG_MS } from '../sdk/wasm-client-poison';
import { classifySwapOrderNotes } from '../swap/classification';
import { ConsumableNote, NoteTypeEnum, SwapOrderNoteMetadata } from '../types';
import { useTokensMetadata } from './assets';
import { isTestSyncPaused } from './test-sync-pause';

// Debug info for iOS troubleshooting
export type ClaimableNotesDebugInfo = {
  rawNotesCount: number;
  parsedNotesCount: number;
  notesWithMetadataCount: number;
  missingFaucetIds: string[];
  metadataCacheKeys: string[];
  lastFetchTime: string;
  error?: string;
};

// -------------------- Types --------------------

type ParsedNote = {
  id: string;
  faucetId: string;
  amountBaseUnits: string;
  senderAddress: string;
  isBeingClaimed: boolean;
  claimingTxId?: string;
  type: NoteTypeEnum | 'unknown';
  swapOrder?: SwapOrderNoteMetadata;
  recallableAtMs?: number;
  /** Note inclusion time, in Unix seconds. */
  receivedAt?: number;
};

// -------------------- Pure helpers (no side effects) --------------------

function parseNotes(
  rawNotes: ConsumableNoteDto[],
  notesBeingClaimed: ReadonlyMap<string, string>,
  swapOrders: Map<string, SwapOrderNoteMetadata> = new Map()
): ParsedNote[] {
  const parsed: ParsedNote[] = [];

  // Notes now arrive as reduced DTOs (issue #260, slice 4): the reach-through to
  // `.id()/.metadata()/.details()` — and the per-note try/catch that guarded it —
  // now live in the shared reducer, which already dropped any un-reducible note.
  for (const note of rawNotes) {
    // Partial (metadata-less) notes have no ID yet and cannot be claimed — skip
    // until sync completes them.
    const noteId = note.noteId;
    if (!noteId) continue;

    // Only the first fungible asset is surfaced (unchanged); an empty asset set
    // means the note can't be displayed — skip it.
    const firstAsset = note.assets[0];
    if (!firstAsset) continue;

    const kind = note.noteType !== undefined ? toNoteTypeString(note.noteType) : 'unknown';
    parsed.push({
      id: noteId,
      faucetId: firstAsset.faucetId,
      amountBaseUnits: firstAsset.amount,
      senderAddress: note.senderAccountId ?? '',
      isBeingClaimed: notesBeingClaimed.has(noteId),
      claimingTxId: notesBeingClaimed.get(noteId),
      type: kind,
      swapOrder: swapOrders.get(noteId),
      receivedAt: note.receivedAt,
      recallableAtMs: note.recallableAtMs
    });
  }

  return parsed;
}

async function buildMetadataMapFromCache(
  notes: ParsedNote[],
  cache: Record<string, AssetMetadata> | undefined
): Promise<Record<string, AssetMetadata>> {
  const map: Record<string, AssetMetadata> = {};
  for (const n of notes) {
    if (await isMidenFaucet(n.faucetId)) {
      map[n.faucetId] = MIDEN_METADATA;
    } else {
      const cached = cache?.[n.faucetId];
      if (cached) map[n.faucetId] = cached;
    }
  }
  return map;
}

async function findMissingFaucetIds(
  notes: ParsedNote[],
  metadataByFaucetId: Record<string, AssetMetadata>
): Promise<string[]> {
  const missing = new Set<string>();
  for (const n of notes) {
    const isMiden = await isMidenFaucet(n.faucetId);
    if (!isMiden && !metadataByFaucetId[n.faucetId]) {
      missing.add(n.faucetId);
    }
  }
  return Array.from(missing);
}

function attachMetadataToNotes(
  notes: ParsedNote[],
  metadataByFaucetId: Record<string, AssetMetadata>
): Array<ConsumableNote & { metadata: AssetMetadata }> {
  // Only return notes that have metadata available
  // Notes without metadata will appear after metadata is fetched and SWR revalidates
  return notes
    .filter(n => metadataByFaucetId[n.faucetId])
    .map(n => ({
      id: n.id,
      faucetId: n.faucetId,
      amount: n.amountBaseUnits, // base units
      metadata: metadataByFaucetId[n.faucetId]!,
      senderAddress: n.senderAddress,
      isBeingClaimed: n.isBeingClaimed,
      claimingTxId: n.claimingTxId,
      type: n.type,
      swapOrder: n.swapOrder,
      receivedAt: n.receivedAt,
      recallableAtMs: n.recallableAtMs
    }));
}

// -------------------- Side-effect helpers --------------------

async function persistMetadataIfAny(
  toPersist: Record<string, AssetMetadata>,
  setTokensBaseMetadata: (batch: Record<string, AssetMetadata>) => Promise<void>
): Promise<void> {
  if (Object.keys(toPersist).length > 0) {
    await setTokensBaseMetadata(toPersist);
  }
}

// -------------------- Data fetching --------------------

async function fetchNotesFromLocalClient(
  publicAddress: string,
  debugInfoRef: React.MutableRefObject<ClaimableNotesDebugInfo>
): Promise<ParsedNote[]> {
  let rawNotes: ConsumableNoteDto[] = [];
  try {
    // DTOs via the proxy (issue #260, slice 4): flag-off falls through to the
    // same inline client, so on mobile/desktop this is behavior-identical.
    // Bounded at the SYNC ceiling, not left on the 5-minute backstop (#777). This
    // is nominally a read, but on the inline path it builds the client when the slot
    // is empty — and after a sync eviction the slot is ALWAYS empty — so its genesis
    // fetch parks on the very node the sync just gave up on. On the default ceiling
    // this 5s poll then owned the mutex for 300s per lap, which is worse than the
    // hold it inherited it from: the sync loop's own fuse takes the sync OUT of the
    // queue, leaving this poll as the sole occupant of a wallet that looks idle.
    rawNotes = await withWasmClientLock(
      async hold =>
        midenClientProxy.getConsumableNotes(publicAddress, () =>
          assertWasmHoldCurrent(hold, 'inside the claimable-notes read, before the sync-height read')
        ),
      {
        watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS,
        label: 'claimable-notes'
      }
    );
  } catch (e) {
    // This probe keeps its OWN fuse ledger entry. Bounding the hold above capped each
    // park at 120s but did nothing about the rate: on a parked node a 5s poll earns an
    // eviction — and leaks the client it poisoned — roughly every other lap, forever.
    // Keyed on 'claimable-notes' rather than shared, because a healthy chain sync says
    // nothing about a note read whose call is parked, and a single counter let either
    // fact erase the other.
    if (isSyncWatchdogEviction(e)) noteSyncWatchdogEviction('claimable-notes');
    else noteNonEvictionSyncFailure('claimable-notes');
    debugInfoRef.current = {
      ...debugInfoRef.current,
      error: `getConsumableNotes failed: ${e}`,
      lastFetchTime: new Date().toISOString()
    };
    throw e;
  }

  const uncompletedTxs = await getUncompletedTransactions(publicAddress);
  const notesBeingClaimed = claimingTxIdByNoteId(uncompletedTxs);

  // Per-order PSWAP lineage inside classifySwapOrderNotes routes through the proxy
  // (issue #260, slice 7a); the caller lock still serializes the flag-OFF inline
  // lineage reads (byte-identical), and flag-ON they hit the offscreen client.
  // Bounded and labelled for the same reason as the read above, which it follows on the
  // same 5s cadence: flag-OFF it is inline WASM, it rebuilds the client when the slot is
  // empty, and left on the 5-minute backstop it reopened exactly the unbounded park the
  // read no longer takes — one hold further down the same function.
  let swapOrders;
  try {
    swapOrders = await withWasmClientLock(
      async hold => classifySwapOrderNotes(rawNotes, publicAddress, undefined, hold),
      {
        watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS,
        label: 'claimable-notes-swap-lineage'
      }
    );
  } catch (e) {
    // Same ledger as the read above: this is the second hold of one probe, and an
    // eviction here is the same parked client with the same per-lap cost.
    if (isSyncWatchdogEviction(e)) noteSyncWatchdogEviction('claimable-notes');
    else noteNonEvictionSyncFailure('claimable-notes');
    throw e;
  }

  // Both holds went through, so the probe went through. Reported here rather than after
  // the first one: the mutex is released between them, so the swap-lineage hold rebuilds
  // and can park on its own — and a success booked before it ran cleared the very
  // evidence that hold was accumulating, which is how a fuse becomes unreachable.
  noteSyncSuccess('claimable-notes');

  // Notes the pre-confirm dry-run imported to simulate a not-yet-approved
  // custom transaction — hidden from the claimable UI until the user
  // confirms (or forever, if they cancel). See note-quarantine.ts.
  //
  // NOTE: `parseNotes`'s 2nd arg (`notesBeingClaimed`) only flags matching
  // notes as `isBeingClaimed` — it does NOT remove them from the result, so
  // it cannot be reused to hide quarantined notes. We instead filter the
  // parsed result by id (parseNotes derives ids the same way, via
  // `note.id()?.toString()`, so the ids match exactly).
  const quarantined = await getQuarantinedNoteIds();
  const parsed = parseNotes(rawNotes, notesBeingClaimed, swapOrders);
  return quarantined.size === 0 ? parsed : parsed.filter(n => !quarantined.has(n.id));
}

// -------------------- Cache-first list (mobile/desktop) --------------------

/** One claimable note as the local hook returns it: the note plus its token metadata. */
export type ClaimableNoteWithMetadata = ConsumableNote & { metadata: AssetMetadata };

// Storage key style copied from `lib/miden-chain/native-asset.ts` (`<name>:<version>:<scope>`)
// and written through the same platform key-value helpers, so mobile, desktop and the
// extension all use one storage layer. The scope is the account public address: the cache
// is per account, and a key that cannot collide is what keeps one account's notes from
// ever being served under another.
const CLAIMABLE_NOTES_CACHE_PREFIX = 'claimable_notes:v1:';

/**
 * Upper bound on the notes kept per account. A real pending list is a handful of
 * notes; a few hundred is far above that and keeps the entry small enough to read
 * on every mount.
 */
const MAX_CACHED_CLAIMABLE_NOTES = 300;

function claimableNotesCacheKey(publicAddress: string): string {
  return `${CLAIMABLE_NOTES_CACHE_PREFIX}${publicAddress}`;
}

/**
 * Fixed order for the returned list: newest first, ties broken by note id.
 *
 * Applied to BOTH the cached list and the live one, so replacing the cache with the
 * live read never reshuffles the cards under the user's finger — the WASM read returns
 * notes in client order, which is not stable between laps.
 */
function sortClaimableNotes<T extends { id: string; receivedAt?: number }>(notes: readonly T[]): T[] {
  return [...notes].sort((a, b) => {
    const aReceivedAt = a.receivedAt ?? 0;
    const bReceivedAt = b.receivedAt ?? 0;
    if (aReceivedAt !== bReceivedAt) return bReceivedAt - aReceivedAt;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Accepts only entries that are plain JSON with the fields the UI reads. */
function isCachedClaimableNote(value: unknown): value is ClaimableNoteWithMetadata {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || value.id.length === 0) return false;
  if (typeof value.faucetId !== 'string' || typeof value.amount !== 'string') return false;
  if (typeof value.senderAddress !== 'string') return false;
  const metadata = value.metadata;
  if (!isRecord(metadata)) return false;
  return typeof metadata.symbol === 'string' && typeof metadata.decimals === 'number';
}

/**
 * Last list published per account, in memory.
 *
 * Reading the persisted cache is async, so it cannot answer the FIRST render. This map
 * is what makes a remount (tab switch, page pop) instant, and the storage read below
 * covers the first mount after launch — one tick, still seconds ahead of the WASM read.
 */
const claimableNotesMemCache = new Map<string, ClaimableNoteWithMetadata[]>();

/** Marks every entry as unconfirmed, so no claim gate can act on it. */
function markFromCache(notes: readonly ClaimableNoteWithMetadata[]): ClaimableNoteWithMetadata[] {
  return notes.map(note => ({ ...note, fromCache: true }));
}

/**
 * Plain-JSON projection: nothing that is not serialisable reaches storage, and the
 * `fromCache` flag is deliberately NOT written — it says how an entry was READ, and a
 * stored copy that already carried it would survive a live read that cleared it.
 * `metadata` is `AssetMetadata`, which is a plain field record, so it is stored whole:
 * the list has to render its symbols and decimals before the live read lands.
 */
function toCachedClaimableNote(note: ClaimableNoteWithMetadata): ClaimableNoteWithMetadata {
  return {
    metadata: note.metadata,
    id: note.id,
    faucetId: note.faucetId,
    amount: note.amount,
    senderAddress: note.senderAddress,
    isBeingClaimed: note.isBeingClaimed,
    claimingTxId: note.claimingTxId,
    type: note.type,
    swapOrder: note.swapOrder,
    recallableAtMs: note.recallableAtMs,
    receivedAt: note.receivedAt
  };
}

async function readCachedClaimableNotes(publicAddress: string): Promise<ClaimableNoteWithMetadata[] | null> {
  const warm = claimableNotesMemCache.get(publicAddress);
  if (warm) return warm;
  try {
    const stored = await fetchFromStorage<unknown>(claimableNotesCacheKey(publicAddress));
    if (!Array.isArray(stored)) return null;
    const notes = markFromCache(sortClaimableNotes(stored.filter(isCachedClaimableNote)));
    claimableNotesMemCache.set(publicAddress, notes);
    return notes;
  } catch (err) {
    console.warn('[claimable-notes] cache read failed', err);
    return null;
  }
}

/**
 * Records the live list for this account. Always writes, including an EMPTY list:
 * an account whose notes were all claimed must not see them return on next launch.
 */
async function writeCachedClaimableNotes(
  publicAddress: string,
  notes: readonly ClaimableNoteWithMetadata[]
): Promise<void> {
  const bounded = notes.slice(0, MAX_CACHED_CLAIMABLE_NOTES).map(toCachedClaimableNote);
  claimableNotesMemCache.set(publicAddress, markFromCache(bounded));
  try {
    await putToStorage(claimableNotesCacheKey(publicAddress), bounded);
  } catch (err) {
    console.warn('[claimable-notes] cache write failed', err);
  }
}

/** Test-only: drops the in-memory half of the cache. */
export function __resetClaimableNotesCacheForTests(): void {
  claimableNotesMemCache.clear();
}

// -------------------- Extension hook (reads from Zustand) --------------------

function useExtensionClaimableNotes(publicAddress: string, enabled: boolean) {
  const extensionNotes = useWalletStore(s => s.extensionClaimableNotes);
  const [claimingTxIds, setClaimingTxIds] = useState<ReadonlyMap<string, string>>(new Map());
  const assetsMetadata = useWalletStore(s => s.assetsMetadata);

  // Poll chrome.storage.local for notes on mount + every 3s.
  // The SW writes miden_sync_data on every sync cycle (see sync-manager.ts).
  // This is the primary data channel — more reliable than intercom broadcasts
  // which can be lost if any port in the forEach throws.
  //
  // We read the account-scoped miden_sync_data (which carries both `notes` and
  // the `accountPublicKey` they belong to) rather than the bare, wallet-wide
  // miden_cached_consumable_notes key. Without this guard, after an account
  // switch the previous account's cached notes are served to — and auto-consumed
  // under — the newly selected account (#280).
  useEffect(() => {
    if (!enabled) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (!g.chrome?.storage?.local) return;

    const poll = () => {
      g.chrome.storage.local.get('miden_sync_data', (result: any) => {
        const syncData: SyncData | undefined = result?.miden_sync_data;
        // Nothing synced yet — leave the store untouched so isLoading stays true.
        if (!syncData) return;
        // Only serve notes that belong to the account currently being viewed;
        // for any other account, clear to [] so a stale set is never displayed
        // or auto-consumed.
        const notes: SerializedConsumableNote[] =
          syncData.accountPublicKey === publicAddress ? (syncData.notes ?? []) : [];
        useWalletStore.getState().setExtensionClaimableNotes(notes);
      });
    };

    // Read immediately on mount
    poll();

    // Then poll every 3s (aligned with useSyncTrigger's SyncRequest interval)
    const timer = setInterval(poll, 3_000);
    return () => clearInterval(timer);
  }, [enabled, publicAddress]);

  // The popup and the service worker share an origin, so they share this Dexie: an
  // in-flight consume is visible here as a row, with no broadcast needed. Reading the
  // row is what mobile and desktop already do, and unlike the broadcast it also covers
  // a consume that FAILED -- that row leaves Queued/GeneratingTransaction, so the note
  // becomes claimable again instead of staying hidden. Polled on the same 3s cadence as
  // the sync read above so both gates move together.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;

    const readClaiming = () => {
      getUncompletedTransactions(publicAddress)
        .then(txs => {
          if (!cancelled) setClaimingTxIds(claimingTxIdByNoteId(txs));
        })
        .catch(() => {
          // A failed read leaves the previous gate in place: better a stale gate for one
          // tick than a Claim button that reappears under a live consume.
        });
    };

    readClaiming();
    const claimingTimer = setInterval(readClaiming, 3_000);
    return () => {
      cancelled = true;
      clearInterval(claimingTimer);
    };
  }, [enabled, publicAddress]);

  // Map serialized notes to ConsumableNote with metadata. Annotated rather than inferred
  // so both hooks publish the SAME element type: an inferred object literal has no
  // `fromCache` key at all, and the union of the two hooks then hides the flag from every
  // consumer of `useClaimableNotes` — including the claim gates that must read it.
  const computedData = useMemo<ClaimableNoteWithMetadata[] | undefined>(() => {
    if (!enabled || extensionNotes === null) return undefined;

    return extensionNotes
      .filter(n => !n.swapOrder || n.swapOrder.autoConsume === false)
      .filter(n => n.metadata || assetsMetadata[n.faucetId])
      .map(n => ({
        id: n.id,
        faucetId: n.faucetId,
        amount: n.amountBaseUnits,
        metadata: (n.metadata as AssetMetadata) || assetsMetadata[n.faucetId],
        senderAddress: n.senderAddress,
        isBeingClaimed: claimingTxIds.has(n.id),
        claimingTxId: claimingTxIds.get(n.id),
        type: (n.noteType as NoteTypeEnum | 'unknown') ?? 'unknown',
        swapOrder: n.swapOrder ? { ...n.swapOrder, autoConsume: n.swapOrder.autoConsume ?? true } : undefined,
        receivedAt: n.receivedAt,
        recallableAtMs: n.recallableAtMs
      }));
  }, [enabled, extensionNotes, claimingTxIds, assetsMetadata]);

  const mutate = useCallback(() => {
    // Trigger a SyncRequest to get fresh data
    const intercom = getIntercom();
    intercom.request({ type: WalletMessageType.SyncRequest }).catch(() => {});
    return Promise.resolve(undefined);
  }, []);

  return {
    data: computedData,
    mutate,
    isLoading: extensionNotes === null,
    isValidating: false,
    debugInfo: undefined
  };
}

// -------------------- Local hook (WASM client, for mobile/desktop) --------------------

function useLocalClaimableNotes(publicAddress: string, enabled: boolean) {
  const { allTokensBaseMetadataRef, fetchMetadata, setTokensBaseMetadata } = useTokensMetadata();
  const debugInfoRef = useRef<ClaimableNotesDebugInfo>({
    rawNotesCount: 0,
    parsedNotesCount: 0,
    notesWithMetadataCount: 0,
    missingFaucetIds: [],
    metadataCacheKeys: [],
    lastFetchTime: 'never'
  });

  // Address whose LIVE read has already landed in this mount. Once it has, the
  // persisted list is stale by definition and publishing it as a fallback would only
  // cost a render — the storage read and the first live read race on every mount, and
  // on a warm client the live read frequently wins.
  const liveLandedForRef = useRef<string | null>(null);

  const fetchClaimableNotes = useCallback(async () => {
    const parsedNotes = (await fetchNotesFromLocalClient(publicAddress, debugInfoRef)).filter(
      note => !note.swapOrder || note.swapOrder.autoConsume === false
    );

    // 2) Seed metadata map from cache (and baked-in MIDEN)
    const metadataByFaucetId = await buildMetadataMapFromCache(parsedNotes, allTokensBaseMetadataRef.current);

    // 3) Schedule background metadata pre-fetch for unknown tokens (non-blocking).
    // This doesn't "warm up" the WASM client — it fetches token metadata (symbol, decimals)
    // via RPC so tokens display with proper names on subsequent renders instead of "Unknown".
    const missingFaucetIds = await findMissingFaucetIds(parsedNotes, metadataByFaucetId);
    if (missingFaucetIds.length > 0) {
      runWhenClientIdle(async () => {
        const fetched: Record<string, AssetMetadata> = {};
        for (const id of missingFaucetIds) {
          try {
            const { base } = await fetchMetadata(id);
            fetched[id] = base;
          } catch (e) {
            console.warn('Metadata fetch failed for', id, e);
          }
        }
        if (Object.keys(fetched).length > 0) {
          await persistMetadataIfAny(fetched, setTokensBaseMetadata);
        }
      });
    }
    // 4) Return notes with available metadata immediately, in a fixed order (see
    // `sortClaimableNotes`) so a refresh cannot reshuffle the cards.
    const result = sortClaimableNotes(attachMetadataToNotes(parsedNotes, metadataByFaucetId));

    // Publish the live list as the new last-known list for this account. An empty
    // result is written too, which is what stops claimed notes reappearing on the
    // next launch.
    await writeCachedClaimableNotes(publicAddress, result);
    liveLandedForRef.current = publicAddress;

    // Update debug info
    debugInfoRef.current = {
      rawNotesCount: parsedNotes.length,
      parsedNotesCount: parsedNotes.length,
      notesWithMetadataCount: result.length,
      missingFaucetIds,
      metadataCacheKeys: Object.keys(allTokensBaseMetadataRef.current || {}),
      lastFetchTime: new Date().toISOString(),
      error: undefined
    };

    return result;
  }, [publicAddress, allTokensBaseMetadataRef, fetchMetadata, setTokensBaseMetadata]);

  // Cache-first render. The persisted read is async and cannot answer the first
  // render, so it is done in an effect and handed to SWR as `fallbackData`; the
  // module-level memory cache (consulted synchronously by the state initialiser)
  // covers every later mount in the same session. Either way the hook returns
  // immediately and the live read replaces the list when it lands.
  const [cachedFallback, setCachedFallback] = useState<{
    address: string;
    notes: ClaimableNoteWithMetadata[];
  } | null>(() => {
    const warm = claimableNotesMemCache.get(publicAddress);
    return warm ? { address: publicAddress, notes: warm } : null;
  });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    readCachedClaimableNotes(publicAddress)
      .then(notes => {
        if (cancelled || !notes) return;
        // The live read for this account already answered — it is strictly better than
        // the cache, so do not publish behind it.
        if (liveLandedForRef.current === publicAddress) return;
        // Bail out when the state initialiser already took this exact list out of the
        // memory cache: a remount must not cost a second render for the same data.
        setCachedFallback(previous =>
          previous && previous.address === publicAddress && previous.notes === notes
            ? previous
            : { address: publicAddress, notes }
        );
      })
      .catch(() => {
        // A missing cache is the normal first-launch state — fall through to the live read.
      });
    return () => {
      cancelled = true;
    };
  }, [enabled, publicAddress]);

  // The state above still holds the PREVIOUS account for one render after a switch,
  // so the address is re-checked here: another account's notes are never served.
  // For the same reason SWR's `keepPreviousData` is deliberately NOT set — it would
  // serve the old key's data across an account switch, which this cache must not do.
  const fallbackData = cachedFallback?.address === publicAddress ? cachedFallback.notes : undefined;

  const key = enabled ? ['claimable-notes', publicAddress] : null;
  const swrResult = useRetryableSWR(key, enabled ? fetchClaimableNotes : null, {
    fallbackData,
    revalidateOnFocus: false,
    dedupingInterval: 10_000,
    refreshInterval: 5_000,
    // Lets an E2E hook quiesce this (heavy, WASM-lock-bound) poll while it does
    // its own single-threaded-WASM read; otherwise the read is livelocked on
    // mobile by the 5s re-fire. No-op in production (tree-shaken).
    // Fused (#777) means this probe's own call is parked: the node took the request and
    // never answered, so the client the next lap builds parks on it too. `isPaused` is
    // the right gate rather than an early return — it withholds the HOLD while leaving
    // the last good note list on screen, where returning [] would have read to the user
    // as "your claimable notes are gone".
    isPaused: () => isTestSyncPaused() || isSyncFused('claimable-notes'),
    onError: e => {
      console.error('Error fetching claimable notes:', e);
      debugInfoRef.current = {
        ...debugInfoRef.current,
        error: `SWR error: ${e}`,
        lastFetchTime: new Date().toISOString()
      };
    }
  });

  // Revalidate immediately when a sync completes or the app foregrounds, so a
  // just-imported note surfaces without waiting out the 5s SWR interval (#462).
  const { mutate } = swrResult;
  useEffect(() => {
    if (!enabled) return;
    return onNotesRefresh(() => {
      void mutate();
    });
  }, [enabled, mutate]);

  return {
    ...swrResult,
    debugInfo: isIOS() ? debugInfoRef.current : undefined
  };
}

// -------------------- Dispatch hook --------------------

export function useClaimableNotes(publicAddress: string, enabled: boolean = true) {
  const extensionMode = isExtension();
  // Both hooks always called (React rules), but only the active one does work
  const extensionResult = useExtensionClaimableNotes(publicAddress, enabled && extensionMode);
  const localResult = useLocalClaimableNotes(publicAddress, enabled && !extensionMode);
  return extensionMode ? extensionResult : localResult;
}
