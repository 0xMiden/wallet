import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { InputNoteState } from '@miden-sdk/miden-sdk/lazy';

import { NoteWithMetadata } from 'app/pages/Receive/PendingTab';
import {
  getFailedTransactions,
  initiateConsumeTransaction,
  requestSWTransactionProcessing,
  verifyStuckTransactionsFromNode,
  waitForConsumeTx
} from 'lib/miden/activity';
import { useAccount } from 'lib/miden/front';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { isExtension, isMobile } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { WalletAccount, WalletMessageType } from 'lib/shared/types';
import { getIntercom, useWalletStore } from 'lib/store';
import { HistoryAction, navigate } from 'lib/woozie';

export interface ClaimNotesState {
  account: WalletAccount;
  safeClaimableNotes: NoteWithMetadata[];
  unclaimedNotes: NoteWithMetadata[];
  mutateClaimableNotes: ReturnType<typeof useClaimableNotes>['mutate'];
  isDelegatedProvingEnabled: boolean;
  claimingNoteIds: Set<string>;
  failedNoteIds: Set<string>;
  checkingNoteIds: Set<string>;
  handleClaimingStateChange: (noteId: string, isClaiming: boolean) => void;
  handleClaimAll: () => Promise<void>;
  handleClaimGroup: (faucetId: string) => Promise<void>;
}

/**
 * Claim plumbing for the pending-notes surface: claimable-notes fetching, batch
 * claiming (Claim All / per-asset group), per-note claiming state, and a
 * one-shot failed-notes check against local IndexedDB + node state.
 *
 * Extracted from the old `Pending` page so any page can host the pending-notes
 * UI — `PendingNotes` renders the presentation (`PendingTab`) on top of it.
 */
export function useClaimNotes(): ClaimNotesState {
  const account = useAccount();
  const address = account.publicKey;

  const { data: claimableNotes, mutate: mutateClaimableNotes } = useClaimableNotes(address);
  const isDelegatedProvingEnabled = isDelegateProofEnabled();
  const safeClaimableNotes = useMemo(
    () => (claimableNotes ?? []).filter((n): n is NonNullable<typeof n> => n != null),
    [claimableNotes]
  );
  const [claimingNoteIds, setClaimingNoteIds] = useState<Set<string>>(new Set());
  const [individualClaimingIds, setIndividualClaimingIds] = useState<Set<string>>(new Set());
  const [failedNoteIds, setFailedNoteIds] = useState<Set<string>>(new Set());
  const [checkingNoteIds, setCheckingNoteIds] = useState<Set<string>>(new Set());
  const claimAllAbortRef = useRef<AbortController | null>(null);

  const handleClaimingStateChange = useCallback((noteId: string, isClaiming: boolean) => {
    setIndividualClaimingIds(prev => {
      const next = new Set(prev);
      if (isClaiming) {
        next.add(noteId);
      } else {
        next.delete(noteId);
      }
      return next;
    });
  }, []);

  // Notes that are not currently being claimed (available for "Claim All").
  // A note is claimable if it's not being claimed via:
  // - IndexedDB (isBeingClaimed) - from previous sessions or after tx queued
  // - Claim All operation (claimingNoteIds) - current batch operation
  // - Individual claim (individualClaimingIds) - user clicked single Claim button
  const unclaimedNotes = safeClaimableNotes.filter(
    n => !n.isBeingClaimed && !claimingNoteIds.has(n.id) && !individualClaimingIds.has(n.id)
  );

  useEffect(() => {
    return () => {
      claimAllAbortRef.current?.abort();
    };
  }, []);

  // Poll for stuck transactions and verify their state from the node.
  // On extension, skip — the SW handles stuck transaction cleanup via generateTransactionsLoop.
  useEffect(() => {
    if (isExtension()) return;

    const checkStuckTransactions = async () => {
      const resolved = await verifyStuckTransactionsFromNode();
      if (resolved > 0) {
        mutateClaimableNotes();
      }
    };

    checkStuckTransactions();

    const interval = setInterval(checkStuckTransactions, 3000);
    return () => clearInterval(interval);
  }, [mutateClaimableNotes]);

  // Check for failed notes: both from local IndexedDB and node state (only once on mount).
  const hasCheckedFailedNotes = useRef(false);
  useEffect(() => {
    const checkFailedNotes = async () => {
      if (safeClaimableNotes.length === 0) return;
      if (hasCheckedFailedNotes.current) return;
      hasCheckedFailedNotes.current = true;

      const noteIdsToCheck = new Set(safeClaimableNotes.map(n => n.id));
      setCheckingNoteIds(noteIdsToCheck);

      const failedIds = new Set<string>();

      try {
        const failedTxs = await getFailedTransactions();
        for (const tx of failedTxs) {
          if (tx.type === 'consume' && tx.noteId) {
            failedIds.add(tx.noteId);
          }
        }

        try {
          if (isExtension()) {
            const res = await getIntercom().request({
              type: WalletMessageType.GetInputNoteDetailsRequest,
              noteIds: safeClaimableNotes.map(n => n.id)
            });
            if (res && 'type' in res && res.type === WalletMessageType.GetInputNoteDetailsResponse) {
              for (const note of res.notes) {
                if (note.state === 'Invalid') {
                  failedIds.add(note.noteId);
                }
              }
            }
          } else {
            const noteIds = safeClaimableNotes.map(n => n.id);
            const noteDetails = await withWasmClientLock(async () => {
              const midenClient = await getMidenClient();
              return await midenClient.getInputNoteDetails({ ids: noteIds });
            });

            for (const note of noteDetails) {
              if (note.state === InputNoteState.Invalid) {
                failedIds.add(note.noteId);
              }
            }
          }
        } catch (err) {
          console.error('[useClaimNotes] Error checking node state for notes:', err);
        }

        const claimableNoteIds = new Set(safeClaimableNotes.map(n => n.id));
        const failedClaimableNotes = new Set([...failedIds].filter(id => claimableNoteIds.has(id)));

        if (failedClaimableNotes.size > 0) {
          setFailedNoteIds(prev => new Set([...prev, ...failedClaimableNotes]));
        }
      } finally {
        setCheckingNoteIds(new Set());
      }
    };

    checkFailedNotes();
  }, [safeClaimableNotes]);

  const claimNotesBatch = useCallback(
    async (filter?: (note: NoteWithMetadata) => boolean) => {
      claimAllAbortRef.current?.abort();
      claimAllAbortRef.current = new AbortController();
      const signal = claimAllAbortRef.current.signal;

      // Refresh the claimable notes list before queueing to avoid race conditions
      // with auto-consume (Explore page may have already started claiming some notes).
      const freshNotes = await mutateClaimableNotes();
      let freshUnclaimedNotes = freshNotes
        ? freshNotes.filter(
            n => n && !n.isBeingClaimed && !claimingNoteIds.has(n.id) && !individualClaimingIds.has(n.id)
          )
        : unclaimedNotes;

      if (filter) {
        freshUnclaimedNotes = freshUnclaimedNotes.filter(n => n && filter(n));
      }

      if (freshUnclaimedNotes.length === 0) {
        return;
      }

      const notesToClaim = freshUnclaimedNotes.filter((n): n is NonNullable<typeof n> => n != null);
      const noteIds = notesToClaim.map(n => n.id);
      setClaimingNoteIds(prev => new Set([...prev, ...noteIds]));

      setFailedNoteIds(new Set());

      try {
        const transactionIds: { noteId: string; txId: string }[] = [];
        for (const note of notesToClaim) {
          try {
            const id = await initiateConsumeTransaction(account.publicKey, note, isDelegatedProvingEnabled);
            transactionIds.push({ noteId: note.id, txId: id });
          } catch (err) {
            console.error('Error queuing note for claim:', note.id, err);
            setFailedNoteIds(prev => new Set(prev).add(note.id));
            setClaimingNoteIds(prev => {
              const next = new Set(prev);
              next.delete(note.id);
              return next;
            });
          }
        }

        if (isExtension()) {
          // On extension: fire-and-forget — SW handles processing.
          // Notes show "claiming" spinner via claimingNoteIds + NoteClaimStarted broadcast.
          // Notes disappear when sync cycle removes them from getConsumableNotes().
          requestSWTransactionProcessing();
        } else {
          useWalletStore.getState().openTransactionModal();

          for (const { noteId, txId } of transactionIds) {
            if (signal.aborted) break;
            try {
              await waitForConsumeTx(txId, signal);
            } catch (err) {
              if (err instanceof DOMException && err.name === 'AbortError') {
                break;
              }
              console.error('Error waiting for transaction:', txId, err);
              setFailedNoteIds(prev => new Set(prev).add(noteId));
            }
          }

          await mutateClaimableNotes();

          if (isMobile()) {
            navigate('/', HistoryAction.Replace);
          }
        }
      } finally {
        if (!isExtension()) {
          setClaimingNoteIds(new Set());
        }
        // On extension, keep claimingNoteIds set — they'll be cleared when notes disappear from sync.
      }
    },
    [
      unclaimedNotes,
      account.publicKey,
      isDelegatedProvingEnabled,
      mutateClaimableNotes,
      claimingNoteIds,
      individualClaimingIds
    ]
  );

  const handleClaimAll = useCallback(async () => {
    if (unclaimedNotes.length === 0) return;
    await claimNotesBatch();
  }, [unclaimedNotes.length, claimNotesBatch]);

  const handleClaimGroup = useCallback(
    async (faucetId: string) => {
      await claimNotesBatch(n => n.faucetId === faucetId);
    },
    [claimNotesBatch]
  );

  return {
    account,
    safeClaimableNotes,
    unclaimedNotes,
    mutateClaimableNotes,
    isDelegatedProvingEnabled,
    claimingNoteIds,
    failedNoteIds,
    checkingNoteIds,
    handleClaimingStateChange,
    handleClaimAll,
    handleClaimGroup
  };
}
