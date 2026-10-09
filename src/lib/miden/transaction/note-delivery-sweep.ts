import {
  isSyncFused,
  noteLocalProbeFailure,
  noteProbeFailure,
  noteSyncSuccess,
  syncFuseUntilMs
} from 'lib/miden/front/sync-fuse';
import * as Repo from 'lib/miden/repo';
import { monotonicNowMs } from 'lib/miden/sync-backoff';
import { isNoteTransportConfigured } from 'lib/miden-chain/effective-endpoints';

import {
  noteDeliveryWriteCount,
  recordNoteDelivery,
  relayAckedNoteIdsOf,
  relayNoteIdsOf,
  relayRecipientOf,
  storedNoteIds
} from './helper';
import { RETRY_WINDOW_SECONDS } from './note-delivery-window';
import { classifyRelayFailure, type RelayFailureClass, statusCodeOf } from './relay-failure';
import { midenClientProxy } from '../back/miden-client-proxy';
import { INoteDeliveryState, ITransaction } from '../db/types';
import {
  causeChain,
  errorMessageParts,
  isKilledPipeline,
  isPipelineKillLink,
  isRealmIntactAbort
} from '../sdk/sdk-error-code';

const MINUTE = 60;
const HOUR = 60 * MINUTE;

/**
 * Delay in seconds before the next push of a note the transport has not acknowledged,
 * indexed by the row's attempts so far less one (the original relay is the first), the
 * last entry repeating. Pushes therefore land at +5 m, +15 m, +30 m, +1 h, +2 h and +4 h
 * after each failed attempt, then every 6 h.
 *
 * Tight at first because the common failure is a transport or connection that was down
 * for a moment, wide later because a note still unacknowledged after hours is waiting on
 * something a quick retry will not fix, and each push holds the WASM client for up to a
 * gRPC timeout.
 */
const RETRY_DELAYS_SECONDS = [5 * MINUTE, 15 * MINUTE, 30 * MINUTE, HOUR, 2 * HOUR, 4 * HOUR, 6 * HOUR];

/**
 * Delays before the verification pushes of a row whose every live note the transport
 * acknowledged: 5 minutes after the last acknowledgement, then 30 minutes after that.
 *
 * An acknowledgement is not proof of storage (the 0.17 transport also acknowledges a
 * note it already holds), so two more pushes give a note the transport accepted and
 * lost two independent chances. A note it does hold costs the recipient nothing.
 *
 * A step counts once every note it set out to push was acknowledged or found dead; one
 * left short is served again on {@link RETRY_DELAYS_SECONDS}. Like a retry, no step is
 * pushed past {@link RETRY_WINDOW_SECONDS} after the send or {@link MAX_RELAY_ATTEMPTS}.
 */
const VERIFY_DELAYS_SECONDS = [5 * MINUTE, 30 * MINUTE];

/** How often a row whose pushes are over is checked for a receipt, in seconds. */
const RECEIPT_INTERVAL_SECONDS = HOUR;

/** How long after the send a row is checked for a receipt at all, in seconds. */
export const RECEIPT_WINDOW_SECONDS = 7 * 24 * HOUR;

const retryDelayFor = (attempts: number): number =>
  RETRY_DELAYS_SECONDS[Math.min(attempts, RETRY_DELAYS_SECONDS.length) - 1] ?? 6 * HOUR;

/**
 * How many pushes of unacknowledged notes {@link RETRY_DELAYS_SECONDS} fits into
 * {@link RETRY_WINDOW_SECONDS}, counting the original relay: 17. A backstop, not the
 * schedule: it bounds a row whose send time cannot be trusted (a clock that moved
 * backwards puts it in the future, where the window never closes), and the counter it
 * reads arrives from a store that `importDb` fills from a user-supplied file.
 */
export const MAX_RELAY_ATTEMPTS = (() => {
  let attempts = 1;
  for (let elapsed = retryDelayFor(1); elapsed <= RETRY_WINDOW_SECONDS; elapsed += retryDelayFor(attempts)) {
    attempts++;
  }
  return attempts;
})();

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** Delivery states the sweep still looks at. `confirmed` is terminal. */
const SWEEPABLE: INoteDeliveryState[] = ['pending', 'relayed', 'undelivered'];

/** The innermost killed-pipeline error down `error`'s cause chain, or `error` when there is none. */
const innermostKill = (error: unknown): unknown => {
  let kill = error;
  for (const link of causeChain(error)) {
    if (isPipelineKillLink(link)) kill = link;
  }
  return kill;
};

/**
 * Book a failed push to the 'note-delivery' fuse by the sweep's own reading of it. An
 * interruption books the kill it found down the cause chain, so a wrapped eviction still
 * counts as one; an outage, or a transport that rejected the request, is a probe the node
 * answered; and a failure that never left this realm (a store loss, the local refusal of a
 * note with no proof yet, a disabled transport) only re-arms a fuse already lit.
 */
const bookPushFailure = (failure: RelayFailureClass, error: unknown): void => {
  if (failure === 'interrupted') noteProbeFailure('note-delivery', innermostKill(error));
  else if (failure === 'outage' || (failure === 'noteLocal' && statusCodeOf(errorMessageParts(error))))
    noteProbeFailure('note-delivery', error);
  else noteLocalProbeFailure('note-delivery');
};

/**
 * Attempts already made on a row, normalized. Read defensively because it arrives from a
 * store that `importDb` fills from a user-supplied file, and it bounds how often a note
 * body goes back on the wire: a hand-edited `0` or negative counts up from 1, and a
 * non-finite value counts as spent.
 */
const attemptsOf = (row: ITransaction): number => {
  const stored = Math.trunc(row.relayAttempts ?? 1);
  if (!Number.isFinite(stored)) return MAX_RELAY_ATTEMPTS;
  return Math.min(Math.max(stored, 1), MAX_RELAY_ATTEMPTS);
};

/** Verification pushes already made on a row, normalized as {@link attemptsOf} is. */
const verifyPushesOf = (row: ITransaction): number => {
  const stored = Math.trunc(row.relayVerifyPushes ?? 0);
  if (!Number.isFinite(stored)) return VERIFY_DELAYS_SECONDS.length;
  return Math.min(Math.max(stored, 0), VERIFY_DELAYS_SECONDS.length);
};

// Aged from the relay (`completedAt`), not the queue stamp: a send that waited queued for
// hours relays only when it completes.
const relayedAt = (row: ITransaction) => row.completedAt ?? row.initiatedAt ?? 0;

/** A row's owed notes, split by what the sweep may still do with each. */
interface DeliveryTargets {
  /** Every owed private note; receipts cover them all. */
  owed: string[];
  recipient: string | undefined;
  /** Owed notes the transport acknowledged, including those a legacy `relayed` row implies. */
  acked: string[];
  /** Live (not dead, with a recipient) and unacknowledged: what the retry schedule pushes. */
  retry: string[];
  /** Live and acknowledged: what the verification pushes cover. */
  verify: string[];
}

const targetsOf = (row: ITransaction): DeliveryTargets => {
  const owed = relayNoteIdsOf(row);
  const recipient = relayRecipientOf(row);
  const acked = relayAckedNoteIdsOf(row) ?? [];
  const dead = storedNoteIds(row.relayDeadNoteIds);
  const live = recipient ? owed.filter(noteId => !dead.includes(noteId)) : [];
  return {
    owed,
    recipient,
    acked,
    retry: live.filter(noteId => !acked.includes(noteId)),
    verify: live.filter(noteId => acked.includes(noteId))
  };
};

/**
 * Nothing to push and nothing to check: no owed note, or no recipient. A row whose owed
 * notes are all dead is not inert: no push can carry them, but a consumed one still
 * retires the row, so its receipts go on.
 */
const isInert = (targets: DeliveryTargets) => targets.owed.length === 0 || !targets.recipient;

/** Whether a row with `attempts` made is past the retry schedule's bounds: the window closed, or the cap reached. */
const retryBoundsPassed = (row: ITransaction, attempts: number, at: number) =>
  at - relayedAt(row) > RETRY_WINDOW_SECONDS || attempts >= MAX_RELAY_ATTEMPTS;

/** Whether the retry schedule is over: nothing left to retry, the window closed, or the cap reached. */
const retriesOver = (row: ITransaction, targets: DeliveryTargets, at: number) =>
  row.restoredFromBackup === true || targets.retry.length === 0 || retryBoundsPassed(row, attemptsOf(row), at);

/**
 * The notes to push now: the unacknowledged ones while retries last, else the verification
 * pushes. Neither goes past the retry bounds, whichever step left the row due there.
 */
const pushesFor = (row: ITransaction, targets: DeliveryTargets, at: number): string[] => {
  if (row.restoredFromBackup || retryBoundsPassed(row, attemptsOf(row), at)) return [];
  if (targets.retry.length > 0) return targets.retry;
  return verifyPushesOf(row) < VERIFY_DELAYS_SECONDS.length ? targets.verify : [];
};

/**
 * How long a row that spent nothing in a pass waits before the step it was serving: the next
 * receipt read when no push is left, else the push its retry or verification schedule owes.
 */
const nextStepDelayOf = (row: ITransaction, targets: DeliveryTargets, at: number): number => {
  if (pushesFor(row, targets, at).length === 0) return RECEIPT_INTERVAL_SECONDS;
  return targets.retry.length > 0 ? retryDelayFor(attemptsOf(row)) : VERIFY_DELAYS_SECONDS[verifyPushesOf(row)]!;
};

/**
 * Mark, once, a row whose retries are over while some owed note never reached the
 * transport, so the history card stops promoting retries that will not come.
 */
const markRetriesStopped = async (row: ITransaction, targets: DeliveryTargets, at: number): Promise<void> => {
  const owesDelivery = targets.owed.length === 0 || targets.owed.some(noteId => !targets.acked.includes(noteId));
  if (row.relayRetriesStopped || !owesDelivery || !retriesOver(row, targets, at)) return;
  await Repo.transactions.where({ id: row.id }).modify(tx => {
    tx.relayRetriesStopped = true;
  });
  console.warn('[noteDeliverySweep] pushes stopped; receipt checks continue', {
    txId: row.id,
    attempts: attemptsOf(row),
    restored: row.restoredFromBackup === true,
    inert: isInert(targets),
    state: row.noteDelivery
  });
};

/** What a row's receipt read found: every owed note consumed, no proof of that, or a killed read. */
type Receipt = 'consumed' | 'unproven' | 'killed';

/**
 * Whether every owed note is consumed on chain, which is the only proof the recipient had
 * the bodies. A timer-driven probe with a fuse of its own, 'note-delivery-receipt': a local
 * store read can park while the transport push does not, so it cannot share the push's key.
 * While that fuse is lit nothing is read and the receipt counts as unproven.
 */
const readReceipt = async (row: ITransaction, owed: string[]): Promise<Receipt> => {
  if (isSyncFused('note-delivery-receipt')) return 'unproven';
  try {
    let consumed = owed.length > 0;
    for (const noteId of owed) {
      if (!(await midenClientProxy.isOutputNoteConsumed(noteId))) {
        consumed = false;
        break;
      }
    }
    // Once, after the last read made: a success booked between reads would withdraw the
    // evidence a later read of the same row adds.
    noteSyncSuccess('note-delivery-receipt');
    return consumed ? 'consumed' : 'unproven';
  } catch (error) {
    noteProbeFailure('note-delivery-receipt', innermostKill(error));
    // A killed read left the realm's client parked or torn down, and that ends the pass. An
    // offscreen read failed without a kill lost only its own race against a write.
    if (isKilledPipeline(error) && !isRealmIntactAbort(error)) {
      console.warn('[noteDeliverySweep] delivery receipt read killed; the pass ends', { txId: row.id, error });
      return 'killed';
    }
    // Unreadable this cycle. Go on to the push: an extra push of a note that was
    // delivered costs the recipient nothing, whereas skipping one that was not is the
    // failure this sweep exists to prevent.
    console.warn('[noteDeliverySweep] could not read delivery receipt; pushing anyway', {
      txId: row.id,
      attempts: attemptsOf(row),
      priorState: row.noteDelivery,
      error
    });
    return 'unproven';
  }
};

/** What one pass has learned about the transport so far. */
interface PassState {
  /** Why pushes are over for the rest of the pass, if they are. */
  pushesStopped?: 'notConfigured' | 'fused' | 'outage';
  /** While the 'note-delivery' fuse is lit: when (unix seconds) its window ends. */
  fusedUntil?: number;
  /** A push succeeded in this pass, so the rows an outage deferred are due now. */
  caughtUp: boolean;
  /** A push or receipt read in this pass was killed, so the pass pushes nothing more. */
  interrupted: boolean;
  /** The earliest time (unix seconds) a row the pass saw next needs the sweep. */
  nextDueAt: number;
}

const noteDue = (pass: PassState, at: number) => {
  pass.nextDueAt = Math.min(pass.nextDueAt, at);
};

/** The 'fused' stop as the 'note-delivery' fuse reads now: no push until its window ends. */
const fusedStopOf = (): Pick<PassState, 'pushesStopped' | 'fusedUntil'> => {
  const fusedForMs = Math.max(0, (syncFuseUntilMs('note-delivery') ?? 0) - monotonicNowMs());
  return { pushesStopped: 'fused', fusedUntil: nowSeconds() + Math.ceil(fusedForMs / 1000) };
};

/**
 * Whether pushes are stopped as 'fused', read from the live fuse before every push rather
 * than once per pass: a push the lapsed window granted re-arms it when it fails, and that
 * window binds the rest of this pass as it does the next one.
 */
const fusedNow = (pass: PassState): boolean => {
  if (pass.pushesStopped === undefined && isSyncFused('note-delivery')) Object.assign(pass, fusedStopOf());
  return pass.pushesStopped === 'fused';
};

type RowOutcome = 'done' | 'awaiting-catch-up' | 'interrupted';

const scheduleReceipt = async (row: ITransaction, pass: PassState) => {
  const receiptAt = nowSeconds() + RECEIPT_INTERVAL_SECONDS;
  await Repo.transactions.where({ id: row.id }).modify(tx => {
    tx.nextRelayAt = receiptAt;
  });
  noteDue(pass, receiptAt);
};

const sweepRow = async (row: ITransaction, at: number, pass: PassState): Promise<RowOutcome> => {
  const targets = targetsOf(row);
  if (isInert(targets)) {
    await markRetriesStopped(row, targets, at);
    return 'done';
  }

  if (row.nextRelayAt === undefined) {
    // First sighting: arm the schedule and leave. Pushing in the same breath as the
    // original relay would spend an attempt against identical conditions. Attempts start
    // at 1 to count that original relay.
    //
    // Measured from the original relay (`completedAt`), not from now: a row first sighted
    // hours later (the wallet was closed) has already served the wait. Not `initiatedAt`
    // either, which is stamped at queue time and can precede the relay by more than the
    // whole delay, arming a push while the original relay may still be in flight. No
    // `completedAt` means the terminal write has not run, so the relay IS in flight and
    // the wait starts now. Clamped to now so a clock that moved backwards cannot park the
    // row in the future.
    const now = nowSeconds();
    const armedAt = Math.min(row.completedAt ?? now, now) + retryDelayFor(1);
    await Repo.transactions.where({ id: row.id }).modify(tx => {
      tx.relayAttempts = attemptsOf(row);
      tx.nextRelayAt = armedAt;
    });
    noteDue(pass, armedAt);
    return 'done';
  }

  const catchUp = row.relayOutageDeferred === true && pass.caughtUp;
  if (row.nextRelayAt > at && !catchUp) {
    noteDue(pass, row.nextRelayAt);
    return row.relayOutageDeferred ? 'awaiting-catch-up' : 'done';
  }

  const receipt = await readReceipt(row, targets.owed);
  if (receipt === 'killed') {
    // Recorded before the write, so a write that fails still ends the pass. The read may
    // still be parked in the abandoned hold, so the row spends and records nothing and
    // moves to the step it would serve next, its outage mark with it: left due, every
    // later pass would open on the same read and never reach the rows behind.
    pass.interrupted = true;
    const backoffAt = nowSeconds() + nextStepDelayOf(row, targets, at);
    await Repo.transactions.where({ id: row.id }).modify(tx => {
      tx.nextRelayAt = backoffAt;
      delete tx.relayOutageDeferred;
    });
    noteDue(pass, backoffAt);
    return 'interrupted';
  }
  if (receipt === 'consumed') {
    // Consumed on chain: the recipient had every body. Terminal, and it clears any
    // `undelivered` the row picked up on the way.
    await recordNoteDelivery(row.id, 'confirmed');
    return 'done';
  }

  const noteIds = pushesFor(row, targets, at);
  if (noteIds.length === 0) {
    // Pushes are over for this row; receipts go on hourly until the receipt window ends.
    await markRetriesStopped(row, targets, at);
    const receiptAt = nowSeconds() + RECEIPT_INTERVAL_SECONDS;
    await Repo.transactions.where({ id: row.id }).modify(tx => {
      tx.nextRelayAt = receiptAt;
      delete tx.relayOutageDeferred;
    });
    noteDue(pass, receiptAt);
    return 'done';
  }

  if (pass.pushesStopped === 'notConfigured') {
    // No transport: no push and nothing spent. The receipt above is all this row gets.
    await scheduleReceipt(row, pass);
    return 'done';
  }
  if (fusedNow(pass)) {
    // Pushes have parked the realm's lock until evicted, so the fuse holds them to one
    // probe per window. Nothing is spent and the row stays due; the next pass that may
    // push is the one after the window.
    noteDue(pass, pass.fusedUntil ?? at);
    return 'done';
  }
  if (pass.pushesStopped === 'outage') {
    // The pass stopped pushing before this row. It spends nothing and is left as it is:
    // still due, so the next pass pushes it.
    noteDue(pass, row.nextRelayAt);
    return 'done';
  }

  const verifying = targets.retry.length === 0;
  const acked: string[] = [];
  const dead: string[] = [];
  let outage = false;
  // Every owed note the transport acknowledged, the legacy `relayed` row's implied ones included:
  // a partial list written for that row would read as the rest unacknowledged.
  const ackedSoFar = () => [...targets.acked, ...acked.filter(noteId => !targets.acked.includes(noteId))];
  for (const [index, noteId] of noteIds.entries()) {
    // A push earlier in the row may have re-armed the fuse. The row then ends here as if its
    // loop had, keeping what its earlier notes got and serving the step after a push.
    if (index > 0 && fusedNow(pass)) break;
    const known = acked.length + dead.length;
    try {
      await midenClientProxy.relayPrivateNoteById(noteId, targets.recipient!);
      // Only a push that resolved withdraws the fuse's evidence: it is the probe that parks.
      noteSyncSuccess('note-delivery');
      acked.push(noteId);
      pass.caughtUp = true;
      // The transport acknowledges a note it already holds as it does a new one, so an
      // ACK proves neither storage nor receipt. Only the nullifier does.
      console.info('[noteDeliverySweep] transport acknowledged private note', {
        txId: row.id,
        noteId,
        attempts: attemptsOf(row) + 1,
        priorState: row.noteDelivery
      });
    } catch (error) {
      const failure = classifyRelayFailure(error);
      console.warn('[noteDeliverySweep] push failed', {
        txId: row.id,
        noteId,
        failure,
        attempts: attemptsOf(row) + 1,
        priorState: row.noteDelivery,
        error
      });
      bookPushFailure(failure, error);
      if (failure === 'interrupted') {
        // Recorded before any write, so a write that fails still ends the pass (the row's
        // isolation reads this flag).
        pass.interrupted = true;
        // The push may still be parked in the abandoned hold, so it spends nothing and
        // records nothing, but the row moves to its next step: left due, the next lap
        // would walk straight back into the same parked call. Its outage mark goes too, so
        // no catch-up can pull it forward before that step.
        const backoffAt = nowSeconds() + retryDelayFor(attemptsOf(row));
        await Repo.transactions.where({ id: row.id }).modify(tx => {
          tx.nextRelayAt = backoffAt;
          delete tx.relayOutageDeferred;
        });
        noteDue(pass, backoffAt);
        return 'interrupted';
      }
      if (failure === 'notConfigured') {
        pass.pushesStopped = 'notConfigured';
        await scheduleReceipt(row, pass);
        return 'done';
      }
      if (failure === 'storeLoss') dead.push(noteId);
      if (failure === 'outage') {
        pass.pushesStopped = 'outage';
        outage = true;
        break;
      }
    }
    // Persisted before the next note's push, so a later push that ends the row early (an
    // eviction, a disabled transport) cannot take this note's outcome with it. The last
    // note's outcome rides on the row's write below.
    if (acked.length + dead.length > known && index < noteIds.length - 1) {
      const soFar = ackedSoFar();
      await recordNoteDelivery(
        row.id,
        targets.owed.every(owedId => soFar.includes(owedId)) ? 'relayed' : (row.noteDelivery ?? 'pending'),
        { ackedNoteIds: soFar, ...(dead.length > 0 ? { deadNoteIds: dead } : {}) }
      );
    }
  }

  // A failed push says nothing against an earlier acknowledgement, so the row reads
  // `relayed` exactly while every owed note has one.
  const ackedAfter = ackedSoFar();
  const allAcked = targets.owed.every(noteId => ackedAfter.includes(noteId));
  await recordNoteDelivery(row.id, allAcked ? 'relayed' : 'undelivered', {
    ackedNoteIds: ackedAfter,
    ...(dead.length > 0 ? { deadNoteIds: dead } : {})
  });

  const attempts = attemptsOf(row) + 1;
  // A verification step counts only once every note it set out to push was acknowledged or
  // found dead. One a failed push or an early stop left short is served again on the retry
  // schedule, and counts as done once that schedule's own bounds would have ended it.
  const repeatStep =
    verifying &&
    noteIds.some(noteId => !acked.includes(noteId) && !dead.includes(noteId)) &&
    !retryBoundsPassed(row, attempts, at);
  const verifyPushes = verifying ? verifyPushesOf(row) + (repeatStep ? 0 : 1) : 0;
  const updated: ITransaction = {
    ...row,
    relayAttempts: attempts,
    relayVerifyPushes: verifyPushes,
    relayAckedNoteIds: ackedAfter,
    relayDeadNoteIds: [...storedNoteIds(row.relayDeadNoteIds), ...dead]
  };
  const after = targetsOf(updated);
  // Stamped from the clock at write time, not from the pass's start: each push can take a
  // gRPC timeout, so a slow pass could otherwise stamp a time already past and collapse
  // the spread these delays exist to create.
  const now = nowSeconds();
  let nextRelayAt = now + RECEIPT_INTERVAL_SECONDS;
  if (after.retry.length > 0 || repeatStep) nextRelayAt = now + retryDelayFor(attempts);
  else if (verifyPushes < VERIFY_DELAYS_SECONDS.length) nextRelayAt = now + VERIFY_DELAYS_SECONDS[verifyPushes]!;
  await Repo.transactions.where({ id: row.id }).modify(tx => {
    tx.relayAttempts = attempts;
    tx.nextRelayAt = nextRelayAt;
    if (verifying) tx.relayVerifyPushes = verifyPushes;
    // Each outage mark buys one catch-up push; the push that spends it clears it.
    if (outage) tx.relayOutageDeferred = true;
    else delete tx.relayOutageDeferred;
  });
  noteDue(pass, nextRelayAt);
  await markRetriesStopped(updated, after, at);
  return 'done';
};

/**
 * Rows the sweep looks at: a private send that owes a delivery and has not been proven
 * delivered, within the receipt window. Ordered oldest-first so a backlog drains in the
 * order the notes were relayed.
 */
const candidateRows = async (at: number): Promise<ITransaction[]> => {
  const rows = await Repo.transactions.where('noteDelivery').anyOf(SWEEPABLE).toArray();
  return rows.filter(row => at - relayedAt(row) <= RECEIPT_WINDOW_SECONDS).sort((a, b) => relayedAt(a) - relayedAt(b));
};

let running: Promise<void> | undefined;
/**
 * Until when no pass has work, as the last pass found it, the delivery-write count it found
 * it at, and whether the pass stopped because the 'note-delivery' fuse was lit: that
 * finding holds only while the fuse still reads lit, since an endpoint change clears it.
 */
let idle: { until: number; writes: number; fused: boolean } | undefined;

/** Forget the last pass's idle finding, so the next call queries. */
export const __resetNoteDeliverySweepForTests = () => {
  idle = undefined;
};

const runGuardedPass = async (): Promise<void> => {
  const writes = noteDeliveryWriteCount();
  idle = undefined;
  try {
    const { nextDueAt, fused } = await runPass();
    idle = { until: Math.min(nextDueAt, nowSeconds() + RECEIPT_INTERVAL_SECONDS), writes, fused };
  } catch (error) {
    console.warn('[noteDeliverySweep] pass failed', error);
  }
};

/** Why this pass may not push at all, if it may not. */
const passStopOf = (): Pick<PassState, 'pushesStopped' | 'fusedUntil'> => {
  if (!isNoteTransportConfigured()) return { pushesStopped: 'notConfigured' };
  return isSyncFused('note-delivery') ? fusedStopOf() : {};
};

/**
 * {@link sweepRow}, with a throw kept to its own row so the rows after it still run. A row
 * that threw notes no due time, so it cannot hold the idle gate at now and re-run the
 * whole pass every lap; the pass after the gate's next opening tries it again.
 */
const sweepRowIsolated = async (row: ITransaction, at: number, pass: PassState): Promise<RowOutcome> => {
  try {
    return await sweepRow(row, at, pass);
  } catch (error) {
    // A killed pipeline is not this row's problem: the client is parked or torn down, and
    // the pass ends there rather than push again on a rebuilt one.
    if (pass.interrupted || isKilledPipeline(error)) {
      pass.interrupted = true;
      console.warn('[noteDeliverySweep] pass ended by a killed pipeline', { txId: row.id, error });
      return 'interrupted';
    }
    console.warn('[noteDeliverySweep] row failed; going on with the next', { txId: row.id, error });
    return 'done';
  }
};

/** One pass over the candidate rows. Resolves to when a row next needs one, and whether the fuse held its pushes. */
const runPass = async (): Promise<{ nextDueAt: number; fused: boolean }> => {
  // Eligibility is judged against one snapshot so a single pass is internally consistent.
  const at = nowSeconds();
  const rows = await candidateRows(at);
  const pass: PassState = { caughtUp: false, interrupted: false, nextDueAt: Infinity, ...passStopOf() };
  const awaitingCatchUp: ITransaction[] = [];

  for (const [index, row] of rows.entries()) {
    const outcome = await sweepRowIsolated(row, at, pass);
    if (outcome === 'interrupted') {
      // The pass ends at an eviction; the rows it did not reach are due when they were.
      for (const unvisited of rows.slice(index + 1)) noteDue(pass, unvisited.nextRelayAt ?? at);
      break;
    }
    if (outcome === 'awaiting-catch-up') awaitingCatchUp.push(row);
  }

  // Rows an outage deferred that the pass reached before its first success.
  if (pass.caughtUp && !pass.interrupted) {
    for (const row of awaitingCatchUp) {
      if ((await sweepRowIsolated(row, at, pass)) === 'interrupted') break;
    }
  }
  return { nextDueAt: pass.nextDueAt, fused: pass.pushesStopped === 'fused' };
};

/**
 * Retry private-note deliveries until the transport takes them, and watch for receipts.
 *
 * The SDK does not re-send a private note whose relay failed, so this sweep is the only
 * retry there is. Each owed note of a row is tracked on its own:
 *
 * - A note the transport has not acknowledged is pushed on {@link RETRY_DELAYS_SECONDS}
 *   until it is acknowledged or {@link RETRY_WINDOW_SECONDS} has passed since the send.
 * - Once every live note is acknowledged, two verification steps follow
 *   ({@link VERIFY_DELAYS_SECONDS}). The 0.17 transport acknowledges a note it already
 *   holds as it does a new one, so an ACK proves neither storage nor receipt. A step
 *   counts once every note it set out to push was acknowledged or found dead, and one
 *   left short is repeated on the retry backoff.
 * - No push of either kind is made past {@link RETRY_WINDOW_SECONDS} after the send or
 *   {@link MAX_RELAY_ATTEMPTS}; the row then serves receipts only.
 * - Only the nullifier proves delivery: the recipient cannot consume a private note it
 *   never received. Every owed note is checked before each push and hourly once pushes
 *   are over, until {@link RECEIPT_WINDOW_SECONDS} after the send; all of them consumed
 *   is `confirmed`, which is terminal.
 *
 * A failed push is classified ({@link classifyRelayFailure}): an outage stops pushes for
 * the rest of the pass, and the first push that succeeds in a later pass makes the rows
 * the outage deferred due at once. Each push and each receipt read is a timer-driven hold
 * with a fuse of its own: while 'note-delivery' is lit no pass pushes, and while
 * 'note-delivery-receipt' is lit no receipt is read and the row counts as unproven. Rows
 * restored from a backup only get receipts, and a row with nothing to push is left alone.
 * A failed push never downgrades an earlier acknowledgement and never fails a landed
 * transaction.
 *
 * Every platform calls this after its sync laps, so a call costs nothing when it can:
 * calls that overlap share one pass, a call before anything is due makes no query (for
 * an hour at most, and any delivery write ends the wait at once), and it never rejects,
 * so a caller fires it and forgets it.
 */
export const sweepNoteDeliveries = (): Promise<void> => {
  if (running) return running;
  const idleHolds =
    idle !== undefined &&
    idle.writes === noteDeliveryWriteCount() &&
    nowSeconds() < idle.until &&
    (!idle.fused || isSyncFused('note-delivery'));
  if (idleHolds) return Promise.resolve();
  running = runGuardedPass().finally(() => {
    running = undefined;
  });
  return running;
};
