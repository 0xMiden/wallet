import { TransactionRequest } from '@miden-sdk/miden-sdk/lazy';
import { executeForSummary } from '@openzeppelin/miden-multisig-client';

import { importedNoteIds, quarantineNoteIds } from 'lib/miden/note-quarantine';
import { accountIdStringToSdk } from 'lib/miden/sdk/helpers';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
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
async function idsNotAlreadyHeld(client: { getInputNote(id: string): Promise<unknown> }, ids: string[]) {
  const introduced: string[] = [];
  for (const id of ids) {
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
 * WASM lock until it completes — the timeout only bounds how long the UI
 * waits, not how long the lock is held. A fuller fix would decouple syncing
 * from the lock entirely; left as a follow-up.
 */
export async function simulateCustomTransaction(input: SimulateCustomTxInput): Promise<SimulateCustomTxResult> {
  const work: Promise<SimulateCustomTxResult> = (async () => {
    try {
      return await withWasmClientLock(async () => {
        const client = await getMidenClient();

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
        await quarantineNoteIds(await idsNotAlreadyHeld(client, importedNoteIds(input.importNotes)));

        for (const noteB64 of input.importNotes ?? []) {
          await client.importNoteBytes(b64ToU8(noteB64));
        }
        await client.syncState();

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
          // (multisig-client 0.16 / SDK 0.15.8); the raw-WasmWebClient overload is
          // the one that can omit it.
          const summary = await executeForSummary(client.client, accountIdHex, request, getEffectiveRpcUrl());
          return { summaryBytes: u8ToB64(summary.serialize()) };
        } catch (e) {
          if (!isAlreadyAuthorizedError(e)) throw e;
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
