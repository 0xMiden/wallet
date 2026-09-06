import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { InputNoteState } from '@miden-sdk/miden-sdk/lazy';

import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { NoteWithMetadata } from 'app/pages/Receive/PendingTab';
import {
  getFailedTransactions,
  initiateConsumeNotesTransaction,
  requestSWTransactionProcessing,
  startBackgroundTransactionProcessing,
  verifyStuckTransactionsFromNode
} from 'lib/miden/activity';
import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { useAccount, useMidenContext } from 'lib/miden/front';
import { useClaimableNotes } from 'lib/miden/front/claimable-notes';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import { assertWasmHoldCurrent, withWasmClientLock } from 'lib/miden/sdk/miden-client';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { WalletAccount, WalletMessageType } from 'lib/shared/types';
import { getIntercom } from 'lib/store';

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
  const { signTransaction } = useMidenContext();
  const nativeFaucetId = useMidenFaucetId();
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
  // Which notes currently have a live consume behind them. A consume that FAILS leaves
  // Queued/GeneratingTransaction, so `isBeingClaimed` flips back to false while the note stays
  // claimable and its id never changes -- meaning `claimableSignature` does NOT move. Without
  // this second signature the row would quietly revert from "Claiming…" to "Claim" with no
  // error, which is exactly the #456 silent-failure regression, and now reachable without
  // leaving the page because claiming no longer navigates away.
  const claimingSignature = useMemo(
    () =>
      safeClaimableNotes
        .filter(n => n.isBeingClaimed)
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
  }, [claimableSignature, claimingSignature, runFailedNotesCheck]);

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
        // One consume transaction PER FAUCET, not one for the whole batch.
        //
        // A completed consume row carries a single (faucetId, amount) pair:
        // `completeConsumeTransaction` takes the faucet from the FIRST input
        // note and then sums only the assets whose faucet matches it. A
        // mixed-faucet batch therefore recorded "Received 10 MIDEN" for a
        // transaction that also delivered 25 USDC, and nothing else ever
        // creates a row for the dropped asset — it is absent from the activity
        // list and from the detail screen, and `tx.faucetId` reconciliation
        // (swap/bridge) never sees it. Grouping makes each row's asset
        // attribution correct BY CONSTRUCTION, which is the shape
        // `handleClaimGroup` already produced; the cost is one proof per
        // distinct asset instead of one for the batch. Notes sharing a faucet
        // still go out in a single proof/submit.
        const byFaucet = new Map<string, NoteWithMetadata[]>();
        for (const note of notesToClaim) {
          const group = byFaucet.get(note.faucetId);
          if (group) {
            group.push(note);
          } else {
            byFaucet.set(note.faucetId, [note]);
          }
        }

        // Native-asset group FIRST. The fee is withdrawn from this account's own vault,
        // and a consume credits that vault before `pay_fee` takes from it -- so claiming
        // the native note funds the groups that follow. Attempt a non-native group first
        // on an empty vault and it fails on the fee, with a native note sitting unclaimed
        // that would have paid for it. Map order is note-arrival order, so before this the
        // outcome depended on which note happened to land first.
        const orderedGroups = [...byFaucet.entries()]
          .sort(([a], [b]) => Number(b === nativeFaucetId) - Number(a === nativeFaucetId))
          .map(([, groupNotes]) => groupNotes);

        for (const groupNotes of orderedGroups) {
          const groupNoteIds = groupNotes.map(n => n.id);
          try {
            // User tapped Claim All — bypass the auto-consume backoff gate so
            // failed notes can be retried on demand.
            const groupTxId = await initiateConsumeNotesTransaction(
              account.publicKey,
              groupNotes,
              isDelegatedProvingEnabled,
              true
            );
            batchTxId = batchTxId ?? groupTxId;
          } catch (err) {
            console.error('Error queuing notes for claim:', groupNoteIds, err);
            // Record the failure in the memory-only set too: this queue-time throw
            // rolled back its Dexie transaction, so getFailedTransactions can't
            // re-surface it and the REPLACE-based recheck would otherwise wipe the
            // flag on the next focus/visibility tick (#456). Scoped to the failing
            // group so the faucets that DID queue stay marked as claiming.
            for (const id of groupNoteIds) locallyFailedNoteIdsRef.current.add(id);
            setRetriableNoteIds(prev => new Set([...prev, ...groupNoteIds]));
            setClaimingNoteIds(prev => {
              const next = new Set(prev);
              for (const noteId of groupNoteIds) next.delete(noteId);
              return next;
            });
          }
        }

        // Claiming does NOT navigate. It used to push the full-screen progress route, which
        // stranded the user: the consume finishes in ~2s but the page stays, and a note arriving
        // meanwhile is invisible there because that page watches one row by id. The pending row
        // reports progress in place instead (its "Claiming…" control is still a way IN to the
        // progress screen when the user wants it).
        //
        // Removing the navigation removes a load-bearing side effect, which is why the driver
        // below is not optional: off-extension, the progress page's own interval was the only
        // thing turning the FIFO loop in this path, so without this a claim sits Queued forever.
        // Same shape as Explore's auto-consume, which has always claimed without navigating.
        if (batchTxId) {
          if (isExtension()) {
            requestSWTransactionProcessing();
          } else {
            startBackgroundTransactionProcessing(signTransaction, false, zustandProvider);
          }
        }
      } finally {
        // The live consume row is the gate on every platform now (`claimingTxIdByNoteId`), and
        // it exists from the moment the row is enqueued. This local set no longer has to be held
        // open on extension to keep the button hidden -- and holding it was what made a FAILED
        // batch claim unrecoverable, since nothing else ever cleared it.
        setClaimingNoteIds(new Set());
      }
    },
    [
      unclaimedNotes,
      account.publicKey,
      isDelegatedProvingEnabled,
      mutateClaimableNotes,
      signTransaction,
      claimingNoteIds,
      individualClaimingIds,
      // Read by the native-first ordering above. Omitted, this callback captures the
      // faucet id from first render -- `null` until discovery resolves -- and the
      // ordering silently stops preferring the native asset, which is its whole
      // point: a token note claimed first against an empty vault cannot pay its fee.
      nativeFaucetId
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
