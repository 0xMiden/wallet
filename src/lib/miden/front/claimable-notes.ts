import { useCallback, useEffect, useMemo, useRef } from 'react';

import { type ConsumableNoteRecord } from '@miden-sdk/miden-sdk';

import { getUncompletedTransactions } from 'lib/miden/activity';
import { isExtension, isIOS } from 'lib/platform';
import { SerializedConsumableNote, WalletMessageType } from 'lib/shared/types';
import { getIntercom, useWalletStore } from 'lib/store';
import { useRetryableSWR } from 'lib/swr';

import { isMidenFaucet } from '../assets';
import { toNoteTypeString } from '../helpers';
import { AssetMetadata, MIDEN_METADATA } from '../metadata';
import { getBech32AddressFromAccountId } from '../sdk/helpers';
import { getMidenClient, runWhenClientIdle, withWasmClientLock } from '../sdk/miden-client';
import { ConsumableNote, NoteTypeEnum } from '../types';
import { useTokensMetadata } from './assets';

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
};

// -------------------- Pure helpers (no side effects) --------------------

function parseNotes(rawNotes: ConsumableNoteRecord[], notesBeingClaimed: Set<string>): ParsedNote[] {
  const parsed: ParsedNote[] = [];

  for (const note of rawNotes) {
    try {
      const noteRecord = note.inputNoteRecord();
      const noteId = noteRecord.id().toString();
      const noteMeta = noteRecord.metadata();
      const details = noteRecord.details();

      const assetSet = details.assets();
      const fungibleAssets = assetSet.fungibleAssets();

      // Safety checks
      if (!fungibleAssets || fungibleAssets.length === 0) continue;

      const firstAsset = fungibleAssets[0];
      if (!firstAsset) continue;

      const faucetId = getBech32AddressFromAccountId(firstAsset.faucetId());
      const amountBaseUnits = firstAsset.amount().toString();
      const senderAddress = noteMeta ? getBech32AddressFromAccountId(noteMeta.sender()) : '';
      const kind = noteMeta ? toNoteTypeString(noteMeta.noteType()) : 'unknown';
      parsed.push({
        id: noteId,
        faucetId,
        amountBaseUnits,
        senderAddress,
        isBeingClaimed: notesBeingClaimed.has(noteId),
        type: kind
      });
    } catch (err) {
      console.error('Error processing note:', err);
    }
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
      type: n.type
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
  let rawNotes: any[] = [];
  try {
    rawNotes = await withWasmClientLock(async () => {
      const midenClient = await getMidenClient();
      return midenClient.getConsumableNotes(publicAddress);
    });
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
    uncompletedTxs.filter(tx => tx.type === 'consume' && tx.noteId != null).map(tx => tx.noteId!)
  );

  return parseNotes(rawNotes, notesBeingClaimed);
}

// -------------------- Extension hook (reads from Zustand) --------------------

function useExtensionClaimableNotes(publicAddress: string, enabled: boolean) {
  const extensionNotes = useWalletStore(s => s.extensionClaimableNotes);
  const extensionClaimingNoteIds = useWalletStore(s => s.extensionClaimingNoteIds);
  const assetsMetadata = useWalletStore(s => s.assetsMetadata);

  // Poll chrome.storage.local for notes on mount + every 3s.
  // The SW writes miden_cached_consumable_notes on every sync cycle.
  // This is the primary data channel — more reliable than intercom broadcasts
  // which can be lost if any port in the forEach throws.
  useEffect(() => {
    if (!enabled) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (!g.chrome?.storage?.local) return;

    const poll = () => {
      g.chrome.storage.local.get('miden_cached_consumable_notes', (result: any) => {
        const cached: SerializedConsumableNote[] = result?.miden_cached_consumable_notes || [];
        useWalletStore.getState().setExtensionClaimableNotes(cached);
      });
    };

    // Read immediately on mount
    poll();

    // Then poll every 3s (aligned with useSyncTrigger's SyncRequest interval)
    const timer = setInterval(poll, 3_000);
    return () => clearInterval(timer);
  }, [enabled]);

  // Map serialized notes to ConsumableNote with metadata
  const computedData = useMemo(() => {
    if (!enabled || extensionNotes === null) return undefined;

    return extensionNotes
      .filter(n => n.metadata || assetsMetadata[n.faucetId])
      .map(n => ({
        id: n.id,
        faucetId: n.faucetId,
        amount: n.amountBaseUnits,
        metadata: (n.metadata as AssetMetadata) || assetsMetadata[n.faucetId],
        senderAddress: n.senderAddress,
        isBeingClaimed: extensionClaimingNoteIds.has(n.id)
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
    const parsedNotes = await fetchNotesFromLocalClient(publicAddress, debugInfoRef);

    // 2) Seed metadata map from cache (and baked-in MIDEN)
    const metadataByFaucetId = await buildMetadataMapFromCache(parsedNotes, allTokensBaseMetadataRef.current);

    // 3) Schedule background fetch for any missing metadata (non-blocking)
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
    console.log(parsedNotes);
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
    onError: e => {
      console.error('Error fetching claimable notes:', e);
      debugInfoRef.current = {
        ...debugInfoRef.current,
        error: `SWR error: ${e}`,
        lastFetchTime: new Date().toISOString()
      };
    }
  });

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
