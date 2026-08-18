import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { InputNoteState } from '@miden-sdk/miden-sdk/lazy';

import { NoteWithMetadata } from 'app/pages/Receive/PendingTab';
import {
  getFailedTransactions,
  initiateConsumeNotesTransaction,
  requestSWTransactionProcessing,
  verifyStuckTransactionsFromNode
} from 'lib/miden/activity';
import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { useAccount } from 'lib/miden/front';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { WalletAccount, WalletMessageType } from 'lib/shared/types';
import { getIntercom } from 'lib/store';
import { navigate } from 'lib/woozie';

export interface ClaimNotesState {
  account: WalletAccount;
  safeClaimableNotes: NoteWithMetadata[];
  unclaimedNotes: NoteWithMetadata[];
  isDelegatedProvingEnabled: boolean;
  claimingNoteIds: Set<string>;
  /** Notes that failed but where a retry can still help (local failed consume / claim error). */
  retriableNoteIds: Set<string>;
  /** Notes the node/client reports as terminally Invalid — a retry cannot help. */
  invalidNoteIds: Set<string>;
  checkingNoteIds: Set<string>;
  handleClaimingStateChange: (noteId: string, isClaiming: boolean) => void;
  handleClaimAll: () => Promise<void>;
  handleClaimGroup: (faucetId: string) => Promise<void>;
}

/**
 * Claim plumbing for PendingTab: claimable-notes fetching, batch claiming
 * (Claim All / per-asset group), per-note claiming state, and a re-running
 * failed/unavailable-notes check against local IndexedDB + node state that
 * keeps failed notes visible until the user can act (#456).
 *
 * Extracted from Receive.tsx so any page can host the pending-notes UI.
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
  const [retriableNoteIds, setRetriableNoteIds] = useState<Set<string>>(new Set());
  const [invalidNoteIds, setInvalidNoteIds] = useState<Set<string>>(new Set());
  const [checkingNoteIds, setCheckingNoteIds] = useState<Set<string>>(new Set());
  const claimAllAbortRef = useRef<AbortController | null>(null);
  // Ids that failed synchronously at claim-queue time. `initiateConsumeNotesTransaction`
  // queues inside a Dexie rw-transaction, so a throw rolls back without persisting a
  // Failed row — `getFailedTransactions` can never re-surface them. Held additively in
  // memory so the REPLACE-based recheck below doesn't wipe them on a tab-return, which
  // would silently revert the note to a neutral Claim button (#456). Pruned to
  // still-claimable, non-terminal ids on every check so recovered/removed notes clear.
  const locallyFailedNoteIdsRef = useRef<Set<string>>(new Set());

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

  // Keep the latest claimable notes reachable from the stable check callback
  // (focus / visibility handlers) without re-subscribing them every render.
  const safeClaimableNotesRef = useRef(safeClaimableNotes);
  safeClaimableNotesRef.current = safeClaimableNotes;

  // Check for failed/unavailable notes from both local IndexedDB (retriable —
  // a failed consume that a retry can recover) and node/client state (terminal
  // Invalid — a retry cannot help). Splitting the two lets the UI keep a Retry
  // affordance for the former and suppress it for the latter.
  //
  // Each run REPLACES both sets, scoped to the ids still claimable right now, so
  // a note that recovered — or left the list — clears instead of latching (#456).
  // Only the first check with notes present shows the checking spinner; every
  // background re-run stays silent. No polling interval is added.
  const runFailedNotesCheck = useCallback(async (showSpinner: boolean) => {
    const notes = safeClaimableNotesRef.current;
    if (notes.length === 0) {
      // Nothing claimable: drop any stale flags so old badges don't linger.
      locallyFailedNoteIdsRef.current = new Set();
      setRetriableNoteIds(new Set());
      setInvalidNoteIds(new Set());
      return;
    }

    const claimableNoteIds = new Set(notes.map(n => n.id));
    if (showSpinner) setCheckingNoteIds(new Set(claimableNoteIds));

    const retriableIds = new Set<string>();
    const invalidIds = new Set<string>();

    try {
      const failedTxs = await getFailedTransactions();
      for (const tx of failedTxs) {
        if (tx.type !== 'consume') continue;
        for (const failedNoteId of tx.noteIds ?? (tx.noteId ? [tx.noteId] : [])) {
          retriableIds.add(failedNoteId);
        }
      }

      try {
        if (isExtension()) {
          const res = await getIntercom().request({
            type: WalletMessageType.GetInputNoteDetailsRequest,
            noteIds: notes.map(n => n.id)
          });
          if (res && 'type' in res && res.type === WalletMessageType.GetInputNoteDetailsResponse) {
            for (const note of res.notes) {
              if (note.state === 'Invalid') {
                invalidIds.add(note.noteId);
              }
            }
          }
        } else {
          const noteIds = notes.map(n => n.id);
          const noteDetails = await withWasmClientLock(async () =>
            midenClientProxy.getInputNoteDetails({ ids: noteIds })
          );

          for (const note of noteDetails) {
            if (note.state === InputNoteState.Invalid) {
              invalidIds.add(note.noteId);
            }
          }
        }
      } catch (err) {
        console.error('[useClaimNotes] Error checking node state for notes:', err);
      }

      // Fold in ids that failed synchronously at queue time (never persisted as a
      // Failed tx). Prune the memory-only set to still-claimable, non-terminal ids
      // first so recovered/removed/now-Invalid notes clear, then union what remains.
      locallyFailedNoteIdsRef.current = new Set(
        [...locallyFailedNoteIdsRef.current].filter(id => claimableNoteIds.has(id) && !invalidIds.has(id))
      );
      for (const id of locallyFailedNoteIdsRef.current) retriableIds.add(id);

      // REPLACE (not union), scoped to the ids still claimable right now. A note
      // reported Invalid is terminal and takes precedence over a retriable flag.
      setInvalidNoteIds(new Set([...invalidIds].filter(id => claimableNoteIds.has(id))));
      setRetriableNoteIds(new Set([...retriableIds].filter(id => claimableNoteIds.has(id) && !invalidIds.has(id))));
    } finally {
      if (showSpinner) setCheckingNoteIds(new Set());
    }
  }, []);

  // Primary re-run trigger: the claimable-id signature changing (notes added,
  // removed, or claimed away). The first check with notes present shows the
  // spinner; later signature changes re-check silently.
  const claimableSignature = useMemo(
    () =>
      safeClaimableNotes
        .map(n => n.id)
        .sort()
        .join(','),
    [safeClaimableNotes]
  );
  const hasShownInitialSpinner = useRef(false);

  useEffect(() => {
    const showSpinner = !hasShownInitialSpinner.current && safeClaimableNotesRef.current.length > 0;
    if (showSpinner) hasShownInitialSpinner.current = true;
    runFailedNotesCheck(showSpinner);
  }, [claimableSignature, runFailedNotesCheck]);

  // Also re-check when the user returns to the tab: a consume may have failed
  // (or a note gone terminal) while the page was backgrounded. Never shows the
  // spinner.
  useEffect(() => {
    const recheck = () => runFailedNotesCheck(false);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') recheck();
    };
    window.addEventListener('focus', recheck);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('focus', recheck);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [runFailedNotesCheck]);

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

      // Optimistically clear retriable badges for the notes now being retried
      // (they render as 'consuming' while in flight); a queue-time throw below
      // re-flags them.
      setRetriableNoteIds(new Set());
      for (const id of noteIds) locallyFailedNoteIdsRef.current.delete(id);

      try {
        let batchTxId: string | null = null;
        try {
          // One consume transaction for the whole batch — both the WASM client
          // and the Guardian consume proposal take multiple note ids, so this
          // is a single proof/submit instead of one per note. User tapped
          // Claim All — bypass the auto-consume backoff gate so failed notes
          // can be retried on demand.
          batchTxId = await initiateConsumeNotesTransaction(
            account.publicKey,
            notesToClaim,
            isDelegatedProvingEnabled,
            true
          );
        } catch (err) {
          console.error('Error queuing notes for claim:', noteIds, err);
          // Record the failure in the memory-only set too: this queue-time throw
          // rolled back its Dexie transaction, so getFailedTransactions can't
          // re-surface it and the REPLACE-based recheck would otherwise wipe the
          // flag on the next focus/visibility tick (#456).
          for (const id of noteIds) locallyFailedNoteIdsRef.current.add(id);
          setRetriableNoteIds(prev => new Set([...prev, ...noteIds]));
          setClaimingNoteIds(prev => {
            const next = new Set(prev);
            for (const noteId of noteIds) next.delete(noteId);
            return next;
          });
        }

        if (isExtension()) {
          // On extension: fire-and-forget — SW handles processing.
          // Keep the Claim All action disabled until sync removes the queued notes.
          requestSWTransactionProcessing();
        }

        if (batchTxId && !signal.aborted) {
          navigate(`/generating-transaction-full/${encodeURIComponent(batchTxId)}`);
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
    isDelegatedProvingEnabled,
    claimingNoteIds,
    retriableNoteIds,
    invalidNoteIds,
    checkingNoteIds,
    handleClaimingStateChange,
    handleClaimAll,
    handleClaimGroup
  };
}
