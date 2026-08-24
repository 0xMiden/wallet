import * as Repo from 'lib/miden/repo';

import { recordNoteDelivery } from './helper';
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
 * made. Spread wide on purpose: the failures this defends against are races
 * (a recipient's cursor advancing past a stored note, a transport that accepts and
 * loses), and retrying immediately would re-run the same race under the same
 * conditions. An hour of coverage across three re-pushes costs nothing and spans
 * far more independent fetch cycles than a tight retry would.
 */
const RELAY_BACKOFF_SECONDS = [60, 300, 1_800];

/**
 * How old a send may be and still be swept, in seconds.
 *
 * Bounds the sweep to rows whose delivery could plausibly still be in flight. Two
 * reasons, both about not making things worse. A months-old send whose note the
 * recipient consumed long ago needs no push, and re-pushing it would put note
 * bodies back on the transport for no one. More importantly, a row old enough that
 * this client's store no longer tracks its output note cannot be re-pushed at all —
 * `sendPrivateOutput` rejects with `No output note found for the given id` — and
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
 * Rows the sweep should look at: a private send that has a landed note and has not
 * been proven delivered. Ordered oldest-first so a backlog drains in the order the
 * sends happened.
 */
const dueRows = async (at: number): Promise<ITransaction[]> => {
  const rows = await Repo.transactions.where('noteDelivery').anyOf(SWEEPABLE).toArray();
  return rows
    .filter(row => (row.relayAttempts ?? 1) < MAX_RELAY_ATTEMPTS)
    .filter(row => at - (row.initiatedAt ?? 0) <= RELAY_WINDOW_SECONDS)
    .sort((a, b) => (a.initiatedAt ?? 0) - (b.initiatedAt ?? 0));
};

const relayTargetOf = (row: ITransaction): { noteId: string; recipient: string } | undefined => {
  const noteId = row.outputNoteIds?.[0];
  if (!noteId || !row.secondaryAccountId) return undefined;
  return { noteId, recipient: row.secondaryAccountId };
};

/**
 * Re-push private notes that have not been proven delivered, and retire the ones
 * that have.
 *
 * Why a re-push is the right instrument. A private note is reachable only through
 * the transport, and the transport hands the recipient an opaque pagination cursor
 * that the recipient persists verbatim. If that cursor ever advances past a stored
 * note — which is what note-transport-service#77 did, via timestamp collisions and
 * a per-tag query interleave — the note becomes unreachable for that recipient
 * permanently, while the sender's push was ACKed and its transaction landed. No
 * error exists anywhere in that sequence for the wallet to react to.
 *
 * A re-push escapes it structurally. The transport stores notes with an append-only
 * insert (no upsert, no dedupe by note id), so each push takes a FRESH cursor
 * position, which is by construction above whatever cursor the recipient has
 * already persisted. The recipient's very next fetch therefore sees it. The same
 * mechanism covers a transport that accepted and dropped the note, and a recipient
 * whose tag started being tracked after the cursor had moved on.
 *
 * It is safe to repeat. Imports dedupe on the details commitment, so a note the
 * recipient already holds is a no-op for them, and the hint is re-derived from the
 * note's stored `expected_height` on every call, so a late re-push is as correct as
 * the first one.
 *
 * Failures are swallowed per row on purpose: this runs as maintenance behind
 * transactions that have already landed, so one row's transport error must not stop
 * the rest of the sweep or surface as a transaction failure. The attempt is still
 * counted and the row still records `undelivered`, so nothing is hidden.
 */
export const sweepNoteDeliveries = async (): Promise<void> => {
  const at = nowSeconds();
  const rows = await dueRows(at);

  for (const row of rows) {
    const target = relayTargetOf(row);
    if (!target) {
      // Nothing to re-push with. Leave the row alone rather than counting an
      // attempt that cannot happen — the existing state already says delivery was
      // never confirmed, and burning attempts here would only hide that.
      continue;
    }

    if (row.nextRelayAt === undefined) {
      // First sighting: arm the schedule and leave. The original relay just happened
      // (or is the reason this row is here at all), so pushing again in the same
      // breath would spend an attempt against identical conditions and prove
      // nothing. Attempts start at 1 to count that original relay.
      await Repo.transactions.where({ id: row.id }).modify(tx => {
        tx.relayAttempts = row.relayAttempts ?? 1;
        tx.nextRelayAt = at + backoffFor(1);
      });
      continue;
    }

    if (row.nextRelayAt > at) continue;

    try {
      if (await midenClientProxy.isOutputNoteConsumed(target.noteId)) {
        // Consumed on chain: the recipient had the body. Terminal, and it clears
        // any `undelivered` this row picked up on the way — a warning that outlived
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
        error
      });
    }

    const attempts = (row.relayAttempts ?? 1) + 1;
    let outcome: INoteDeliveryState = 'relayed';
    try {
      await midenClientProxy.relayPrivateNoteById(target.noteId, target.recipient);
    } catch (error) {
      // A failed RE-push says nothing about the original one. Where the first relay
      // was ACKed, downgrading the row to `undelivered` here would invent a problem
      // and show the user a warning about a note that may well be in flight; keep
      // what the row already knew. Only `pending` — which means no ACK was ever
      // obtained — becomes `undelivered`.
      outcome = row.noteDelivery === 'relayed' ? 'relayed' : 'undelivered';
      console.warn('[noteDeliverySweep] re-push failed', {
        txId: row.id,
        noteId: target.noteId,
        attempts,
        priorState: row.noteDelivery,
        error
      });
    }

    await recordNoteDelivery(row.id, outcome);
    await Repo.transactions.where({ id: row.id }).modify(tx => {
      tx.relayAttempts = attempts;
      tx.nextRelayAt = at + backoffFor(attempts);
    });
  }
};
