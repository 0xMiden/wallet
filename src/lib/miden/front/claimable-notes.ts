import { useCallback, useEffect, useMemo, useRef } from 'react';

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
import { onNotesRefresh } from './note-refresh';
import type { ConsumableNoteDto } from '../sdk/consumable-notes';
import { runWhenClientIdle, withWasmClientLock } from '../sdk/miden-client';
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
  type: NoteTypeEnum | 'unknown';
  swapOrder?: SwapOrderNoteMetadata;
};

// -------------------- Pure helpers (no side effects) --------------------

function parseNotes(
  rawNotes: ConsumableNoteDto[],
  notesBeingClaimed: Set<string>,
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
      type: kind,
      swapOrder: swapOrders.get(noteId)
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
      type: n.type,
      swapOrder: n.swapOrder
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
    rawNotes = await withWasmClientLock(async () => midenClientProxy.getConsumableNotes(publicAddress));
  } catch (e) {
    debugInfoRef.current = {
      ...debugInfoRef.current,
      error: `getConsumableNotes failed: ${e}`,
      lastFetchTime: new Date().toISOString()
    };
    throw e;
  }

  const uncompletedTxs = await getUncompletedTransactions(publicAddress);
  const notesBeingClaimed = new Set(
    uncompletedTxs
      .filter(tx => tx.type === 'consume')
      .flatMap(tx => tx.noteIds ?? (tx.noteId != null ? [tx.noteId] : []))
  );

  // Per-order PSWAP lineage inside classifySwapOrderNotes routes through the proxy
  // (issue #260, slice 7a); the caller lock still serializes the flag-OFF inline
  // lineage reads (byte-identical), and flag-ON they hit the offscreen client.
  const swapOrders = await withWasmClientLock(async () => classifySwapOrderNotes(rawNotes, publicAddress));

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

// -------------------- Extension hook (reads from Zustand) --------------------

function useExtensionClaimableNotes(publicAddress: string, enabled: boolean) {
  const extensionNotes = useWalletStore(s => s.extensionClaimableNotes);
  const extensionClaimingNoteIds = useWalletStore(s => s.extensionClaimingNoteIds);
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

  // Map serialized notes to ConsumableNote with metadata
  const computedData = useMemo(() => {
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
        isBeingClaimed: extensionClaimingNoteIds.has(n.id),
        type: (n.noteType as NoteTypeEnum | 'unknown') ?? 'unknown',
        swapOrder: n.swapOrder ? { ...n.swapOrder, autoConsume: n.swapOrder.autoConsume ?? true } : undefined
      }));
  }, [enabled, extensionNotes, extensionClaimingNoteIds, assetsMetadata]);

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
    // 4) Return notes with available metadata immediately
    const result = attachMetadataToNotes(parsedNotes, metadataByFaucetId);

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

  const key = enabled ? ['claimable-notes', publicAddress] : null;
  const swrResult = useRetryableSWR(key, enabled ? fetchClaimableNotes : null, {
    revalidateOnFocus: false,
    dedupingInterval: 10_000,
    refreshInterval: 5_000,
    // Lets an E2E hook quiesce this (heavy, WASM-lock-bound) poll while it does
    // its own single-threaded-WASM read; otherwise the read is livelocked on
    // mobile by the 5s re-fire. No-op in production (tree-shaken).
    isPaused: () => isTestSyncPaused(),
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
