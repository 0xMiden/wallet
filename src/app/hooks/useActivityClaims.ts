import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { useTranslation } from 'react-i18next';

import { useClaimNotes } from 'app/hooks/useClaimNotes';
import useNativeFeeFaucetId from 'app/hooks/useNativeFeeFaucetId';
import useVerificationBaseFee from 'app/hooks/useVerificationBaseFee';
import type { PendingActivityItem, PendingActivityStatus } from 'app/templates/history/PendingActivityCard';
import { subscribeToLiveQuery } from 'lib/dexie-live-query';
import {
  holdsNotes,
  initiateConsumeTransaction,
  queueConsumeNotes,
  requestSWTransactionProcessing,
  requeueFailedTransaction,
  startBackgroundTransactionProcessing
} from 'lib/miden/activity';
import { agglayerDeliverySenders } from 'lib/miden/activity/bridge-in';
import { ITransaction, ITransactionStatus } from 'lib/miden/db/types';
import { claimFeeShortfalls } from 'lib/miden/fees/spendable';
import { useAllBalances, useAllTokensBaseMetadata, useMidenContext } from 'lib/miden/front';
import { groupNotesForClaim } from 'lib/miden/front/claim-groups';
import { reportNoteClaim } from 'lib/miden/front/claim-telemetry';
import type { ClaimableNoteWithMetadata } from 'lib/miden/front/claimable-notes';
import { zustandProvider } from 'lib/miden/front/guardian-sync';
import * as Repo from 'lib/miden/repo';
import { ClaimFeeRefusedError } from 'lib/miden/transaction/claim-fee';
import { isGuardianHoldRetryError, retryRefusalText } from 'lib/miden/transaction/retry-refusal';
import { shownSubmissionFeedback, type SubmissionFeedback } from 'lib/miden/transaction/submission-feedback';
import { keptCandidateHoldUntil, nowSeconds } from 'lib/miden/transaction/verdict-rules';
import { getEffectiveNetworkName, getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { isExtension } from 'lib/platform';
import { safeOwnDiagnosticData } from 'lib/telemetry/closed-root-diagnostics';
import { classifyUiFailure, snapshotPendingRetry } from 'lib/telemetry/ui-producer-diagnostics';

function noteClaimFailure(
  origin: 'queue_single' | 'queue_batch' | 'transaction_row',
  uiFailureKind: ReturnType<typeof classifyUiFailure>
): NonNullable<PendingActivityItem['failure']> {
  return {
    id: 'noteClaimFailedRetry',
    diagnostics: { kind: 'note_claim', noteClaimFailureOrigin: origin, uiFailureKind }
  };
}

type FeeSnapshot = {
  notesKey: string;
  balances: ReturnType<typeof useAllBalances>['data'];
  nativeFaucetId: string | null;
  baseFee: number | null;
  balancesLoading: boolean;
};
type ClaimAttempt = PendingActivityItem & { feeRefusedAt?: FeeSnapshot };
type RetryFailure = { message: string; metHold?: true } & NonNullable<PendingActivityItem['failure']>;
type Attempts = ReadonlyMap<string, ClaimAttempt>;
type ClaimSlot = {
  attempts: Attempts;
  busy: Set<string>;
  retrying: Set<string>;
  feeSnapshot?: FeeSnapshot;
};

// Lives outside the views: switching List and Groups remounts them, and a claim still being queued in one
// must keep the other from queueing the same note. One slot per account, RPC endpoint and network, the key
// AllHistory remounts the views on.
const slots = new Map<string, ClaimSlot>();
const listeners = new Set<() => void>();
const noAttempts: Attempts = new Map();

function slotOf(key: string) {
  let slot = slots.get(key);
  if (!slot) {
    slot = { attempts: noAttempts, busy: new Set(), retrying: new Set() };
    slots.set(key, slot);
  }
  return slot;
}

function updateAttempts(key: string, update: (previous: Attempts) => Attempts) {
  const slot = slotOf(key);
  const next = update(slot.attempts);
  if (next === slot.attempts) return;
  slot.attempts = next;
  listeners.forEach(listener => listener());
}

function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every(id => b.has(id));
}

function sameSubmission(left: SubmissionFeedback | undefined, right: SubmissionFeedback | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return (
    left.kind === right.kind &&
    left.messageKey === right.messageKey &&
    left.rowCopy === right.rowCopy &&
    left.details === right.details
  );
}

function sameHolds(left: ReadonlyMap<string, number>, right: ReadonlyMap<string, number>): boolean {
  return left.size === right.size && [...right].every(([id, until]) => left.get(id) === until);
}

function sameFeedback(
  left: ReadonlyMap<string, SubmissionFeedback>,
  right: ReadonlyMap<string, SubmissionFeedback>
): boolean {
  if (left.size !== right.size) return false;
  for (const [id, value] of right) {
    if (!sameSubmission(left.get(id), value)) return false;
  }
  return true;
}

function sameFeeSnapshot(a: FeeSnapshot, b: FeeSnapshot): boolean {
  return (
    a.notesKey === b.notesKey &&
    a.balances === b.balances &&
    a.nativeFaucetId === b.nativeFaucetId &&
    a.baseFee === b.baseFee &&
    a.balancesLoading === b.balancesLoading
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The notes of the claims the queue may run before a new one. A held row has already run, so it is not one. */
function queuedNotes(items: readonly PendingActivityItem[]): ClaimableNoteWithMetadata[] {
  return items.flatMap(item => (item.status === 'claiming' && item.held !== true ? [item.note] : []));
}

/** Test-only: forget every account's claims. */
export function __resetActivityClaimsForTest(): void {
  slots.clear();
}

export function useActivityClaims() {
  const { t } = useTranslation();
  const claim = useClaimNotes();
  const { signTransaction } = useMidenContext();
  const nativeFaucetId = useNativeFeeFaucetId();
  const allTokensBaseMetadata = useAllTokensBaseMetadata();
  const { data: balances, isLoading: balancesLoading } = useAllBalances(claim.account.publicKey, allTokensBaseMetadata);
  const verificationBaseFee = useVerificationBaseFee();
  // Before the first balance read lands the rows are a zero placeholder, which would refuse every claim.
  const feeGateBaseFee = balancesLoading ? null : verificationBaseFee;
  const key = `${claim.account.publicKey}|${getEffectiveRpcUrl()}|${getEffectiveNetworkName()}`;
  const attempts = useSyncExternalStore(subscribe, () => slots.get(key)?.attempts ?? noAttempts);
  const setAttempts = (update: (previous: Attempts) => Attempts) => updateAttempts(key, update);
  // Notes whose claim is being queued right now. Once queued, the attempt's
  // `claiming` status is what keeps the note from being accepted again.
  const busy = slotOf(key).busy;
  // Held rows whose Retry is running. The card keeps offering Retry until the live query sees the row move, so a
  // second tap in that window would requeue a row the first one already requeued, and store its refusal.
  const retrying = slotOf(key).retrying;
  const feeSnapshot = useMemo<FeeSnapshot>(
    () => ({
      // Each view mount rebuilds the derived notes, so their content identifies the live snapshot.
      notesKey: JSON.stringify(claim.safeClaimableNotes),
      balances,
      nativeFaucetId,
      baseFee: feeGateBaseFee,
      balancesLoading
    }),
    [claim.safeClaimableNotes, balances, nativeFaucetId, feeGateBaseFee, balancesLoading]
  );
  slotOf(key).feeSnapshot = feeSnapshot;
  // A refusal judged on a snapshot the live data has since replaced says nothing about the note now, so the live
  // state decides, a note that is gone included.
  const settleFeeRefusal = (
    next: Map<string, ClaimAttempt>,
    note: ClaimableNoteWithMetadata,
    startedAt: FeeSnapshot
  ): Map<string, ClaimAttempt> => {
    if (sameFeeSnapshot(startedAt, slotOf(key).feeSnapshot ?? feeSnapshot)) {
      next.set(note.id, { note, status: 'pending', cannotPayFee: true, feeRefusedAt: startedAt });
    } else {
      next.delete(note.id);
    }
    return next;
  };

  // A writer refusal survives its own render, but a fresh live snapshot must let the fee pre-gate decide again.
  useEffect(() => {
    updateAttempts(key, previous => {
      const expired = [...previous].filter(
        ([, attempt]) => attempt.feeRefusedAt !== undefined && !sameFeeSnapshot(attempt.feeRefusedAt, feeSnapshot)
      );
      if (expired.length === 0) return previous;
      const next = new Map(previous);
      for (const [id] of expired) next.delete(id);
      return next;
    });
  }, [key, feeSnapshot]);

  // Rows of every claiming item: session attempts and the claiming map's held rows alike (#1081). A failed claim's row
  // too, whichever path found it: what its card may say follows the hold and the reconciler (#2060).
  const watchedTxIds = [
    ...new Set([
      ...[...attempts.values()].flatMap(item =>
        (item.status === 'claiming' || item.status === 'failed') && item.txId ? [item.txId] : []
      ),
      ...claim.safeClaimableNotes.flatMap(n => (n.isBeingClaimed && n.claimingTxId ? [n.claimingTxId] : [])),
      ...claim.retriableTxIds.values()
    ])
  ]
    .sort()
    .join(',');
  const [heldTxIds, setHeldTxIds] = useState<ReadonlySet<string>>(new Set());
  const [retryErrors, setRetryErrors] = useState<ReadonlyMap<string, RetryFailure>>(new Map());
  // Rows the queue put back after a Guardian 409 (#1666), as of the last emission for this slot: another account,
  // endpoint or network reuses no wait, and nothing watched means none is known.
  const [guardianWait, setGuardianWait] = useState<{ key: string; txIds: ReadonlySet<string> }>({
    key,
    txIds: new Set()
  });
  const [submissionByTx, setSubmissionByTx] = useState<ReadonlyMap<string, SubmissionFeedback>>(() => new Map());
  const [holdByTx, setHoldByTx] = useState<ReadonlyMap<string, number>>(() => new Map());

  useEffect(() => {
    if (!watchedTxIds) {
      setGuardianWait(previous => (previous.txIds.size === 0 ? previous : { key, txIds: new Set() }));
      setSubmissionByTx(previous => (previous.size === 0 ? previous : new Map()));
      setHoldByTx(previous => (previous.size === 0 ? previous : new Map()));
      return;
    }
    const txIds = watchedTxIds.split(',');
    let latestRows: ITransaction[] | undefined;
    let holdEnds: ReturnType<typeof setTimeout> | undefined;
    const publish = (rows: ITransaction[]) => {
      latestRows = rows;
      clearTimeout(holdEnds);
      const settled = new Map<string, Pick<PendingActivityItem, 'status' | 'claimedAt' | 'submission'>>();
      const failedRows = new Map<string, ITransaction>();
      const held = new Set<string>();
      const waiting = new Set<string>();
      const submissions = new Map<string, SubmissionFeedback>();
      const holds = new Map<string, number>();
      const nowSec = nowSeconds();
      for (const tx of rows) {
        const feedback = shownSubmissionFeedback(tx);
        if (feedback !== undefined) submissions.set(tx.id, feedback);
        if (tx.status === ITransactionStatus.Queued && tx.guardianBusy === true) {
          waiting.add(tx.id);
        } else if (tx.status === ITransactionStatus.Completed) {
          settled.set(tx.id, { status: 'claimed', claimedAt: tx.completedAt, submission: undefined });
        } else if (tx.status === ITransactionStatus.Failed || tx.status === ITransactionStatus.Unconfirmed) {
          const until = keptCandidateHoldUntil(tx, nowSec);
          if (until !== undefined) holds.set(tx.id, until);
          if (holdsNotes(tx)) held.add(tx.id);
          else {
            settled.set(tx.id, {
              status: 'failed',
              claimedAt: tx.completedAt,
              submission: feedback
            });
            failedRows.set(tx.id, tx);
          }
        }
      }
      setSubmissionByTx(previous => (sameFeedback(previous, submissions) ? previous : submissions));
      setHoldByTx(previous => (sameHolds(previous, holds) ? previous : holds));
      // Every emission lists every watched row; an unchanged set keeps its identity so the items do not rebuild.
      setHeldTxIds(previous => (sameIds(previous, held) ? previous : held));
      setGuardianWait(previous =>
        previous.key === key && sameIds(previous.txIds, waiting) ? previous : { key, txIds: waiting }
      );
      // A refusal describes the hold it met: it ends with that hold, and once the row moves on it must not return with
      // a later one.
      setRetryErrors(previous => {
        const moved = rows.filter(
          tx => previous.has(tx.id) && (!held.has(tx.id) || (previous.get(tx.id)?.metHold && !holds.has(tx.id)))
        );
        if (moved.length === 0) return previous;
        const next = new Map(previous);
        for (const tx of moved) next.delete(tx.id);
        return next;
      });
      updateAttempts(key, previous => {
        let next: Map<string, PendingActivityItem> | undefined;
        for (const [noteId, item] of previous) {
          if (item.txId === undefined) continue;
          if (item.status === 'failed') {
            // The failure itself stays one object, or the card would restart its report on every re-read.
            const submission = submissions.get(item.txId);
            if (sameSubmission(item.submission, submission)) continue;
            next ??= new Map(previous);
            next.set(noteId, { ...item, submission });
            continue;
          }
          const outcome = item.status === 'claiming' ? settled.get(item.txId) : undefined;
          if (!outcome) continue;
          const failed = failedRows.get(item.txId);
          let failure: PendingActivityItem['failure'];
          if (failed !== undefined) {
            const raw = safeOwnDiagnosticData(failed, 'rawError');
            const error = typeof raw === 'string' && raw.length > 0 ? raw : safeOwnDiagnosticData(failed, 'error');
            failure = noteClaimFailure(
              'transaction_row',
              typeof error === 'string' && error.length > 0 ? classifyUiFailure(error) : 'unavailable'
            );
          }
          next ??= new Map(previous);
          next.set(noteId, { ...item, ...outcome, ...(failure === undefined ? {} : { failure }) });
        }
        return next ?? previous;
      });
      // A hold ends with no write to its row, so no emission would ever take its notice down. Its countdown reads the
      // wall clock every second, so this does too: a timer set for the whole hold leaves Retry off after a clock step.
      if (holds.size > 0) {
        holdEnds = setTimeout(() => publish(rows), Math.min(1_000, Math.min(...holds.values()) * 1000 - Date.now()));
      }
    };
    // A freeze holds the timer up, so the way back reads the clock rather than wait out what it had left.
    const resample = () => {
      if (latestRows !== undefined && document.visibilityState === 'visible') publish(latestRows);
    };
    document.addEventListener('visibilitychange', resample);
    const unsubscribe = subscribeToLiveQuery(() => Repo.transactions.where('id').anyOf(txIds).toArray(), {
      next: publish,
      error: error => console.warn('[activity] Could not read claim status', error)
    });
    return () => {
      clearTimeout(holdEnds);
      document.removeEventListener('visibilitychange', resample);
      unsubscribe();
    };
  }, [watchedTxIds, key]);

  const items = useMemo(() => {
    // A refusal belongs to the held claim whose Retry met it: once the row settles or runs again it no longer applies.
    const rowFields = (
      status: PendingActivityStatus,
      txId: string | undefined
    ): Pick<PendingActivityItem, 'held' | 'retryError' | 'failure' | 'guardianBusy' | 'submission' | 'holdUntil'> => {
      if (txId === undefined) return {};
      const submission = submissionByTx.get(txId);
      const holdUntil = holdByTx.get(txId);
      const hold = holdUntil === undefined ? {} : { holdUntil };
      if (status === 'failed') return { ...hold, ...(submission === undefined ? {} : { submission }) };
      if (status !== 'claiming') return {};
      if (!heldTxIds.has(txId)) {
        const guardianBusy = guardianWait.key === key && guardianWait.txIds.has(txId);
        if (!guardianBusy && submission === undefined) return {};
        return {
          ...(guardianBusy ? { guardianBusy: true as const } : {}),
          ...(submission !== undefined ? { submission } : {})
        };
      }
      const retryError = retryErrors.get(txId);
      return retryError === undefined
        ? { held: true, ...hold, ...(submission !== undefined ? { submission } : {}) }
        : {
            held: true,
            ...hold,
            retryError: retryError.message,
            failure: retryError,
            ...(submission !== undefined ? { submission } : {})
          };
    };
    const result = new Map<string, PendingActivityItem>();
    for (const note of claim.safeClaimableNotes) {
      let status: PendingActivityStatus = 'pending';
      switch (true) {
        case note.isBeingClaimed:
          status = 'claiming';
          break;
        // The check holds back a note until its state is known; a cached note cannot be accepted, so it stays listed.
        case !note.fromCache && claim.checkingNoteIds.has(note.id):
          status = 'checking';
          break;
        case claim.invalidNoteIds.has(note.id):
          status = 'unavailable';
          break;
        case claim.retriableNoteIds.has(note.id):
          status = 'failed';
          break;
      }
      const txId = note.claimingTxId ?? (status === 'failed' ? claim.retriableTxIds.get(note.id) : undefined);
      result.set(note.id, { note, status, txId, ...rowFields(status, txId) });
    }
    for (const [id, attempt] of attempts) {
      const current = result.get(id);
      if (
        attempt.feeRefusedAt !== undefined &&
        (!current ||
          (current.status !== 'pending' && current.status !== 'failed') ||
          !sameFeeSnapshot(attempt.feeRefusedAt, feeSnapshot))
      )
        continue;
      // A failed attempt stays retryable only while its note is live and no newer state (a live claim or a
      // note check) replaced it: a note consumed elsewhere or recalled would fail every batch it joins.
      // Claimed receipts and queued claims outlive the note on purpose.
      if (attempt.status === 'failed' && (!current || (current.status !== 'pending' && current.status !== 'failed')))
        continue;
      result.set(id, { ...attempt, note: current?.note ?? attempt.note, ...rowFields(attempt.status, attempt.txId) });
    }
    const built = [...result.values()];
    // Each card's Accept claims its note alone, after whatever is already queued.
    const gated = built.filter(
      item => (item.status === 'pending' || item.status === 'failed') && item.note.fromCache !== true
    );
    const refused = claimFeeShortfalls(
      gated.map(item => [item.note]),
      queuedNotes(built),
      balances,
      nativeFaucetId,
      feeGateBaseFee
    );
    const refusedById = new Map(gated.map((item, index) => [item.note.id, refused[index] === true]));
    return built.map(item => {
      const cannotPayFee = item.cannotPayFee === true || refusedById.get(item.note.id);
      return cannotPayFee === undefined ? item : { ...item, cannotPayFee };
    });
  }, [
    claim.safeClaimableNotes,
    claim.checkingNoteIds,
    claim.invalidNoteIds,
    claim.retriableNoteIds,
    claim.retriableTxIds,
    attempts,
    heldTxIds,
    guardianWait,
    submissionByTx,
    holdByTx,
    key,
    retryErrors,
    balances,
    nativeFaucetId,
    feeGateBaseFee,
    feeSnapshot
  ]);

  // Which of `transactions` are certain to fail on the fee when queued after `ahead`.
  const feeShortfalls = (
    transactions: readonly ClaimableNoteWithMetadata[][],
    ahead: readonly ClaimableNoteWithMetadata[] = queuedNotes(items)
  ): boolean[] => claimFeeShortfalls(transactions, ahead, balances, nativeFaucetId, feeGateBaseFee);

  // Accept All's own grouping without its delivery split, which only divides a non-native group and so cannot
  // change whether every group is refused. Each group is judged alone, so when every one is, none is queued to
  // fund the rest.
  const cannotPayFee = (notes: readonly ClaimableNoteWithMetadata[]): boolean => {
    const refused = feeShortfalls(groupNotesForClaim(notes, nativeFaucetId));
    return refused.length > 0 && refused.every(Boolean);
  };

  const accept = async (note: ClaimableNoteWithMetadata) => {
    // A cache-first entry is displayed before any live read has confirmed it, so it
    // cannot start a claim. The live read replaces it within one poll lap.
    if (note.fromCache) return;
    const item = items.find(candidate => candidate.note.id === note.id);
    if (!item || (item.status !== 'pending' && item.status !== 'failed') || busy.has(note.id)) return;
    // The card withholds Accept, so this is a tap that raced the balance landing.
    if (item.cannotPayFee === true) return;
    busy.add(note.id);
    setAttempts(previous => new Map(previous).set(note.id, { note, status: 'claiming' }));
    const startedAt = slotOf(key).feeSnapshot ?? feeSnapshot;
    try {
      // Each queue call is one `note_handle` attempt. It wraps the call, not the whole action: the
      // catch below absorbs a queue-time throw, so a wrapper further out would report every failure
      // as a success.
      const txId = await reportNoteClaim(() =>
        initiateConsumeTransaction(claim.account.publicKey, note, claim.isDelegatedProvingEnabled, true, 'claim')
      );
      setAttempts(previous => new Map(previous).set(note.id, { note, status: 'claiming', txId }));
    } catch (error) {
      if (error instanceof ClaimFeeRefusedError) {
        setAttempts(previous => settleFeeRefusal(new Map(previous), note, startedAt));
        return;
      }
      setAttempts(previous =>
        new Map(previous).set(note.id, {
          note,
          status: 'failed',
          failure: noteClaimFailure('queue_single', classifyUiFailure(error))
        })
      );
      console.error('[activity] Could not queue claim', error);
      return;
    } finally {
      busy.delete(note.id);
    }
    try {
      if (isExtension()) requestSWTransactionProcessing();
      else startBackgroundTransactionProcessing(signTransaction, false, zustandProvider);
    } catch (error) {
      // The transaction is queued. Keep its status until the worker reports a result.
      console.warn('[activity] Could not start claim processing', error);
    }
  };

  // Queues a claim for many notes at once. Every note shows as `claiming`
  // before the first queue call, so the list reacts on tap on all platforms.
  const acceptMany = async (notes: readonly ClaimableNoteWithMetadata[]) => {
    const accepted = notes.filter(note => {
      // Same gate as `accept`: unconfirmed cache entries are never claimed.
      if (note.fromCache) return false;
      const item = items.find(candidate => candidate.note.id === note.id);
      return item !== undefined && (item.status === 'pending' || item.status === 'failed') && !busy.has(note.id);
    });
    if (accepted.length === 0) return;
    for (const note of accepted) busy.add(note.id);
    const before = slotOf(key).attempts;
    setAttempts(previous => {
      const next = new Map(previous);
      for (const note of accepted) next.set(note.id, { note, status: 'claiming' });
      return next;
    });

    let queued = false;
    const isDelivery = await agglayerDeliverySenders();
    const groups = groupNotesForClaim(accepted, nativeFaucetId, note => isDelivery(note.senderAddress));
    // Each group is decided once the ones before it were queued. A queue call that returned may fund the rest even
    // when it deduplicated onto existing rows, which credit the vault or may; a failed write funds nothing.
    const ahead = queuedNotes(items);
    for (const groupNotes of groups) {
      if (feeShortfalls([groupNotes], ahead)[0]) {
        // Certain to fail on the fee, so it is not queued: its notes go back to what they were before the tap.
        setAttempts(previous => {
          const next = new Map(previous);
          for (const note of groupNotes) {
            const earlier = before.get(note.id);
            if (earlier) next.set(note.id, earlier);
            else next.delete(note.id);
          }
          return next;
        });
        for (const note of groupNotes) busy.delete(note.id);
        continue;
      }
      const startedAt = slotOf(key).feeSnapshot ?? feeSnapshot;
      try {
        const { committedId, coveringTxIdByNoteId, feeRefusedNoteIds } = await reportNoteClaim(() =>
          queueConsumeNotes(
            claim.account.publicKey,
            groupNotes,
            claim.isDelegatedProvingEnabled,
            true,
            undefined,
            undefined,
            'claim_all'
          )
        );
        const feeRefused = new Set(feeRefusedNoteIds);
        const admitted = groupNotes.filter(note => !feeRefused.has(note.id));
        if (admitted.length > 0) queued = true;
        ahead.push(...admitted);
        // Per note: a note already covered by a live, completed or note-holding row never joins the
        // batch, so it settles with that row.
        setAttempts(previous => {
          const next = new Map(previous);
          for (const note of groupNotes) {
            if (feeRefused.has(note.id)) settleFeeRefusal(next, note, startedAt);
            else
              next.set(note.id, { note, status: 'claiming', txId: coveringTxIdByNoteId.get(note.id) ?? committedId });
          }
          return next;
        });
      } catch (error) {
        if (error instanceof ClaimFeeRefusedError) {
          setAttempts(previous => {
            const next = new Map(previous);
            for (const note of groupNotes) settleFeeRefusal(next, note, startedAt);
            return next;
          });
          continue;
        }
        setAttempts(previous => {
          const next = new Map(previous);
          for (const note of groupNotes) {
            next.set(note.id, {
              note,
              status: 'failed',
              failure: noteClaimFailure('queue_batch', classifyUiFailure(error))
            });
          }
          return next;
        });
        console.error('[activity] Could not queue batch claim', error);
      } finally {
        for (const note of groupNotes) busy.delete(note.id);
      }
    }
    if (!queued) return;
    try {
      if (isExtension()) requestSWTransactionProcessing();
      else startBackgroundTransactionProcessing(signTransaction, false, zustandProvider);
    } catch (error) {
      console.warn('[activity] Could not start claim processing', error);
    }
  };

  // A held claim's Retry requeues its own row in place: History hides that row while this card stands in for its
  // notes, so this is its only Retry (#1081). No history entry, no navigation, so this starts processing itself.
  const retryHeld = async (item: PendingActivityItem) => {
    const { txId } = item;
    if (txId === undefined || item.held !== true || retrying.has(txId)) return;
    retrying.add(txId);
    setRetryErrors(previous => {
      const next = new Map(previous);
      next.delete(txId);
      return next;
    });
    try {
      await requeueFailedTransaction(txId);
    } catch (error) {
      const message = error instanceof ClaimFeeRefusedError ? t('insufficientFeeAsset') : retryRefusalText(error, t);
      const id = error instanceof ClaimFeeRefusedError ? 'insufficientFeeAsset' : 'raw_pending_activity_retry_failed';
      setRetryErrors(previous =>
        new Map(previous).set(txId, {
          message,
          id,
          ...(isGuardianHoldRetryError(error) ? { metHold: true as const } : {}),
          ...(id === 'raw_pending_activity_retry_failed'
            ? {
                diagnostics: {
                  kind: 'pending_retry' as const,
                  pendingRetryReason: snapshotPendingRetry(error) ?? 'unexpected'
                }
              }
            : {})
        })
      );
      return;
    } finally {
      retrying.delete(txId);
    }
    try {
      if (isExtension()) requestSWTransactionProcessing();
      else startBackgroundTransactionProcessing(signTransaction, false, zustandProvider);
    } catch (error) {
      console.warn('[activity] Could not start claim processing', error);
    }
  };

  return {
    items,
    accept,
    acceptMany,
    retryHeld,
    cannotPayFee,
    account: claim.account,
    isLoadingNotes: claim.isFetchingNotes || claim.checkingNoteIds.size > 0
  };
}
