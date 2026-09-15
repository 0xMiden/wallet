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
import { WASM_LOCK_SYNC_WATCHDOG_MS } from 'lib/miden/sdk/wasm-client-poison';
import { isExtension } from 'lib/platform';
import { isDelegateProofEnabled } from 'lib/settings/helpers';
import { WalletAccount, WalletMessageType } from 'lib/shared/types';
import { getIntercom } from 'lib/store';

/**
 * Cadence and ceiling for the post-claim failure watch.
 *
 * A consume can fail without ever rendering as claiming: an offline claim goes Queued → Failed in
 * well under the claimable-notes poll, so `isBeingClaimed` is never true in a sampled render and
 * `claimingSignature` never moves. Now that claiming does not navigate away, that failure would be
 * invisible to a user sitting on this list.
 *
 * A fixed schedule of a few timers does not close it — whatever the last timer is, a consume that
 * fails after it is silent forever. So this polls until the claim RESOLVES (the note stops being
 * claimable, or a failure surfaces), with a ceiling only so a wedged consume cannot poll for the
 * lifetime of the page.
 */
const POST_CLAIM_POLL_MS = 2_000;
const POST_CLAIM_MAX_MS = 120_000;

export interface ClaimNotesState {
  account: WalletAccount;
  safeClaimableNotes: NoteWithMetadata[];
  unclaimedNotes: NoteWithMetadata[];
  isDelegatedProvingEnabled: boolean;
  claimingNoteIds: Set<string>;
  /** Notes with a single-row claim in flight; the summary's in-flight count needs these too. */
  individualClaimingIds: Set<string>;
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

  // Ids with a live consume behind them, readable from `runFailedNotesCheck` without making it
  // depend on (and re-fire for) every claiming-set change. Kept in a ref for that reason.
  const liveClaimIdsRef = useRef<Set<string>>(new Set());

  /** Ids that have surfaced as failed/invalid — one way a claim RESOLVES for the watch. */
  const resolvedClaimIdsRef = useRef<Set<string>>(new Set());
  /**
   * The failure check has three triggers (the signature effect, the post-claim watch, and
   * focus/visibility) and off-extension each run takes the WASM mutex the consume pipeline needs.
   * A guard local to one of them only serialises repeats of that one, so it lives here.
   */
  const checkInFlightRef = useRef<Promise<void> | null>(null);
  /** When each optimistically-gated id was set, so the hold is bounded if live state never lands. */
  const optimisticSinceRef = useRef<Map<string, number>>(new Map());
  /** The ids the last claim covered; the watch stops once none of them is claimable any more. */
  const watchedClaimIdsRef = useRef<Set<string>>(new Set());
  /** When each watched id joined, so a wedged one ages out instead of living for the page. */
  const watchedClaimAtRef = useRef<Map<string, number>>(new Map());
  /** Ids still listed as claimable right now, for the watch's success exit. */
  const claimableIdsRef = useRef<Set<string>>(new Set());
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

  // ONLY notes with an actual live consume row. Deliberately NOT the optimistic sets: this ref
  // suppresses a note's Retry, and the optimistic gate is held until live state arrives -- so
  // including it here made a claim that FAILED before any row was observed keep its Retry
  // suppressed for the whole hold, which is the silent failure the watch exists to prevent.
  // The optimistic sets gate the BUTTON (see `inFlight` in PendingTab); this gates the RETRY.
  liveClaimIdsRef.current = new Set(safeClaimableNotes.filter(n => n.isBeingClaimed).map(n => n.id));
  resolvedClaimIdsRef.current = new Set([...retriableNoteIds, ...invalidNoteIds]);
  claimableIdsRef.current = new Set(safeClaimableNotes.map(n => n.id));

  // Release an optimistic id once the live consume row has actually taken over for that note, or
  // once the hold has outlived its ceiling. Driven by what is OBSERVED rather than by the refresh
  // promise: that promise resolves even when its read was discarded, and can also never settle.
  useEffect(() => {
    if (optimisticSinceRef.current.size === 0) return;
    const cutoff = Date.now() - POST_CLAIM_MAX_MS;
    const done: string[] = [];
    for (const [id, since] of optimisticSinceRef.current) {
      const liveRowTookOver = safeClaimableNotes.some(n => n.id === id && n.isBeingClaimed);
      const goneFromList = !claimableIdsRef.current.has(id);
      if (liveRowTookOver || goneFromList || since <= cutoff) done.push(id);
    }
    if (done.length === 0) return;
    for (const id of done) optimisticSinceRef.current.delete(id);
    setClaimingNoteIds(prev => {
      const next = new Set(prev);
      for (const id of done) next.delete(id);
      return next;
    });
  }, [safeClaimableNotes]);

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
  const runFailedNotesCheckInner = useCallback(async (showSpinner: boolean) => {
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
            { label: 'claim-note-state-check', watchdogMs: WASM_LOCK_SYNC_WATCHDOG_MS }
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
      // The liveness exclusion is applied HERE, after every await, not where the ids were
      // collected: `getFailedTransactions` is unscoped by time and liveness, and a manual retry
      // ADDS a row rather than replacing the failed one, so a note claimed again would be
      // re-flagged from its OLD row. Reading the ref before the awaits was a time-of-check /
      // time-of-use gap — a claim that went live during the check was still flagged.
      setRetriableNoteIds(
        new Set(
          [...retriableIds].filter(
            id => claimableNoteIds.has(id) && !invalidIds.has(id) && !liveClaimIdsRef.current.has(id)
          )
        )
      );
    } finally {
      if (showSpinner) setCheckingNoteIds(new Set());
    }
  }, []);

  /**
   * Coalescing wrapper: while a check is running, every other trigger joins it instead of starting
   * a second lock-bound pass. The check has THREE triggers (the signature effect, the post-claim
   * watch, focus/visibility) and off-extension each pass takes the WASM mutex the consume pipeline
   * and the 5s notes poll are already contending for, so overlapping runs are contention, not
   * parallelism. A guard local to one trigger only serialised repeats of that one.
   */
  const checkRerunPendingRef = useRef(false);

  const runFailedNotesCheck = useCallback(
    (showSpinner: boolean): Promise<void> => {
      // Joining a live check is right for CONTENTION but wrong for CORRECTNESS on its own: a
      // trigger that arrives mid-check is reporting state the running check already read past, so
      // simply returning its promise would drop that update. Remember it instead and run once more
      // against the newest state when the current pass finishes -- collapsing any number of
      // triggers during a pass into exactly one follow-up, rather than one per trigger.
      if (checkInFlightRef.current) {
        checkRerunPendingRef.current = true;
        return checkInFlightRef.current;
      }

      const start = (spinner: boolean): Promise<void> => {
        const run = runFailedNotesCheckInner(spinner).finally(() => {
          checkInFlightRef.current = null;
          if (checkRerunPendingRef.current) {
            checkRerunPendingRef.current = false;
            void start(false).catch(err => console.warn('[useClaimNotes] coalesced re-check failed:', err));
          }
        });
        checkInFlightRef.current = run;
        return run;
      };

      return start(showSpinner);
    },
    [runFailedNotesCheckInner]
  );

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
  const [postClaimTick, setPostClaimTick] = useState(0);

  useEffect(() => {
    if (postClaimTick === 0) return;

    const startedAt = Date.now();

    const timer = setInterval(() => {
      // Stop once THIS claim has resolved — either its notes are gone from the list (they were
      // consumed) or one of them has surfaced as failed/invalid and the row is showing it. Note
      // the exit cannot be "nothing is in flight": in the fast-failure case the row leaves
      // Queued before the first tick, so nothing is in flight precisely when the check is most
      // needed. Without an exit this ran every tick to the ceiling in the failed case, and
      // off-extension each tick takes the WASM lock.
      // Per id, not per batch: Claim All queues one consume PER FAUCET, so a batch can settle
      // mixed — one faucet consumed, another failed. Requiring all-consumed OR all-failed left
      // that batch watching to the ceiling; requiring only SOME to have failed tore the watch down
      // while a later faucet was still in flight. Each id is done when it is gone from the
      // claimable list or has surfaced as failed/invalid.
      // Age out ONLY. A consume that sits in Queued (a guardian 409/429 or prover-outage requeue
      // cooldown, terminal only at MAX_QUEUED_AGE = 30 min, and explicitly skipped by the 3s
      // reaper) satisfies neither settle leg, so a union-only set let one wedged note make every
      // LATER claim run the full ceiling. Ids age out on their own clock.
      //
      // Pruning DONE ids here instead would make `settled` unreachable: it asks whether every
      // watched id is done, so removing them as they finish leaves only the unfinished ones and
      // the predicate can never hold. They are cleared together, below, once all of them are.
      const cutoff = Date.now() - POST_CLAIM_MAX_MS;
      for (const [id, seenAt] of [...watchedClaimAtRef.current]) {
        if (seenAt <= cutoff) {
          console.warn('[useClaimNotes] note aged out of the post-claim watch unresolved:', id);
          watchedClaimAtRef.current.delete(id);
          watchedClaimIdsRef.current.delete(id);
        }
      }

      const watched = [...watchedClaimIdsRef.current];
      const settled =
        watched.length > 0 &&
        watched.every(id => !claimableIdsRef.current.has(id) || resolvedClaimIdsRef.current.has(id));
      if (settled) {
        watchedClaimIdsRef.current.clear();
        watchedClaimAtRef.current.clear();
      } else if (Date.now() - startedAt >= POST_CLAIM_MAX_MS) {
        // The claim never resolved and nobody is watching it any more. Silent until now, and the
        // one state a developer most needs named: these ids show neither a consume nor a Retry.
        console.warn('[useClaimNotes] post-claim watch gave up with notes unresolved:', watched);
      }
      if (settled || Date.now() - startedAt >= POST_CLAIM_MAX_MS) {
        clearInterval(timer);
        return;
      }
      // The check's own catch: an unhandled rejection here would take the whole watch down and
      // skip every remaining tick, which is the failure this watch exists to report.
      void runFailedNotesCheck(false).catch(err =>
        console.warn('[useClaimNotes] post-claim failure re-check failed:', err)
      );
    }, POST_CLAIM_POLL_MS);

    return () => clearInterval(timer);
  }, [postClaimTick, runFailedNotesCheck]);

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
        console.warn('[useClaimNotes] claim requested but no note was claimable at queue time');
        return;
      }

      const notesToClaim = freshUnclaimedNotes.filter((n): n is NonNullable<typeof n> => n != null);
      const noteIds = notesToClaim.map(n => n.id);
      setClaimingNoteIds(prev => new Set([...prev, ...noteIds]));

      // Optimistically clear retriable badges for the notes now being retried (they render as
      // 'consuming' while in flight); a queue-time throw below re-flags them. Scoped to THIS
      // batch, like its neighbour: removing the navigation made two batches concurrently
      // reachable, and a wholesale wipe clears another batch's red badge and its Retry.
      setRetriableNoteIds(prev => {
        const next = new Set(prev);
        for (const id of noteIds) next.delete(id);
        return next;
      });
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
        // The rows are enqueued: nothing below may be allowed to strand them, so the driver goes
        // FIRST. Off-extension this is the ONLY thing that turns the FIFO loop from here.
        if (batchTxId) {
          if (isExtension()) {
            requestSWTransactionProcessing();
          } else {
            startBackgroundTransactionProcessing(signTransaction, false, zustandProvider);
          }
        }

        // Watch for a consume that fails before the gate can render it (see the watcher above).
        // Fires whether or not anything queued: a queue-time throw is already recorded above, but a
        // row that queues and then fails immediately is not.
        // Union, not replace: a second Claim All while the first is still settling would
        // otherwise drop the first batch's ids and abandon its failure detection. Ids leave this
        // set by settling, not by being overwritten.
        const joinedAt = Date.now();
        for (const n of notesToClaim) {
          watchedClaimIdsRef.current.add(n.id);
          if (!watchedClaimAtRef.current.has(n.id)) watchedClaimAtRef.current.set(n.id, joinedAt);
        }
        setPostClaimTick(tick => tick + 1);
      } finally {
        // Kick a refresh so the live consume row surfaces sooner than the poll would, but do NOT
        // hand the gate over on its promise. That promise resolves even when nothing was applied --
        // a read discarded as belonging to a previous account resolves normally -- and it may never
        // settle at all, so neither `then` nor `catch` is a signal that live state has arrived.
        //
        // The handover is driven by OBSERVATION instead, in the effect below: an id is released
        // once the note actually reports `isBeingClaimed`, with a bounded fallback so a refresh
        // that never delivers cannot strand the gate.
        void mutateClaimableNotes().catch(err =>
          console.warn('[useClaimNotes] post-claim refresh failed; holding the claim gate', err)
        );
        for (const id of noteIds) {
          if (!optimisticSinceRef.current.has(id)) optimisticSinceRef.current.set(id, Date.now());
        }
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
    individualClaimingIds,
    retriableNoteIds,
    invalidNoteIds,
    checkingNoteIds,
    handleClaimingStateChange,
    handleClaimAll,
    handleClaimGroup
  };
}
