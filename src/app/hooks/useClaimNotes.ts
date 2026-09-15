import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { InputNoteState } from '@miden-sdk/miden-sdk/lazy';

import { isNoteInFlight } from 'app/hooks/noteClaimState';
import useMidenFaucetId from 'app/hooks/useMidenFaucetId';
import { NoteWithMetadata } from 'app/pages/Receive/PendingTab';
import {
  getFailedTransactions,
  queueConsumeNotes,
  requestSWTransactionProcessing,
  startBackgroundTransactionProcessing,
  verifyStuckTransactionsFromNode
} from 'lib/miden/activity';
import { midenClientProxy } from 'lib/miden/back/miden-client-proxy';
import { useAccount, useMidenContext } from 'lib/miden/front';
import { groupNotesForClaim } from 'lib/miden/front/claim-groups';
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
 * A fixed schedule of a few timers does not close it: whatever the last timer is, a consume that
 * fails after it is silent forever. So this polls until the claim RESOLVES (the note stops being
 * claimable, or a failure surfaces), with a ceiling only so a wedged consume cannot poll for the
 * lifetime of the page.
 */
const POST_CLAIM_POLL_MS = 2_000;
const POST_CLAIM_MAX_MS = 120_000;

export interface ClaimNotesState {
  account: WalletAccount;
  isFetchingNotes: boolean;
  safeClaimableNotes: NoteWithMetadata[];
  unclaimedNotes: NoteWithMetadata[];
  isDelegatedProvingEnabled: boolean;
  claimingNoteIds: Set<string>;
  /** Notes that failed but where a retry can still help (local failed consume / claim error). */
  retriableNoteIds: Set<string>;
  /** Notes the node/client reports as terminally Invalid — a retry cannot help. */
  invalidNoteIds: Set<string>;
  checkingNoteIds: Set<string>;
  /** Claims one note on the gated path Claim All uses; resolves to its covering row's id, or null if none queued. */
  handleClaimNote: (note: NoteWithMetadata) => Promise<string | null>;
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

  const { data: claimableNotes, mutate: mutateClaimableNotes, isLoading } = useClaimableNotes(address);
  const isDelegatedProvingEnabled = isDelegateProofEnabled();

  const safeClaimableNotes = useMemo(
    () => (claimableNotes ?? []).filter((n): n is NonNullable<typeof n> => n != null),
    [claimableNotes]
  );

  const [claimingNoteIds, setClaimingNoteIds] = useState<Set<string>>(new Set());

  // Ids with a live consume behind them, readable from `runFailedNotesCheck` without making it
  // depend on (and re-fire for) every claiming-set change. Kept in a ref for that reason.
  const liveClaimIdsRef = useRef<Set<string>>(new Set());

  /** Ids that have surfaced as failed/invalid: one way a claim RESOLVES for the watch. */
  const resolvedClaimIdsRef = useRef<Set<string>>(new Set());
  /**
   * The failure check has three triggers (the signature effect, the post-claim watch, and
   * focus/visibility) and off-extension each run takes the WASM mutex the consume pipeline needs.
   * A guard local to one of them only serialises repeats of that one, so it lives here.
   */
  const checkInFlightRef = useRef<Promise<void> | null>(null);
  /** When each optimistically-gated id was set, so the hold is bounded if live state never lands. */
  const optimisticSinceRef = useRef<Map<string, number>>(new Map());
  /** The consume transaction THIS claim queued for each held id; only that transaction's failure ends the hold. */
  const claimTxIdByNoteIdRef = useRef<Map<string, string>>(new Map());
  /** Deadline timers for the holds, so each ends on its own clock and none outlives the hook. */
  const holdDeadlineTimersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  /**
   * The ids the last claims covered, keyed to when each joined: the watch stops once none of them is claimable any
   * more, and a wedged one ages out instead of living for the page.
   */
  const watchedClaimAtRef = useRef<Map<string, number>>(new Map());
  /** Ids still listed as claimable right now, for the watch's success exit. */
  const claimableIdsRef = useRef<Set<string>>(new Set());
  const [retriableNoteIds, setRetriableNoteIds] = useState<Set<string>>(new Set());
  const [invalidNoteIds, setInvalidNoteIds] = useState<Set<string>>(new Set());
  const [checkingNoteIds, setCheckingNoteIds] = useState<Set<string>>(new Set());
  // Ids that failed synchronously at claim-queue time. `queueConsumeNotes`
  // queues inside a Dexie rw-transaction, so a throw rolls back without persisting a
  // Failed row — `getFailedTransactions` can never re-surface them. Held additively in
  // memory so the REPLACE-based recheck below doesn't wipe them on a tab-return, which
  // would silently revert the note to a neutral Claim button (#456). Pruned to
  // still-claimable, non-terminal ids on every check so recovered/removed notes clear.
  const locallyFailedNoteIdsRef = useRef<Set<string>>(new Set());

  // Notes that are not currently being claimed (available for "Claim All").
  // A note is claimable if it's not being claimed via:
  // - IndexedDB (isBeingClaimed) - from previous sessions or after tx queued
  // - a claim this page queued (claimingNoteIds) - Claim All, a group, or a single row
  // - the cache-first list (fromCache) — an entry no live read has confirmed yet is
  //   shown, never claimed: it may already be spent, consumed or recalled.
  const unclaimedNotes = safeClaimableNotes.filter(n => !n.fromCache && !isNoteInFlight(n, claimingNoteIds));

  // ONLY notes with an actual live consume row. The optimistic holds are kept out of Retry separately, inside the
  // check and after it has released every hold whose own row failed: excluding them here, before that release, kept a
  // claim that FAILED before any row was observed from showing Retry for the whole hold.
  liveClaimIdsRef.current = new Set(safeClaimableNotes.filter(n => n.isBeingClaimed).map(n => n.id));
  resolvedClaimIdsRef.current = new Set([...retriableNoteIds, ...invalidNoteIds]);
  claimableIdsRef.current = new Set(safeClaimableNotes.map(n => n.id));

  // Ends optimistic holds: deletes the hold and its transaction id, then drops the ids from the gate. A later claim of
  // the same note therefore starts a fresh hold instead of inheriting an old date or transaction.
  const releaseOptimisticHolds = useCallback((ids: Iterable<string>) => {
    const released: string[] = [];
    for (const id of ids) {
      if (!optimisticSinceRef.current.delete(id)) continue;
      claimTxIdByNoteIdRef.current.delete(id);
      released.push(id);
    }
    if (released.length === 0) return;
    setClaimingNoteIds(prev => {
      const next = new Set(prev);
      for (const id of released) next.delete(id);
      return next;
    });
  }, []);
  // The failure check is a stable callback, so it reaches the helper through a ref, the same way it reads
  // safeClaimableNotesRef.
  const releaseOptimisticHoldsRef = useRef(releaseOptimisticHolds);
  releaseOptimisticHoldsRef.current = releaseOptimisticHolds;

  useEffect(() => {
    const timers = holdDeadlineTimersRef.current;
    return () => {
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
    };
  }, []);

  // Release an optimistic id once the live consume row has actually taken over for that note, or the note has left
  // the list. Driven by what is OBSERVED rather than by the refresh promise: that promise resolves even when its read
  // was discarded, and can also never settle. The other two exits do not wait for a list change: the failure check
  // ends a hold when this claim's own transaction fails, and each hold's deadline timer ends it at POST_CLAIM_MAX_MS.
  useEffect(() => {
    if (optimisticSinceRef.current.size === 0) return;
    const done = [...optimisticSinceRef.current.keys()].filter(
      id => safeClaimableNotes.some(n => n.id === id && n.isBeingClaimed) || !claimableIdsRef.current.has(id)
    );
    releaseOptimisticHolds(done);
  }, [safeClaimableNotes, releaseOptimisticHolds]);

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
      const failedConsumeTxIds = new Set<string>();
      for (const tx of failedTxs) {
        if (tx.type !== 'consume') continue;
        failedConsumeTxIds.add(tx.id);
        for (const failedNoteId of tx.noteIds ?? (tx.noteId ? [tx.noteId] : [])) {
          retriableIds.add(failedNoteId);
        }
      }
      // A hold ends on the failure of the transaction THIS claim queued, matched by id. Membership in the retriable
      // set is not enough: these rows are unscoped, so a note claimed again still has its earlier Failed row.
      releaseOptimisticHoldsRef.current(
        [...claimTxIdByNoteIdRef.current].filter(([, txId]) => failedConsumeTxIds.has(txId)).map(([id]) => id)
      );

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
      // time-of-use gap: a claim that went live during the check was still flagged.
      // A held id is left out the same way. The release above already ended every hold whose own row failed, so an id
      // still held has a claim pending, and an earlier attempt's Failed row must neither flag it nor settle its watch.
      setRetriableNoteIds(
        new Set(
          [...retriableIds].filter(
            id =>
              claimableNoteIds.has(id) &&
              !invalidIds.has(id) &&
              !liveClaimIdsRef.current.has(id) &&
              !optimisticSinceRef.current.has(id)
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
      // Stop once THIS claim has resolved: either its notes are gone from the list (they were
      // consumed) or one of them has surfaced as failed/invalid and the row is showing it. Note
      // the exit cannot be "nothing is in flight": in the fast-failure case the row leaves
      // Queued before the first tick, so nothing is in flight precisely when the check is most
      // needed. Without an exit this ran every tick to the ceiling in the failed case, and
      // off-extension each tick takes the WASM lock.
      // Per id, not per batch: Claim All queues one consume PER FAUCET, so a batch can settle
      // mixed: one faucet consumed, another failed. Requiring all-consumed OR all-failed left
      // that batch watching to the ceiling; requiring only SOME to have failed tore the watch down
      // while a later faucet was still in flight. Each id is done when it is gone from the
      // claimable list, or has surfaced as failed/invalid with no hold still open for it: an open
      // hold ends only through the check this watch runs, so a flag from an earlier attempt's row
      // or an Invalid report must not stop the watch before it.
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
        }
      }

      const watched = [...watchedClaimAtRef.current.keys()];
      const settled =
        watched.length > 0 &&
        watched.every(
          id =>
            !claimableIdsRef.current.has(id) ||
            (resolvedClaimIdsRef.current.has(id) && !optimisticSinceRef.current.has(id))
        );
      if (settled) {
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

  // The one queue path for every claim, from Claim All down to a single row. It owns the notes' gate from the tap to
  // their outcome, so nothing outside it (a row unmounting, the group view closing) can end the gate while the enqueue
  // still runs. Resolves to the committed row of the first group that queued, or null when none did.
  const queueClaim = useCallback(
    async (notesToClaim: NoteWithMetadata[]): Promise<string | null> => {
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

      // Ids whose consume actually queued. Only these get a hold: a queue-time failure already cleared its own gate.
      const queuedNoteIds: string[] = [];
      let batchTxId: string | null = null;
      try {
        // One consume per faucet, native asset first (see `groupNotesForClaim`).
        for (const groupNotes of groupNotesForClaim(notesToClaim, nativeFaucetId)) {
          const groupNoteIds = groupNotes.map(n => n.id);
          try {
            // An explicit tap (Claim All, a group or a row) bypasses the auto-consume backoff gate so
            // failed notes can be retried on demand.
            const { committedId: groupTxId, coveringTxIdByNoteId } = await queueConsumeNotes(
              account.publicKey,
              groupNotes,
              isDelegatedProvingEnabled,
              true
            );
            batchTxId = batchTxId ?? groupTxId;
            // Keyed to the row covering each note: one already covered by a live or Completed row is skipped rather
            // than joined, so the committed id is not its row and that id's failure is not its outcome.
            for (const id of groupNoteIds) {
              claimTxIdByNoteIdRef.current.set(id, coveringTxIdByNoteId.get(id) ?? groupTxId);
            }
            queuedNoteIds.push(...groupNoteIds);
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
        const holdStartedAt = Date.now();
        for (const id of queuedNoteIds) optimisticSinceRef.current.set(id, holdStartedAt);
        if (queuedNoteIds.length > 0) {
          // The ceiling fires on its own clock: the release effect only re-runs when the notes array changes, so an
          // unchanged or stalled list would otherwise hold the gate for the life of the page. A newer hold on the same
          // id carries a different start time and is left alone.
          const timer = setTimeout(() => {
            holdDeadlineTimersRef.current.delete(timer);
            releaseOptimisticHolds(queuedNoteIds.filter(id => optimisticSinceRef.current.get(id) === holdStartedAt));
          }, POST_CLAIM_MAX_MS);
          holdDeadlineTimersRef.current.add(timer);
        }
      }
      return batchTxId;
    },
    [
      account.publicKey,
      isDelegatedProvingEnabled,
      mutateClaimableNotes,
      signTransaction,
      releaseOptimisticHolds,
      // Read by the native-first ordering above. Omitted, this callback captures the
      // faucet id from first render -- `null` until discovery resolves -- and the
      // ordering silently stops preferring the native asset, which is its whole
      // point: a token note claimed first against an empty vault cannot pay its fee.
      nativeFaucetId
    ]
  );

  const claimNotesBatch = useCallback(
    async (filter?: (note: NoteWithMetadata) => boolean) => {
      // Refresh the claimable notes list before queueing to avoid race conditions
      // with auto-consume (Explore page may have already started claiming some notes).
      const freshNotes = await mutateClaimableNotes();
      let freshUnclaimedNotes = freshNotes
        ? freshNotes.filter(n => n && !n.fromCache && !isNoteInFlight(n, claimingNoteIds))
        : unclaimedNotes;

      if (filter) {
        freshUnclaimedNotes = freshUnclaimedNotes.filter(n => n && filter(n));
      }

      if (freshUnclaimedNotes.length === 0) {
        console.warn('[useClaimNotes] claim requested but no note was claimable at queue time');
        return;
      }

      await queueClaim(freshUnclaimedNotes.filter((n): n is NonNullable<typeof n> => n != null));
    },
    [unclaimedNotes, mutateClaimableNotes, claimingNoteIds, queueClaim]
  );

  // A row's claim takes the same path, so its gate outlives the row. It skips the fresh read: a row offers Claim only for
  // a note that is not in flight, and the enqueue's own dedup covers a consume that appeared since.
  const handleClaimNote = useCallback((note: NoteWithMetadata) => queueClaim([note]), [queueClaim]);

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
    // Only a read with no list on screen yet counts: the 5 s background revalidation must not
    // animate a loading bar or re-render the list on every lap, and SWR still reports the first read
    // as loading while the persisted list is on screen.
    isFetchingNotes: Boolean(isLoading) && claimableNotes === undefined,
    safeClaimableNotes,
    unclaimedNotes,
    isDelegatedProvingEnabled,
    claimingNoteIds,
    retriableNoteIds,
    invalidNoteIds,
    checkingNoteIds,
    handleClaimNote,
    handleClaimAll,
    handleClaimGroup
  };
}
