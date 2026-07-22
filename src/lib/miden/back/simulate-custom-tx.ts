import { executeForSummary } from '@openzeppelin/miden-multisig-client';
import { TransactionRequest } from '@miden-sdk/miden-sdk/lazy';

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

/**
 * Locally executes a custom transaction to derive its ground-truth
 * TransactionSummary WITHOUT proving or submitting — a dry run. Imports the
 * request's carried notes and syncs first so execution can resolve its inputs.
 * All WASM work runs inside a single `withWasmClientLock` scope (the client is
 * single-threaded). Never throws: failures are returned as `{ error }` so the
 * confirm UI can fall back to the declared view.
 */
export async function simulateCustomTransaction(input: SimulateCustomTxInput): Promise<SimulateCustomTxResult> {
  try {
    return await withWasmClientLock(async () => {
      const client = await getMidenClient();

      for (const noteB64 of input.importNotes ?? []) {
        await client.importNoteBytes(b64ToU8(noteB64));
      }
      await client.syncState();

      const accountId = accountIdStringToSdk(input.address);
      const request = TransactionRequest.deserialize(b64ToU8(input.transactionRequest));
      const summary = await executeForSummary(client.client, accountId, request);

      return { summaryBytes: u8ToB64(summary.serialize()) };
    });
  } catch (e: any) {
    return { error: e?.message ?? String(e) };
  }
}
