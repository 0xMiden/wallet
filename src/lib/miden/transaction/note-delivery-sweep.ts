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
 * The transport's `notes` table declares `id BLOB NOT NULL UNIQUE` alongside its
 * `seq` primary key (note-transport-service, migration
 * `20260422000000_add_seq_cursor`), and `store_note` is a bare
 * `diesel::insert_into` with no `ON CONFLICT` clause, so re-pushing a note it
 * already holds fails on that unique index. Its gRPC layer currently surfaces the
 * failure as `Internal` carrying the SQLite text rather than as `AlreadyExists`, so
 * matching on the message is the only option until the service returns a
 * distinguishable code (tracked upstream).
 *
 * Matching is deliberately narrow. The generic spellings — a bare
 * `ConstraintViolation`, or "already exists" on its own — appear in unrelated
 * failures on this path: tonic's stock `AlreadyExists` blurb, Dexie/IndexedDB
 * `ConstraintError`, and the SDK's own account-tree and asset-vault errors. Since a
 * match suppresses the delivery warning, an over-broad pattern would hide exactly
 * the failure this sweep exists to surface, so a text match must name BOTH the note
 * key and the uniqueness of the violation, and a status-code match must be a real
 * `AlreadyExists`. Naming the key alone is not enough: the service funnels every
 * constraint kind through one `ConstraintViolation` variant, so a NOT NULL or
 * foreign-key failure on the same column reads almost identically while meaning the
 * opposite — nothing was stored.
 */
const isAlreadyStoredRejection = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return (
    // The uniqueness collision on `notes.id`, in either spelling this path produces:
    // SQLite's own `UNIQUE constraint failed: notes.id` (which is what the deployed
    // service passes through today) and diesel's `Unique constraint violation`.
    // `[^.]` rather than a length bound: it stops the match from stepping over a
    // DIFFERENT dotted column on its way to this one, which a message naming several
    // tables would otherwise satisfy.
    /\bunique constraint (?:failed|violation)\b[^.]{0,40}\bnotes\.id\b/i.test(message) ||
    // A service that starts returning a proper gRPC status keeps working unchanged.
    // Tonic spells it two ways — `status: AlreadyExists` (Display) and `Status {
    // code: AlreadyExists` (Debug) — and a gRPC-web trailer carries the numeric 6.
    // The numeric form has to be paired with the message, because a bare `6` also
    // appears in header dumps and quoted earlier responses whose real status is
    // something else entirely.
    /\b(?:status|code):\s*AlreadyExists\b/i.test(message) ||
    /\b(?:grpc-status|code):\s*6\b.*\balready exists\b/i.test(message)
  );
};

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
 * sends happened.
 */
const candidateRows = async (at: number): Promise<ITransaction[]> => {
  const rows = await Repo.transactions.where('noteDelivery').anyOf(SWEEPABLE).toArray();
  return rows
    .filter(row => attemptsOf(row) < MAX_RELAY_ATTEMPTS)
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
 * What a re-push can and cannot fix — worth stating precisely, because there are TWO
 * silent losses here and this instrument only reaches one of them.
 *
 * The one it repairs: a note that was accepted and never stored. `SendNoteResponse`
 * is an empty message — no `seq`, no id, nothing to check — so a 200 is not evidence
 * of storage. The 2026-08-24 stress run lost 14 notes (53 TST) that were committed on
 * chain and reported as sent while absent from the service, with no error anywhere for
 * the wallet to react to. Which hop dropped them was never established, because
 * nothing recorded that hop (which is why `playwright/e2e/harness/transport-wire.ts`
 * now exists); an accepted push that was never persisted is one of the candidates. A
 * re-push closes it in one step: a note the transport does not hold is accepted and
 * stored at a fresh `seq`, above every recipient cursor.
 *
 * The one it does NOT repair: a note that IS stored but sits below the recipient's
 * cursor. The transport hands out an opaque pagination cursor that the recipient
 * persists verbatim, and once it advances past a stored note — note-transport-
 * service#77, via timestamp collisions and a per-tag query interleave — that note is
 * unreachable for that recipient permanently. A re-push cannot lift it, because the
 * `notes` table declares `id BLOB NOT NULL UNIQUE` (migration
 * `20260422000000_add_seq_cursor`, the same change that introduced `seq`) and
 * `store_note` is a bare insert with no `ON CONFLICT`: a note the transport already
 * holds is REJECTED, not re-stored at a new position. Verified against the deployed
 * service — the second `SendNote` of an identical note answers `Internal — Failed to
 * store note: ConstraintViolation("UNIQUE ...")`, and nothing appears above the
 * previous cursor.
 *
 * From the sender the two are indistinguishable up front, which is why the sweep
 * pushes at all: the push itself is the test.
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
 * Promoting a rejection to `confirmed` would therefore retire exactly the rows
 * exhibiting #77, drop their remaining attempts, and — since `confirmed` renders as
 * "the recipient has received and spent this private note" — claim a note the
 * recipient may never see was spent. `confirmed` stays exclusive to the nullifier.
 * What the rejection IS good for is not raising a false alarm: the original relay
 * demonstrably reached the transport, so the row must not be downgraded to
 * `undelivered` either.
 *
 * Either way the recipient's next fetch is no worse off, and the hint is re-derived
 * from the note's stored `expected_height` on every call, so a late re-push is as
 * correct as the first one.
 *
 * Failures are swallowed per row on purpose: this runs as maintenance behind
 * transactions that have already landed, so one row's transport error must not stop
 * the rest of the sweep or surface as a transaction failure. The attempt is still
 * counted, and only a row that never held an ACK records `undelivered` — one that
 * did, or whose push was rejected as a duplicate, keeps reading `relayed`.
 */
export const sweepNoteDeliveries = async (): Promise<void> => {
  // Eligibility is judged against one snapshot so a single pass is internally
  // consistent. Schedules, though, are stamped from the clock at WRITE time: each
  // row's relay carries a 45-second deadline, so a sweep with a few slow rows can
  // outlive a backoff step, and a `nextRelayAt` derived from the sweep's start would
  // then land in the past — re-pushing on the very next cycle and collapsing exactly
  // the spread these delays exist to create.
  const at = nowSeconds();
  const rows = await candidateRows(at);

  for (const row of rows) {
    const target = relayTargetOf(row);
    if (!target) {
      // Nothing to re-push with. Leave the row alone rather than counting an
      // attempt that cannot happen — the existing state already says delivery was
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
      // — the wallet was closed, or this is the first sync since — has already served
      // the wait, and arming another one from now would push its only attempts toward
      // the far end of `RELAY_WINDOW_SECONDS`, or past it.
      //
      // `completedAt` is the anchor, NOT `initiatedAt`: the latter is stamped when the
      // transaction was queued, so on a slow send (FIFO wait plus prove plus submit)
      // it can precede the relay by more than the whole delay — which would arm the
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
        attempts: attemptsOf(row) + 1,
        priorState: row.noteDelivery,
        error
      });
    }

    const attempts = attemptsOf(row) + 1;
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
        // `relayed`. See the header comment for why this must not be `confirmed`.
        //
        // The attempt is still counted, which does mean a note that stays stored and
        // unconsumed retires after `MAX_RELAY_ATTEMPTS` like any other. That is the
        // conservative choice: further pushes of a note the transport already holds
        // are rejected too, so they would buy nothing but traffic. The cost is that
        // the nullifier check at the top of this loop gets only the remaining
        // attempts, not an open-ended watch.
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
      tx.nextRelayAt = nowSeconds() + backoffFor(attempts);
    });

    if (attempts >= MAX_RELAY_ATTEMPTS) {
      // Last attempt: the row drops out of the candidate set after this, so nothing
      // looks at it again — not even the nullifier check that could still have retired
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
