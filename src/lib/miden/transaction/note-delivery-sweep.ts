import * as Repo from 'lib/miden/repo';

import { recordNoteDelivery, relayNoteIdsOf, relayRecipientOf } from './helper';
import { midenClientProxy } from '../back/miden-client-proxy';
import { INoteDeliveryState, ITransaction } from '../db/types';

/**
 * How many times a row's private note may be handed to the transport in total,
 * counting the original relay. Four gives three re-pushes.
 *
 * Bounded rather than open-ended because a note that is simply not being consumed
 * yet is indistinguishable, from the sender, from one that never arrived: the only
 * receipt available is the nullifier (see `isOutputNoteConsumed`), and a recipient
 * who is merely offline produces the same reading as one who never got the body.
 * So the sweep buys independent chances rather than waiting for certainty, and
 * stops.
 */
export const MAX_RELAY_ATTEMPTS = 4;

/**
 * Delay in seconds before each subsequent attempt, indexed by attempts already
 * made. Spread wide on purpose: the failure this defends against is a transport that
 * accepted a note and did not store it, and retrying immediately would re-run the
 * same race against the same conditions. An hour of coverage across three re-pushes
 * costs nothing and spans far more independent chances than a tight retry would.
 */
const RELAY_BACKOFF_SECONDS = [60, 300, 1_800];

/**
 * How old a send may be and still be swept, in seconds.
 *
 * Bounds the sweep to rows whose delivery could plausibly still be in flight. Two
 * reasons, both about not making things worse. A months-old send whose note the
 * recipient consumed long ago needs no push, and re-pushing it would put note
 * bodies back on the transport for no one. More importantly, a row old enough that
 * this client's store no longer tracks its output note cannot be re-pushed at all -
 * `sendPrivateOutput` rejects with `No output note found for the given id` - and
 * without this bound every historical private send would collect that failure and
 * light up a delivery warning on a send that was fine.
 */
const RELAY_WINDOW_SECONDS = 6 * 60 * 60;

const nowSeconds = () => Math.floor(Date.now() / 1000);

const backoffFor = (attempts: number): number => {
  const last = RELAY_BACKOFF_SECONDS[RELAY_BACKOFF_SECONDS.length - 1] ?? 1_800;
  return RELAY_BACKOFF_SECONDS[Math.min(attempts, RELAY_BACKOFF_SECONDS.length - 1)] ?? last;
};

/** Delivery states that still warrant a re-push. `confirmed` is terminal. */
const SWEEPABLE: INoteDeliveryState[] = ['pending', 'relayed', 'undelivered'];

/**
 * Attempts already made on a row, normalized.
 *
 * Read defensively because this counter is the only thing bounding how often a
 * private note body goes back on the wire, and it arrives from a store that
 * `importDb` populates from a user-supplied backup file. A hand-edited `0`, a
 * negative, or a non-finite value would otherwise never reach the cap and would
 * re-push on every backoff step for the whole window.
 */
const attemptsOf = (row: ITransaction): number => {
  const stored = Math.trunc(row.relayAttempts ?? 1);
  if (!Number.isFinite(stored)) return MAX_RELAY_ATTEMPTS;
  return Math.min(Math.max(stored, 1), MAX_RELAY_ATTEMPTS);
};

/**
 * Rows the sweep should look at: a private send that has a landed note and has not
 * been proven delivered. Ordered oldest-first so a backlog drains in the order the
 * notes were relayed.
 */
const candidateRows = async (at: number): Promise<ITransaction[]> => {
  const rows = await Repo.transactions.where('noteDelivery').anyOf(SWEEPABLE).toArray();
  // Aged from the relay (`completedAt`), not the queue stamp, for the reason the arming
  // below gives: a send that waited queued for hours relays only when it completes.
  const relayedAt = (row: ITransaction) => row.completedAt ?? row.initiatedAt ?? 0;
  return rows
    .filter(row => attemptsOf(row) < MAX_RELAY_ATTEMPTS)
    .filter(row => at - relayedAt(row) <= RELAY_WINDOW_SECONDS)
    .sort((a, b) => relayedAt(a) - relayedAt(b));
};

const relayTargetOf = (row: ITransaction): { noteId: string; recipient: string } | undefined => {
  // The row holds one delivery state for the private notes it owes the relay (`relayNoteIdsOf`), so one note's
  // receipt or re-push speaks for the row only when it owes exactly that one.
  const owed = relayNoteIdsOf(row);
  if (owed.length !== 1) return undefined;
  const noteId = owed[0];
  const recipient = relayRecipientOf(row);
  // A note recorded dead has no relayable form, so a row owing only that one is inert.
  if (!noteId || !recipient || row.relayDeadNoteIds?.includes(noteId)) return undefined;
  return { noteId, recipient };
};

/**
 * Retry unconfirmed private-note deliveries with a bounded schedule.
 *
 * An ACK can mean either an insertion or an idempotent duplicate acknowledgement.
 * Neither proves the recipient received the body: a stored note can remain below
 * the recipient's cursor (note-transport-service#77). Only its on-chain nullifier
 * confirms delivery. A genuinely missing note is stored by a retry; an already
 * stored note is acknowledged at the SDK fetch boundary so it leaves the outbox.
 * Every rejection that still reaches the sweep is therefore a failure, including a
 * duplicate that boundary did not recognize, whose outbox entry is then stuck.
 *
 * Per-row failures preserve a prior ACK and never fail a landed transaction.
 */
export const sweepNoteDeliveries = async (): Promise<void> => {
  // Eligibility is judged against one snapshot so a single pass is internally
  // consistent. Schedules, though, are stamped from the clock at WRITE time: each
  // row's relay carries a 45-second deadline, so a sweep with a few slow rows can
  // outlive a backoff step, and a `nextRelayAt` derived from the sweep's start would
  // then land in the past - re-pushing on the very next cycle and collapsing exactly
  // the spread these delays exist to create.
  const at = nowSeconds();
  const rows = await candidateRows(at);

  for (const row of rows) {
    const target = relayTargetOf(row);
    if (!target) {
      // Nothing to re-push with. Leave the row alone rather than counting an
      // attempt that cannot happen - the existing state already says delivery was
      // never confirmed, and burning attempts here would only hide that.
      continue;
    }

    if (row.nextRelayAt === undefined) {
      // First sighting: arm the schedule and leave. Pushing again in the same breath
      // as the original relay would spend an attempt against identical conditions and
      // prove nothing. Attempts start at 1 to count that original relay.
      //
      // The delay is measured from the ORIGINAL RELAY, not from now, because "it just
      // happened" is only true when the row is fresh. A row first sighted hours later
      // - the wallet was closed, or this is the first sync since - has already served
      // the wait, and arming another one from now would push its only attempts toward
      // the far end of `RELAY_WINDOW_SECONDS`, or past it.
      //
      // `completedAt` is the anchor, NOT `initiatedAt`: the latter is stamped when the
      // transaction was queued, so on a slow send (FIFO wait plus prove plus submit)
      // it can precede the relay by more than the whole delay - which would arm the
      // row due-now and re-push it while the original relay is possibly still in
      // flight, spending an attempt on exactly the identical conditions this wait
      // exists to avoid. No `completedAt` means the terminal write has not run yet, so
      // the relay IS still in flight and the wait starts now. Clamped to now so a
      // clock that moved backwards cannot park the row in the future.
      await Repo.transactions.where({ id: row.id }).modify(tx => {
        const now = nowSeconds();
        tx.relayAttempts = attemptsOf(row);
        tx.nextRelayAt = Math.min(row.completedAt ?? now, now) + backoffFor(1);
      });
      continue;
    }

    if (row.nextRelayAt > at) continue;

    try {
      if (await midenClientProxy.isOutputNoteConsumed(target.noteId)) {
        // Consumed on chain: the recipient had the body. Terminal, and it clears
        // any `undelivered` this row picked up on the way - a warning that outlived
        // the problem is its own kind of wrong.
        await recordNoteDelivery(row.id, 'confirmed');
        continue;
      }
    } catch (error) {
      // Receipt unreadable this cycle. Fall through to the re-push: an extra push
      // for a note that was in fact delivered costs the recipient nothing, whereas
      // skipping one for a note that was not is the failure this whole sweep exists
      // to prevent.
      console.warn('[noteDeliverySweep] could not read delivery receipt; re-pushing anyway', {
        txId: row.id,
        noteId: target.noteId,
        attempts: attemptsOf(row) + 1,
        priorState: row.noteDelivery,
        error
      });
    }

    const attempts = attemptsOf(row) + 1;
    let outcome: INoteDeliveryState = 'relayed';
    let acknowledged = false;
    try {
      await midenClientProxy.relayPrivateNoteById(target.noteId, target.recipient);
      acknowledged = true;
      // Duplicate SendNote responses are normalized before WASM sees them, so an
      // ACK can mean either a new insertion or an already-stored note. The relaying
      // realm logs `[noteRelay] SendNote duplicate acknowledged` for the latter, so an
      // ACK without that line is a note the transport did not hold: the silent loss
      // this sweep repairs. Only the nullifier proves delivery.
      console.info('[noteDeliverySweep] transport acknowledged private note', {
        txId: row.id,
        noteId: target.noteId,
        attempts,
        priorState: row.noteDelivery
      });
    } catch (error) {
      // A failed RE-push says nothing about the original one. Where the first relay
      // was ACKed, downgrading the row to `undelivered` here would invent a problem
      // and show the user a warning about a note that may well be in flight; keep
      // what the row already knew. Only `pending` - which means no ACK was ever
      // obtained - becomes `undelivered`.
      outcome = row.noteDelivery === 'relayed' ? 'relayed' : 'undelivered';
      console.warn('[noteDeliverySweep] re-push failed', {
        txId: row.id,
        noteId: target.noteId,
        attempts,
        priorState: row.noteDelivery,
        error
      });
    }

    if (acknowledged) await recordNoteDelivery(row.id, outcome, { ackedNoteIds: [target.noteId] });
    else await recordNoteDelivery(row.id, outcome);
    await Repo.transactions.where({ id: row.id }).modify(tx => {
      tx.relayAttempts = attempts;
      tx.nextRelayAt = nowSeconds() + backoffFor(attempts);
    });

    if (attempts >= MAX_RELAY_ATTEMPTS) {
      // Last attempt: the row drops out of the candidate set after this, so nothing
      // looks at it again - not even the nullifier check that could still have retired
      // it as `confirmed`. Worth one line whatever the outcome was, because `relayed`
      // renders as nothing at all in history, so a row that ends here leaves no other
      // trace of where it stopped. (Aging past `RELAY_WINDOW_SECONDS` is the other
      // exit and is deliberately silent: those rows are old enough that a re-push
      // could not have worked anyway.)
      console.warn('[noteDeliverySweep] attempts exhausted; no further re-push or receipt check', {
        txId: row.id,
        noteId: target.noteId,
        attempts,
        finalState: outcome
      });
    }
  }
};
