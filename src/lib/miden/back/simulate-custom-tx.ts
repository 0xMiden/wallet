import { TransactionRequest } from '@miden-sdk/miden-sdk/lazy';
import { executeForSummary } from '@openzeppelin/miden-multisig-client';

import { importedNoteIds, quarantineNoteIds } from 'lib/miden/note-quarantine';
import { freeChainAnchor } from 'lib/miden/sdk/chain-anchor';
import { accountIdStringToSdk } from 'lib/miden/sdk/helpers';
import {
  assertWasmHoldCurrent,
  getMidenClient,
  withWasmClientLock,
  type WasmLockHold
} from 'lib/miden/sdk/miden-client';
import { extractSdkErrorCode } from 'lib/miden/sdk/sdk-error-code';
import { getEffectiveRpcUrl } from 'lib/miden-chain/effective-endpoints';
import { b64ToU8, u8ToB64 } from 'lib/shared/helpers';

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
}

/**
 * True for the SDK's "this transaction executed successfully, so there is nothing
 * pending authorization to summarize" rejection.
 *
 * web-sdk 0.16 inverted `executeForSummary`'s contract: the summary now exists
 * ONLY while authorization is pending (a multisig below threshold), and a
 * transaction that executes successfully rejects with code
 * `TRANSACTION_ALREADY_AUTHORIZED` — which is every ORDINARY single-sig account.
 * 0.15 did the opposite ("If the transaction succeeds, constructs a summary from
 * the executed transaction"). The code is carried as an error property in the
 * browser and prefixed onto the message on Node, so both are matched.
 */
function isAlreadyAuthorizedError(err: unknown): boolean {
  if (extractSdkErrorCode(err) === 'TRANSACTION_ALREADY_AUTHORIZED') return true;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.includes('TRANSACTION_ALREADY_AUTHORIZED') || message.includes('already fully authorized');
}

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
 * Locally executes a custom transaction to derive its ground truth WITHOUT
 * proving or submitting — a dry run. Imports the request's carried notes and
 * syncs first so execution can resolve its inputs.
 *
 * Returns `summaryBytes` (a TransactionSummary) when authorization is still
 * pending — a guardian/multisig account below its signing threshold — and
 * `executedBytes` (the TransactionResult) when the account is already fully
 * authorized, which is every ordinary single-sig account on the 0.16 line. Both
 * describe the same executed transaction; the confirm UI decodes whichever
 * arrives.
 * All WASM work runs inside a single `withWasmClientLock` scope (the client is
 * single-threaded). Never throws: failures are returned as `{ error }` so the
 * confirm UI can fall back to the declared view.
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

        // Quarantine BEFORE importing: these notes are about to land in the
        // real client DB purely so `executeForSummary` can resolve them for
        // the dry run — the user hasn't approved anything yet. Quarantining
        // first (rather than after the import loop) means a failure partway
        // through the loop still leaves every already-imported note hidden.
        //
        // Only the ids this dry run actually INTRODUCES are quarantined. The
        // ids come from fully dApp-controlled `importNotes` bytes and can name
        // a note the user already holds (one the dApp delivered earlier, or a
        // public note the wallet already discovered); a decline releases
        // nothing, so quarantining by id alone would let any dApp hide the
        // user's own claimable notes just by opening a confirm dialog they
        // then cancel. See lib/miden/note-quarantine.ts for the full lifecycle.
        await quarantineNoteIds(await idsNotAlreadyHeld(client, importedNoteIds(input.importNotes), hold));
        // The quarantine write is Dexie, not WASM — but it is still an await,
        // and the watchdog does not pause for it, so the check has to sit
        // between it and the next WASM call rather than before it (same
        // precedent as the sync-manager's quarantine read).
        assertWasmHoldCurrent(hold, 'after the quarantine write');

        for (const noteB64 of input.importNotes ?? []) {
          // Per-iteration, and the count is dApp-controlled — one guard before
          // the loop only covers the first import.
          assertWasmHoldCurrent(hold, 'before the note import');
          await client.importNoteBytes(b64ToU8(noteB64));
        }
        assertWasmHoldCurrent(hold, 'after the note imports');
        await client.syncState();
        // `accountIdStringToSdk` and `TransactionRequest.deserialize` below are
        // WASM calls too, not just the execution — and the sync is the await
        // most likely to outlive the watchdog.
        assertWasmHoldCurrent(hold, 'after the sync');

        // Fix C: executeForSummary wants a hex account-id string (it does
        // AccountId.fromHex). The custom-tx address is usually bech32, but
        // resolveAccountId elsewhere accepts hex too — pass hex through as-is.
        const accountIdHex =
          input.address.startsWith('0x') || input.address.startsWith('0X')
            ? input.address
            : accountIdStringToSdk(input.address).toString();
        const request = TransactionRequest.deserialize(b64ToU8(input.transactionRequest));
        try {
          // The high-level `MidenClient` overload needs the RPC endpoint explicitly
          // (multisig-client 0.17 / SDK 0.16); the raw-WasmWebClient overload is
          // the one that can omit it.
          //
          // The anchor this also returns is only useful to a party that has to
          // reproduce the summary later — a cosigner or executor. This dry run
          // displays the summary and discards it, so nothing here wants the
          // anchor on the wire. It still has to be RELEASED rather than merely
          // dropped: it owns a partial blockchain on the WASM heap, and the
          // summary branch is the GUARDIAN one, so every confirm dialog a
          // multisig account opens strands another one until the finalizer
          // happens to run (#784).
          const { summary, anchor } = await executeForSummary(
            client.client,
            accountIdHex,
            request,
            getEffectiveRpcUrl()
          );
          try {
            // Inside the try, so an abandoned dry run still releases the anchor
            // on its way out — the same placement the replace-hot-key proposal
            // uses. `summary.serialize()` is a borrow of the evicted client's
            // RefCell and must not run; `anchor.free()` is not, being a
            // wasm-bindgen deallocation of the anchor's own box rather than a
            // call through the client, and it is synchronous, so it cannot
            // interleave with the successor's work. Skipping it instead would
            // strand a partial blockchain on the WASM heap per abandoned confirm
            // dialog, which is what #784 added this release to stop.
            assertWasmHoldCurrent(hold, 'before the summary serialize');
            return { summaryBytes: u8ToB64(summary.serialize()) };
          } finally {
            freeChainAnchor(anchor);
          }
        } catch (e) {
          if (!isAlreadyAuthorizedError(e)) throw e;
          // The already-authorized rejection still ends the executeForSummary
          // parking await, so re-check before the fallback executes anything.
          // (A poison error never matches `isAlreadyAuthorizedError`, so an
          // eviction thrown by the guards above rethrows past this catch into
          // `{ error }` rather than being retried as a local execution.)
          assertWasmHoldCurrent(hold, 'before the local execution fallback');
          // Ordinary (non-guardian) account: nothing is pending authorization, so
          // there is no summary — but the dry run itself is still available and is
          // the same ground truth. `executeRequest` executes locally and submits,
          // proves and persists NOTHING (SDK: "does not submit it to the network
          // nor update the local database"), so it stays a dry run. Without this
          // the verified asset view — the anti-phishing control that shows what the
          // transaction really moves — was unreachable for every ordinary account
          // on the 0.16 line.
          //
          // A fresh deserialization: the first request handle was consumed by
          // `executeForSummary` (wasm-bindgen moves it).
          const executed = await client.client.transactions.executeRequest(
            accountIdHex,
            TransactionRequest.deserialize(b64ToU8(input.transactionRequest))
          );
          // `result.serialize()` borrows the same client — same rule as the
          // summary above. Still pre-submit: executeRequest broadcasts nothing.
          assertWasmHoldCurrent(hold, 'before the result serialize');
          return { executedBytes: u8ToB64(executed.result.serialize()) };
        }
      });
    } catch (e: any) {
      return { error: e?.message ?? String(e) };
    }
  })();

  const timeout: Promise<SimulateCustomTxResult> = new Promise(resolve =>
    setTimeout(() => resolve({ error: 'Simulation timed out' }), SIMULATION_TIMEOUT_MS)
  );

  return Promise.race([work, timeout]);
}
