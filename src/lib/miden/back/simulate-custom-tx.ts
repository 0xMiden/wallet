import { simulatedBytesToView } from 'app/confirm/decode';
import {
  abandonQuarantineAttempt,
  beginQuarantineAttempt,
  importedNoteIds,
  type NoteDecodeOptions,
  quarantineNoteIds
} from 'lib/miden/note-quarantine';
import { dryRunPreparedCustomRequest } from 'lib/miden/sdk/custom-dry-run';
import { prepareCustomRequestBytes } from 'lib/miden/sdk/custom-request';
import { accountRefToSdk } from 'lib/miden/sdk/helpers';
import {
  assertWasmHoldCurrent,
  getMidenClient,
  withWasmClientLock,
  type WasmLockHold
} from 'lib/miden/sdk/miden-client';
import { isPipelineKillLink } from 'lib/miden/sdk/sdk-error-code';
import { b64ToU8 } from 'lib/shared/helpers';

import { CustomSimulationTimeoutError } from './public-error';

export interface SimulateCustomTxInput {
  /** Bech32 sending account address (the custom-tx `address` field). */
  address: string;
  /** Base64 serialized Miden-SDK TransactionRequest. */
  transactionRequest: string;
  /** Base64 serialized notes the request consumes (imported locally to simulate). */
  importNotes?: string[];
}

export interface SimulateCustomTxResult {
  /** Base64 serialized TransactionSummary when the dry run succeeded. */
  summaryBytes?: string;
  /**
   * Base64 serialized TransactionResult when the account was already fully
   * authorized, so execution produced no summary (see `simulateCustomTransaction`).
   * Carries the same ground truth — it IS the executed transaction.
   */
  executedBytes?: string;
  /** Human-oriented error message when the dry run could not be produced. */
  error?: string;
  /**
   * Notes this request brought in, lowercased: carried notes the synced wallet did not already hold, and notes
   * embedded in the request that the store does not hold. Set on both successful results. The approval credits only
   * these consumed notes, so every other one is value the account spends.
   */
  introducedNoteIds?: string[];
}

// Every decode of the dApp's note bytes runs inside the dry run's hold, so a trap is rethrown for the lock to retire
// the client rather than skipped like bytes that do not parse.
const IN_HOLD: NoteDecodeOptions = { rethrowTraps: true };

/** Upper bound on how long the confirm UI will wait for the dry run before giving up. */
const SIMULATION_TIMEOUT_MS = 20_000;

/**
 * The subset of `ids` the client does NOT already have an input-note record
 * for — i.e. the notes this dry run is about to INTRODUCE, and the only ones
 * it may hide from the claimable UI.
 *
 * A lookup failure resolves the id as already-held (not quarantined): leaving
 * a dry-run-imported note visible is a cosmetic surprise, while hiding a note
 * the user already owned removes their only view of their own funds. When the
 * lookup is broken for every id the quarantine simply degrades to a no-op.
 *
 * The caller syncs first: a note on chain that the client has not synced has no
 * record yet and would read as introduced.
 */
async function idsNotAlreadyHeld(
  client: { getInputNote(id: string): Promise<unknown> },
  ids: string[],
  /**
   * The caller's lock hold. REQUIRED rather than optional: the loop below is one
   * WASM round trip per dApp-supplied id, and an optional guard is one a future
   * caller disables by forgetting it.
   */
  hold: WasmLockHold
) {
  const introduced: string[] = [];
  for (const id of ids) {
    // Per-iteration: an eviction during any lookup hands the mutex to a
    // successor without stopping this loop, and the next lookup would borrow a
    // client somebody else is inside. The check sits OUTSIDE the try below —
    // inside it, the poison would be swallowed as "already held" and the loop
    // would carry on.
    assertWasmHoldCurrent(hold, 'before the provenance lookup');
    try {
      if (!(await client.getInputNote(id))) introduced.push(id);
    } catch {
      // Treated as already held — see above.
    }
  }
  return introduced;
}

/**
 * Ids of the notes a dry run consumed. `{ error }` when that list cannot be read. A `WebAssembly.RuntimeError` is
 * rethrown so the lock retires the client. `TransactionRequest` has no input-note accessor, so a note embedded in
 * the request shows up only here.
 */
function consumedNoteIds(dryRun: {
  summaryBytes?: string;
  executedBytes?: string;
}): { ids: string[] } | { error: string } {
  try {
    const notes = simulatedBytesToView(dryRun)?.viewConsumedNotes;
    if (!notes) return { error: 'the view does not list the notes it consumes' };
    return { ids: notes.map(note => note.id) };
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) throw error;
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Locally executes a custom transaction to derive its ground truth WITHOUT
 * proving or submitting: a dry run. Syncs, judges against the synced client
 * which carried notes the request introduced, imports those, and syncs again
 * after an import so execution can resolve its inputs. The dry run writes
 * nothing; notes the request embedded are judged after it returns.
 *
 * Returns `summaryBytes` (a TransactionSummary) when authorization is still
 * pending — a guardian/multisig account below its signing threshold — and
 * `executedBytes` (the TransactionResult) when the account is already fully
 * authorized, which is every ordinary single-sig account on the 0.16 line. Both
 * describe the same executed transaction; the confirm UI decodes whichever
 * arrives.
 * All WASM work runs inside a single `withWasmClientLock` scope (the client is
 * single-threaded). Never throws: failures are returned as `{ error }`. The dApp
 * approval refuses a request whose dry run gives `{ error }`, before any prompt
 * (see `generatePromisifyTransaction` in `dapp.ts`).
 *
 * The whole locked operation races against `SIMULATION_TIMEOUT_MS` so a slow
 * import/sync/execute can never hang the confirm screen's "verifying…" state
 * forever. The race is done OUTSIDE `withWasmClientLock` — racing inside it
 * would let a subsequent lock holder start while this abandoned WASM work is
 * still executing, risking the recursive-use/unsafe-aliasing crash the
 * `withWasmClientLock` guardian code warns about. The locked work itself never
 * rejects (it stays wrapped in try/catch -> `{ error }`), so when the timeout
 * wins there is no unhandled rejection; the lock is simply released whenever
 * the abandoned work eventually finishes.
 *
 * Residual limitation: a slow `syncState` (or import/execute) still holds the
 * WASM lock until it completes or the #775 watchdog evicts it — the timeout
 * only bounds how long the UI waits, not how long the lock is held. What an
 * eviction no longer leaves behind is a live hazard: the callback re-checks
 * its hold at every transition below, so the abandoned dry run stops at its
 * next WASM call instead of running to completion inside a client a successor
 * now owns. A fuller fix would decouple syncing from the lock entirely; left
 * as a follow-up.
 */
export async function simulateCustomTransaction(input: SimulateCustomTxInput): Promise<SimulateCustomTxResult> {
  const attempt = beginQuarantineAttempt();
  const work: Promise<SimulateCustomTxResult> = (async () => {
    try {
      return await withWasmClientLock(async hold => {
        const client = await getMidenClient();
        // The client build is a parking await (on a cold start it is the long
        // one); an eviction during it hands the mutex to a successor without
        // stopping this callback, so every WASM call below would be a second
        // borrow of a client somebody else is inside. This is a dry run —
        // nothing here ever submits — so every transition through the end of
        // the callback is guardable, and the hold is re-checked at each one.
        assertWasmHoldCurrent(hold, 'after the client build');

        // The held-note check below reads the client's input-note records, so it runs on a synced client. A public
        // note addressed to the account that is on chain but not synced yet has no record, and before this sync it
        // read as introduced: the approval credited its value as brought in by the request, so a request could
        // consume the user's own note and send its value away with nothing shown leaving. The ids are decoded
        // first, so bytes that trap fail before any node round trip.
        const carriedIds = importedNoteIds(input.importNotes, IN_HOLD);
        await client.syncState();
        assertWasmHoldCurrent(hold, 'after the provenance sync');

        // Quarantine BEFORE importing: these notes are about to land in the
        // real client DB purely so `executeForSummaryAtTip` can resolve them for
        // the dry run — the user hasn't approved anything yet. Quarantining
        // first (rather than after the import loop) means a failure partway
        // through the loop still leaves every already-imported note hidden.
        //
        // Only the ids this dry run actually INTRODUCES are quarantined. The
        // ids come from fully dApp-controlled `importNotes` bytes and can name
        // a note the user already holds (one the dApp delivered earlier, or a
        // public note the wallet discovered, by the sync above at the latest);
        // a decline releases nothing, so quarantining by id alone would let any
        // dApp hide the user's own claimable notes just by opening a confirm
        // dialog they then cancel. See lib/miden/note-quarantine.ts for the full lifecycle.
        const introducedIds = await idsNotAlreadyHeld(client, carriedIds, hold);
        // The same provenance check decides which consumed notes the approval credits as brought in.
        // Notes the wallet already held are the user's own, and crediting them let a dApp consume a
        // pending 1000 and send 1050 for a charge of 50. Only this check knows which ids were already
        // held, and its verdict never comes from the request, so a request cannot claim membership.
        await quarantineNoteIds(introducedIds, attempt);
        // The quarantine write is Dexie, not WASM — but it is still an await,
        // and the watchdog does not pause for it, so the check has to sit
        // between it and the next WASM call rather than before it (same
        // precedent as the sync-manager's quarantine read).
        assertWasmHoldCurrent(hold, 'after the quarantine write');

        // Import a carried note only when its decoded id is one this dry run introduced.
        // Re-importing a note the wallet already holds fails with "import produced no note
        // commitment" before any approval prompt. An id whose lookup failed closed is absent
        // from that set and is not imported. A carried note whose id does not decode was never
        // classified and is still imported.
        const introduced = new Set(introducedIds);
        let imported = false;
        for (const noteB64 of input.importNotes ?? []) {
          // Per-iteration, and the count is dApp-controlled — one guard before
          // the loop only covers the first import.
          assertWasmHoldCurrent(hold, 'before the note import');
          const [id] = importedNoteIds([noteB64], IN_HOLD);
          if (id !== undefined && !introduced.has(id)) continue;
          await client.importNoteBytes(b64ToU8(noteB64), hold);
          imported = true;
        }
        assertWasmHoldCurrent(hold, 'after the note imports');
        // An import commits a note only up to the client's sync height. One committed after the sync above (a note
        // the dApp created moments before asking) is stored as expected or unverified until a later sync, and the
        // dry run could not consume it. With nothing imported the sync above already serves the execution.
        if (imported) {
          await client.syncState();
          // `accountRefToSdk` and `TransactionRequest.deserialize` below are
          // WASM calls too, not just the execution, and the sync is the await
          // most likely to outlive the watchdog.
          assertWasmHoldCurrent(hold, 'after the post-import sync');
        }

        // The dApp address is parsed by the wallet's canonical account-reference parser, which reduces
        // a composite `<address>_<suffix>` to its address and accepts either hex prefix case, and is
        // passed on as the canonical hex id that `preview` and `executeRequest` below both resolve.
        const accountIdHex = accountRefToSdk(input.address).toString();
        const preparedBytes = await prepareCustomRequestBytes(
          client.client,
          accountIdHex,
          b64ToU8(input.transactionRequest),
          hold
        );
        assertWasmHoldCurrent(hold, 'after custom request preparation');
        // The same dry run that the generation check of the queued row executes, so the two decode identically.
        // It applies nothing: an input note embedded in the request is still absent from the store, and
        // `TransactionRequest` has no accessor for it. After the hold check, judge every consumed id the carried
        // set does not already name (case-insensitively). One the store does not hold was brought in; one it holds
        // is the user's own. A carried id is not looked up again (the import above would make it look held), and
        // an embedded id is not imported or quarantined, because it was never written to the store.
        const dryRun = await dryRunPreparedCustomRequest(client.client, accountIdHex, preparedBytes, hold);
        assertWasmHoldCurrent(hold, 'after the dry run');
        const consumed = consumedNoteIds(dryRun);
        if ('error' in consumed) return consumed;
        const carried = new Set(carriedIds.map(id => id.toLowerCase()));
        const embeddedIds = consumed.ids.filter(id => !carried.has(id.toLowerCase()));
        const embeddedIntroduced = await idsNotAlreadyHeld(client, embeddedIds, hold);
        return {
          ...dryRun,
          introducedNoteIds: [...introducedIds, ...embeddedIntroduced].map(id => id.toLowerCase())
        };
      });
    } catch (e: any) {
      // An abandonment is reported as an interruption, not as its internal
      // message. This `error` is not a log line: the dApp consent sheet
      // interpolates it onto a line the signer reads, and "WASM client poisoned
      // (watchdog): held the WASM client lock past its watchdog ceiling" is
      // wallet-internal text that says nothing a signer can act on. Both callers
      // also only ever test this field for presence. The real error keeps its
      // identity on the console via the recovery log.
      if (isPipelineKillLink(e)) {
        // Settle before returning so an in-flight quarantine write cannot land after the caller releases.
        await abandonQuarantineAttempt(attempt);
        throw e;
      }
      return { error: e?.message ?? String(e) };
    }
  })();

  // The same object the race returns, so a slow dry run that later fails with the same text is not
  // this timeout. The text itself stays "Simulation timed out".
  const timedOut: SimulateCustomTxResult = { error: 'Simulation timed out' };
  const timeout: Promise<SimulateCustomTxResult> = new Promise(resolve =>
    setTimeout(() => resolve(timedOut), SIMULATION_TIMEOUT_MS)
  );

  const result = await Promise.race([work, timeout]);
  // The timeout does not cancel the locked work. Abandon the attempt and let a quarantine write
  // already in the queue finish before rejecting, or the lookup still in flight quarantines the
  // ids again after the caller releases them.
  if (result === timedOut) {
    await abandonQuarantineAttempt(attempt);
    throw new CustomSimulationTimeoutError();
  }
  return result;
}
