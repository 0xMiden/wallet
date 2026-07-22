import { TransactionRequest } from '@miden-sdk/miden-sdk/lazy';
import { executeForSummary } from '@openzeppelin/miden-multisig-client';

import { accountIdStringToSdk } from 'lib/miden/sdk/helpers';
import { getMidenClient, withWasmClientLock } from 'lib/miden/sdk/miden-client';
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
  /** Human-oriented error message when the dry run could not be produced. */
  error?: string;
}

/** Upper bound on how long the confirm UI will wait for the dry run before giving up. */
const SIMULATION_TIMEOUT_MS = 20_000;

/**
 * Locally executes a custom transaction to derive its ground-truth
 * TransactionSummary WITHOUT proving or submitting — a dry run. Imports the
 * request's carried notes and syncs first so execution can resolve its inputs.
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
        const summary = await executeForSummary(client.client, accountIdHex, request);

        return { summaryBytes: u8ToB64(summary.serialize()) };
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
