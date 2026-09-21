import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { InputNoteState } from '@miden-sdk/miden-sdk/lazy';

import { getFailedTransactions, verifyStuckTransactionsFromNode } from 'lib/miden/activity';
import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { useAccount } from 'lib/miden/front';
import { NoteWithMetadata, useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { assertWasmHoldCurrent, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { WalletAccount, WalletMessageType } from 'lib/shared/types';
import { getIntercom } from 'lib/store';

export interface ClaimNotesState {
  account: WalletAccount;
  isFetchingNotes: boolean;
  safeClaimableNotes: NoteWithMetadata[];
  isDelegatedProvingEnabled: boolean;
  /** Notes that failed but where a retry can still help (local failed consume / claim error). */
  retriableNoteIds: Set<string>;
  /** Notes the node/client reports as terminally Invalid — a retry cannot help. */
  invalidNoteIds: Set<string>;
  checkingNoteIds: Set<string>;
}

/**
 * Claim plumbing for the Activity tab's Pending list: claimable-notes fetching, per-note claiming
 * state, and a re-running failed/unavailable-notes check against local IndexedDB + node state
 * that keeps failed notes visible until the user can act (#456).
 *
 * It no longer performs claims of its own. The batch claimer that lived here — Claim All and the
 * per-asset group claim — belonged to the retired "Pending notes" pages; the one bulk action left
 * is the Pending list's Accept All, which goes through `useActivityClaims.acceptMany`.
 */
export function useClaimNotes(): ClaimNotesState {
  const account = useAccount();
  const address = account.publicKey;

  const { data: claimableNotes, mutate: mutateClaimableNotes, isLoading } = useClaimableNotes(address);
  const isDelegatedProvingEnabled = isDelegateProofEnabled();

  const safeClaimableNotes = useMemo(
    () => (claimableNotes ?? []).filter((n): n is NonNullable<typeof n> => n != null),
    [claimableNotes]
  );

  const [retriableNoteIds, setRetriableNoteIds] = useState<Set<string>>(new Set());
  const [invalidNoteIds, setInvalidNoteIds] = useState<Set<string>>(new Set());
  const [checkingNoteIds, setCheckingNoteIds] = useState<Set<string>>(new Set());
  // Ids that failed synchronously at claim-queue time. `initiateConsumeNotesTransaction`
  // queues inside a Dexie rw-transaction, so a throw rolls back without persisting a
  // Failed row — `getFailedTransactions` can never re-surface them. Held additively in
  // memory so the REPLACE-based recheck below doesn't wipe them on a tab-return, which
  // would silently revert the note to a neutral Claim button (#456). Pruned to
  // still-claimable, non-terminal ids on every check so recovered/removed notes clear.
  const locallyFailedNoteIdsRef = useRef<Set<string>>(new Set());

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
          // `getInputNoteDetails` lists the notes and then reads state off the
          // returned records, which are borrows of this client's RefCell rather
          // than snapshots. On this branch (mobile, desktop, and any build with
          // the offscreen client off) the call runs INLINE against the hold taken
          // right here, so the liveness check has to be handed down from here —
          // the default is a no-op and the reach-through would run on a client a
          // successor owns.
          const noteDetails = await withWasmClientLock(
            async hold =>
              midenClientProxy.getInputNoteDetails({ ids: noteIds }, () =>
                assertWasmHoldCurrent(hold, 'while reading input note details for the claim check')
              ),
            { label: 'claim-note-state-check' }
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

  return {
    account,
    // Only a read with no list on screen yet counts: the 5 s background revalidation must not
    // animate a loading bar or re-render the list on every lap, and SWR still reports the first read
    // as loading while the persisted list is on screen.
    isFetchingNotes: Boolean(isLoading) && claimableNotes === undefined,
    safeClaimableNotes,
    isDelegatedProvingEnabled,
    retriableNoteIds,
    invalidNoteIds,
    checkingNoteIds
  };
}
