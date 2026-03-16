import { useCallback, useRef } from 'react';

import { getCachedConsumableNotes } from 'lib/miden/back/note-checker-storage';
import { getUncompletedTransactions } from 'lib/miden/activity';
import { isExtension, isIOS } from 'lib/platform';
import { useRetryableSWR } from 'lib/swr';

import { isMidenFaucet } from '../assets';
import { AssetMetadata, MIDEN_METADATA } from '../metadata';
import { getBech32AddressFromAccountId } from '../sdk/helpers';
import { getMidenClient, runWhenClientIdle, withWasmClientLock } from '../sdk/miden-client';
import { ConsumableNote } from '../types';
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
};

// -------------------- Pure helpers (no side effects) --------------------

function parseNotes(rawNotes: any[], notesBeingClaimed: Set<string>): ParsedNote[] {
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

      parsed.push({
        id: noteId,
        faucetId,
        amountBaseUnits,
        senderAddress,
        isBeingClaimed: notesBeingClaimed.has(noteId)
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
      isBeingClaimed: n.isBeingClaimed
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

// -------------------- Hook (composes helpers) --------------------

export function useClaimableNotes(publicAddress: string, enabled: boolean = true) {
  const { allTokensBaseMetadataRef, fetchMetadata, setTokensBaseMetadata } = useTokensMetadata();
  const debugInfoRef = useRef<ClaimableNotesDebugInfo>({
    rawNotesCount: 0,
    parsedNotesCount: 0,
    notesWithMetadataCount: 0,
    missingFaucetIds: [],
    metadataCacheKeys: [],
    lastFetchTime: 'never'
  });

  const localClientReady = useRef(false);

  const fetchClaimableNotes = useCallback(async () => {
    let parsedNotes: ParsedNote[];

    // On extension, the local WASM client takes ~10s to initialize. On the first fetch,
    // read from chrome.storage.local (cached by the service worker during background sync).
    // This is instant — no WASM, no locks, no intercom round-trip.
    if (isExtension() && !localClientReady.current) {
      try {
        const cached = await getCachedConsumableNotes();
        if (cached.length > 0) {
          const uncompletedTxs = await getUncompletedTransactions(publicAddress);
          const notesBeingClaimed = new Set(
            uncompletedTxs.filter(tx => tx.type === 'consume' && tx.noteId != null).map(tx => tx.noteId!)
          );
          parsedNotes = cached.map(n => ({
            id: n.id,
            faucetId: n.faucetId,
            amountBaseUnits: n.amountBaseUnits,
            senderAddress: n.senderAddress,
            isBeingClaimed: notesBeingClaimed.has(n.id)
          }));

          // Warm up local client in background for subsequent fetches
          withWasmClientLock(async () => {
            const client = await getMidenClient();
            await client.syncState();
          })
            .then(() => {
              localClientReady.current = true;
            })
            .catch(() => {});
        } else {
          // No cache — fall back to local WASM client
          parsedNotes = await fetchNotesFromLocalClient(publicAddress, debugInfoRef);
          localClientReady.current = true;
        }
      } catch {
        parsedNotes = await fetchNotesFromLocalClient(publicAddress, debugInfoRef);
        localClientReady.current = true;
      }
    } else {
      parsedNotes = await fetchNotesFromLocalClient(publicAddress, debugInfoRef);
    }
    // 2) Seed metadata map from cache (and baked-in MIDEN)
    const metadataByFaucetId = await buildMetadataMapFromCache(parsedNotes, allTokensBaseMetadataRef.current);

    // 3) Schedule background fetch for any missing metadata (non-blocking)
    // Notes without metadata will be filtered out initially but appear after SWR revalidates
    const missingFaucetIds = await findMissingFaucetIds(parsedNotes, metadataByFaucetId);
    if (missingFaucetIds.length > 0) {
      // Run when client is idle to avoid blocking critical operations
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
    // Notes without metadata will appear after metadata fetch completes and SWR revalidates
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

  // Return both SWR result and debug info (debug info only used on iOS)
  return {
    ...swrResult,
    debugInfo: isIOS() ? debugInfoRef.current : undefined
  };
}
