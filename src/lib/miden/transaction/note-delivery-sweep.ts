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

/**
 * Does this re-push failure mean "the transport already holds this note"?
 *
 * The transport stores notes with a bare insert against `notes.id BLOB PRIMARY KEY`
 * (note-transport-service, `database/sqlite/mod.rs`, no `ON CONFLICT` clause), so
 * re-pushing a note it already holds fails on that key. Its gRPC layer currently
 * surfaces the failure as `Internal` carrying the SQLite text rather than as
 * `AlreadyExists`, so matching on the message is the only option until the service
 * returns a distinguishable code (tracked upstream).
 *
 * Matching is deliberately narrow. The generic spellings — a bare
 * `ConstraintViolation`, or "already exists" on its own — appear in unrelated
 * failures on this path: tonic's stock `AlreadyExists` blurb, Dexie/IndexedDB
 * `ConstraintError`, and the SDK's own account-tree and asset-vault errors. Since a
 * match suppresses the delivery warning, an over-broad pattern would hide exactly
 * the failure this sweep exists to surface, so the id-collision spellings must name
 * the note key, and a status-code match must be a real `AlreadyExists` status.
 */
const isAlreadyStoredRejection = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return (
    // SQLite/diesel text for the `notes.id` collision, in either spelling the
    // service has been observed to produce.
    /(?:UNIQUE constraint failed|ConstraintViolation\()[^)]*\bnotes\.id\b/i.test(message) ||
    // A service that starts returning a proper gRPC status keeps working unchanged.
    /\bstatus:\s*AlreadyExists\b/i.test(message) ||
    /\bcode:\s*6\b.*\balready exists\b/i.test(message)
  );
};

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
 * A re-push escapes it structurally, but NOT by appending a second row. The
 * transport's `notes` table declares `id BLOB NOT NULL UNIQUE` (note-transport-
 * service, migration `20260422000000_add_seq_cursor`, the same change that
 * introduced `seq`), so re-pushing a note the transport ALREADY holds is rejected
 * outright rather than stored again. Verified against the deployed service: the
 * second `SendNote` of an identical note answers
 * `Internal — Failed to store note: ConstraintViolation("UNIQUE ...")`, and nothing
 * appears above the previous cursor.
 *
 * So the two outcomes of a re-push carry quite different information, and neither is
 * the intuitive reading:
 *
 *   - accepted -> the note was NOT on the transport, and now is, on a fresh `seq`
 *     above every recipient cursor. This is the silent-loss case actually happening,
 *     so a push that is accepted both DETECTS and REPAIRS it. The row stays
 *     `relayed` until a nullifier proves the recipient consumed it.
 *   - rejected as a duplicate -> the transport HOLDS the body. That is worth
 *     knowing, because `SendNoteResponse` is an empty message and so a successful
 *     push tells the sender nothing at all — but it is NOT proof of delivery, and
 *     the row stays `relayed` too.
 *
 * That second point is the easy mistake to make here, so it is worth being explicit
 * about why a duplicate-rejection must not be promoted to `confirmed`. "The bytes
 * are on the transport" is precisely the #77 state described above: the note is
 * stored and the recipient still cannot reach it. Worse, under the UNIQUE key a
 * re-push of a stored note is rejected rather than re-inserted, so it takes no new
 * `seq` and cannot lift the note above a cursor that has already passed it — a
 * rejection means this sweep did NOT repair anything. Reading it as success would
 * therefore retire exactly the rows exhibiting the bug, drop their remaining
 * attempts, and (since `confirmed` renders as "the recipient has received and spent
 * this private note") tell the user a note they may never see was spent. `confirmed`
 * stays exclusive to the nullifier.
 *
 * What the rejection IS good for is not raising a false alarm: it means the original
 * relay demonstrably reached the transport, so the row must not be downgraded to
 * `undelivered` on the strength of a "failed" re-push.
 *
 * Either way the recipient's next fetch is no worse off, and the hint is re-derived
 * from the note's stored `expected_height` on every call, so a late re-push is as
 * correct as the first one.
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
      // Accepted. Because the transport rejects duplicates, acceptance means the
      // note was NOT there — the silent loss this sweep exists to catch, caught.
      // It is now stored on a fresh `seq`, above every recipient cursor, so the
      // repair is already done; the row stays `relayed` until a nullifier confirms
      // it was actually consumed.
      //
      // Only a `relayed` prior is a defect: there the original push was ACKed, so a
      // note that turns out to be absent means the ACK was worthless. From `pending`
      // or `undelivered` no ACK was ever obtained, and an accepted push is simply
      // this sweep doing its job — reporting that at error level would cry wolf.
      const ackedYetAbsent = row.noteDelivery === 'relayed';
      const acceptedMessage = ackedYetAbsent
        ? '[noteDeliverySweep] re-push was ACCEPTED despite a prior ACK — the note was missing from the transport'
        : '[noteDeliverySweep] re-push was accepted — the note was not on the transport and now is';
      const logAccepted = ackedYetAbsent ? console.error : console.warn;
      logAccepted(acceptedMessage, {
        txId: row.id,
        noteId: target.noteId,
        attempts,
        priorState: row.noteDelivery
      });
    } catch (error) {
      if (isAlreadyStoredRejection(error)) {
        // The transport holds the body, so the original relay did reach it. That
        // rules out `undelivered` — but it is not delivery, so the row stays
        // `relayed` and remains sweepable for the nullifier check that can actually
        // confirm it. See the header comment for why this must not be `confirmed`.
        //
        // The matched error is logged because the classifier matches on message
        // text: when it misfires, this line is the only record of what it matched.
        outcome = 'relayed';
        console.info('[noteDeliverySweep] re-push rejected as duplicate — the transport holds this note', {
          txId: row.id,
          noteId: target.noteId,
          attempts,
          priorState: row.noteDelivery,
          error
        });
      } else {
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
    }

    await recordNoteDelivery(row.id, outcome);
    await Repo.transactions.where({ id: row.id }).modify(tx => {
      tx.relayAttempts = attempts;
      tx.nextRelayAt = at + backoffFor(attempts);
    });
  }
};
