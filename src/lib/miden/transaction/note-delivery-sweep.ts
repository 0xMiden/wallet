import {
  isSyncFused,
  noteNonEvictionSyncFailure,
  noteSyncSuccess,
  noteSyncWatchdogEviction,
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
  relayRecipientOf
} from './helper';
import { RETRY_WINDOW_SECONDS } from './note-delivery-window';
import { midenClientProxy } from '../back/miden-client-proxy';
import { INoteDeliveryState, ITransaction } from '../db/types';
import { errorMessageParts, isKilledPipeline } from '../sdk/sdk-error-code';
import { isSyncWatchdogEviction } from '../sdk/wasm-client-poison';

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

/** What a failed push says about what to do next; see {@link classifyRelayFailure}. */
export type RelayFailureClass = 'notConfigured' | 'interrupted' | 'outage' | 'storeLoss' | 'noteLocal';

/** gRPC codes for which the request itself, not the transport, is at fault. */
const NOTE_LOCAL_CODES = ['InvalidArgument', 'FailedPrecondition'];

/**
 * Classify a failed push by what it means for this note, this row and the rest of the
 * pass. Pure: it reads only the error.
 *
 * - `notConfigured`: the client has no transport (`NoteTransportError::Disabled`). No
 *   push can work, so none is made and nothing is spent; receipts still run.
 * - `interrupted`: the call was torn down from outside (a lock eviction poisoning the
 *   client, or an offscreen kill) and may still be running, so the pass stops, nothing
 *   is spent or recorded, and the row only moves to its next step.
 * - `storeLoss`: this client's store has no relayable copy of the note (a restore into
 *   a fresh store, a reinstall, a raze, or a record with no details). No later push can
 *   work, so the note is recorded dead; its siblings go on.
 * - `noteLocal`: the note's own request was refused (no inclusion proof yet, or the
 *   transport rejected it as invalid). The note spends its attempt and the pass goes on:
 *   the next row's note is a different request.
 * - `outage`: everything else, including a gRPC status the sweep does not know and text
 *   it does not recognize. A transport that is down or overloaded fails every push the
 *   same way, so the pass stops pushing rather than spend an attempt on every row.
 *
 * Matched on the SDK's error text, with or without the offscreen bus's
 * `Offscreen call '...' failed:` prefix. A failed send reads
 * `... Send note with proof failed: Status { code: <Code>, ... }` (tonic's Debug output),
 * and a failed browser fetch is `Unknown`.
 */
export const classifyRelayFailure = (error: unknown): RelayFailureClass => {
  if (isKilledPipeline(error)) return 'interrupted';
  const parts = errorMessageParts(error);
  const has = (phrase: string) => parts.some(part => part.includes(phrase));
  if (has('note transport is disabled')) return 'notConfigured';
  if (has('No output note found for the given id') || has('output note has no details to relay')) return 'storeLoss';
  if (has('output note has no inclusion proof')) return 'noteLocal';
  const code = parts.map(part => /\bStatus \{ code: (\w+)/.exec(part)?.[1]).find(Boolean);
  return code && NOTE_LOCAL_CODES.includes(code) ? 'noteLocal' : 'outage';
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
  const live = recipient ? owed.filter(noteId => !row.relayDeadNoteIds?.includes(noteId)) : [];
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

/** Whether the retry schedule is over: nothing left to retry, the window closed, or the cap reached. */
const retriesOver = (row: ITransaction, targets: DeliveryTargets, at: number) =>
  row.restoredFromBackup === true ||
  targets.retry.length === 0 ||
  at - relayedAt(row) > RETRY_WINDOW_SECONDS ||
  attemptsOf(row) >= MAX_RELAY_ATTEMPTS;

/** The notes to push now: the unacknowledged ones while retries last, else the verification pushes. */
const pushesFor = (row: ITransaction, targets: DeliveryTargets, at: number): string[] => {
  if (row.restoredFromBackup) return [];
  if (targets.retry.length > 0) return retriesOver(row, targets, at) ? [] : targets.retry;
  return verifyPushesOf(row) < VERIFY_DELAYS_SECONDS.length ? targets.verify : [];
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

/** Every owed note consumed on chain, which is the only proof the recipient had the bodies. */
const allConsumed = async (row: ITransaction, owed: string[]): Promise<boolean> => {
  try {
    for (const noteId of owed) {
      if (!(await midenClientProxy.isOutputNoteConsumed(noteId))) return false;
    }
    return owed.length > 0;
  } catch (error) {
    // Unreadable this cycle. Go on to the push: an extra push of a note that was
    // delivered costs the recipient nothing, whereas skipping one that was not is the
    // failure this sweep exists to prevent.
    console.warn('[noteDeliverySweep] could not read delivery receipt; pushing anyway', {
      txId: row.id,
      attempts: attemptsOf(row),
      priorState: row.noteDelivery,
      error
    });
    return false;
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
  /** The earliest time (unix seconds) a row the pass saw next needs the sweep. */
  nextDueAt: number;
}

const noteDue = (pass: PassState, at: number) => {
  pass.nextDueAt = Math.min(pass.nextDueAt, at);
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

  if (await allConsumed(row, targets.owed)) {
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
  if (pass.pushesStopped === 'fused') {
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
      if (isSyncWatchdogEviction(error)) noteSyncWatchdogEviction('note-delivery');
      else noteNonEvictionSyncFailure('note-delivery');
      if (failure === 'interrupted') {
        // The push may still be parked in the abandoned hold, so it spends nothing and
        // records nothing, but the row moves to its next step: left due, the next lap
        // would walk straight back into the same parked call.
        const backoffAt = nowSeconds() + retryDelayFor(attemptsOf(row));
        await Repo.transactions.where({ id: row.id }).modify(tx => {
          tx.nextRelayAt = backoffAt;
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
  const verifyPushes = verifying ? verifyPushesOf(row) + 1 : 0;
  const updated: ITransaction = {
    ...row,
    relayAttempts: attempts,
    relayVerifyPushes: verifyPushes,
    relayAckedNoteIds: ackedAfter,
    relayDeadNoteIds: [...(row.relayDeadNoteIds ?? []), ...dead]
  };
  const after = targetsOf(updated);
  // Stamped from the clock at write time, not from the pass's start: each push can take a
  // gRPC timeout, so a slow pass could otherwise stamp a time already past and collapse
  // the spread these delays exist to create.
  const now = nowSeconds();
  let nextRelayAt = now + RECEIPT_INTERVAL_SECONDS;
  if (after.retry.length > 0) nextRelayAt = now + retryDelayFor(attempts);
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
/** Until when no pass has work, as the last pass found it, and the delivery-write count it found it at. */
let idle: { until: number; writes: number } | undefined;

/** Forget the last pass's idle finding, so the next call queries. */
export const __resetNoteDeliverySweepForTests = () => {
  idle = undefined;
};

const runGuardedPass = async (): Promise<void> => {
  const writes = noteDeliveryWriteCount();
  idle = undefined;
  try {
    const nextDueAt = await runPass();
    idle = { until: Math.min(nextDueAt, nowSeconds() + RECEIPT_INTERVAL_SECONDS), writes };
  } catch (error) {
    console.warn('[noteDeliverySweep] pass failed', error);
  }
};

/** Why this pass may not push at all, if it may not. */
const passStopOf = (): Pick<PassState, 'pushesStopped' | 'fusedUntil'> => {
  if (!isNoteTransportConfigured()) return { pushesStopped: 'notConfigured' };
  if (!isSyncFused('note-delivery')) return {};
  const fusedForMs = Math.max(0, (syncFuseUntilMs('note-delivery') ?? 0) - monotonicNowMs());
  return { pushesStopped: 'fused', fusedUntil: nowSeconds() + Math.ceil(fusedForMs / 1000) };
};

/** One pass over the candidate rows. Resolves to when a row next needs one. */
const runPass = async (): Promise<number> => {
  // Eligibility is judged against one snapshot so a single pass is internally consistent.
  const at = nowSeconds();
  const rows = await candidateRows(at);
  const pass: PassState = { caughtUp: false, nextDueAt: Infinity, ...passStopOf() };
  const awaitingCatchUp: ITransaction[] = [];

  for (const [index, row] of rows.entries()) {
    const outcome = await sweepRow(row, at, pass);
    if (outcome === 'interrupted') {
      // The pass ends at an eviction; the rows it did not reach are due when they were.
      for (const unvisited of rows.slice(index + 1)) noteDue(pass, unvisited.nextRelayAt ?? at);
      return pass.nextDueAt;
    }
    if (outcome === 'awaiting-catch-up') awaitingCatchUp.push(row);
  }

  // Rows an outage deferred that the pass reached before its first success.
  if (pass.caughtUp) {
    for (const row of awaitingCatchUp) {
      if ((await sweepRow(row, at, pass)) === 'interrupted') break;
    }
  }
  return pass.nextDueAt;
};

/**
 * Retry private-note deliveries until the transport takes them, and watch for receipts.
 *
 * The SDK does not re-send a private note whose relay failed, so this sweep is the only
 * retry there is. Each owed note of a row is tracked on its own:
 *
 * - A note the transport has not acknowledged is pushed on {@link RETRY_DELAYS_SECONDS}
 *   until it is acknowledged or {@link RETRY_WINDOW_SECONDS} has passed since the send.
 * - Once every live note is acknowledged, two verification pushes follow
 *   ({@link VERIFY_DELAYS_SECONDS}). The 0.17 transport acknowledges a note it already
 *   holds as it does a new one, so an ACK proves neither storage nor receipt.
 * - Only the nullifier proves delivery: the recipient cannot consume a private note it
 *   never received. Every owed note is checked before each push and hourly once pushes
 *   are over, until {@link RECEIPT_WINDOW_SECONDS} after the send; all of them consumed
 *   is `confirmed`, which is terminal.
 *
 * A failed push is classified ({@link classifyRelayFailure}): an outage stops pushes for
 * the rest of the pass, and the first push that succeeds in a later pass makes the rows
 * the outage deferred due at once. Each push is a timer-driven hold, so its outcome feeds
 * the 'note-delivery' fuse, and while that fuse is lit no pass pushes; receipts are local
 * reads and go on regardless. Rows restored from a backup only get receipts, and a
 * row with nothing to push is left alone. A failed push never downgrades an earlier
 * acknowledgement and never fails a landed transaction.
 *
 * Every platform calls this after its sync laps, so a call costs nothing when it can:
 * calls that overlap share one pass, a call before anything is due makes no query (for
 * an hour at most, and any delivery write ends the wait at once), and it never rejects,
 * so a caller fires it and forgets it.
 */
export const sweepNoteDeliveries = (): Promise<void> => {
  if (running) return running;
  if (idle && idle.writes === noteDeliveryWriteCount() && nowSeconds() < idle.until) return Promise.resolve();
  running = runGuardedPass().finally(() => {
    running = undefined;
  });
  return running;
};
