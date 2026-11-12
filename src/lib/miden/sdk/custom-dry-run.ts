import { MidenClient, TransactionRequest } from '@miden-sdk/miden-sdk/lazy';
import { executeForSummaryAtTip } from '@openzeppelin/miden-multisig-client';

import {
  isAlreadyAuthorizedError,
  isSummaryFeeFaucetMissing,
  isSummarySigningUnavailable
} from 'lib/miden/sdk/dry-run-request';
import { assertWasmHoldCurrent, type WasmLockHold } from 'lib/miden/sdk/miden-client';
import { u8ToB64 } from 'lib/shared/helpers';

/**
 * The result of one dry run of a prepared custom request. It has exactly one of the two fields.
 *
 * `summaryBytes` is a serialized TransactionSummary: the account has not authorized the request yet (a Guardian account
 * below its signing threshold). `executedBytes` is a serialized TransactionResult: the account was already fully
 * authorized, so execution gave no summary. Both describe the same executed transaction.
 */
export type CustomDryRunBytes =
  | { summaryBytes: string; executedBytes?: undefined }
  | {
      executedBytes: string;
      summaryBytes?: undefined;
    };

/**
 * Executes a prepared custom request locally and does not prove, submit or persist it.
 *
 * The approval dry run (`simulateCustomTransaction`) and the generation check of an `execute` row both call this
 * function, so the two dry runs execute the same way and give results that decode identically.
 *
 * The caller holds the WASM client lock and gives its hold. The caller checks the hold before this call; this function
 * checks it after each await, before the next client call.
 */
export async function dryRunPreparedCustomRequest(
  client: MidenClient,
  accountIdHex: string,
  preparedBytes: Uint8Array,
  hold: WasmLockHold
): Promise<CustomDryRunBytes> {
  const request = TransactionRequest.deserialize(preparedBytes);
  // ONLY the summary execution is caught here. A guard's own throw must never reach the
  // fallback below: `assertWasmHoldCurrent` fires when the mutex is already a successor's,
  // and retrying under it is the double borrow every guard in this callback exists to stop.
  let summary: Awaited<ReturnType<typeof executeForSummaryAtTip>> | undefined;
  let summaryFailure: unknown;
  try {
    // The summary binds the block the request's auth args name, which the dApp's own client
    // chose and a sync can move this one past, so it executes at the tip like every
    // other execution of a Guardian proposal.
    summary = await executeForSummaryAtTip(client, accountIdHex, request);
  } catch (e) {
    summaryFailure = e;
  }

  if (summary !== undefined) {
    // `summary.serialize()` borrows the client, so an evicted hold must not reach it.
    assertWasmHoldCurrent(hold, 'before the summary serialize');
    return { summaryBytes: u8ToB64(summary.serialize()) };
  }

  // Only three summary failures are retryable locally: the account was already fully
  // authorized, the summary client could not sign for it, or the summary client has no fee faucet. Anything else - a
  // genuine execution failure, an eviction, an abort - is reported as it stands, because retrying it
  // would either mask the real error or borrow a client a successor already owns.
  if (
    !isAlreadyAuthorizedError(summaryFailure) &&
    !isSummarySigningUnavailable(summaryFailure) &&
    !isSummaryFeeFaucetMissing(summaryFailure)
  ) {
    throw summaryFailure;
  }
  if (isSummarySigningUnavailable(summaryFailure) || isSummaryFeeFaucetMissing(summaryFailure)) {
    console.warn('[simulate-custom-tx] the summary client cannot execute; falling back to local execution');
  }
  // The rejection still ends the executeForSummaryAtTip parking await, so re-check before the
  // fallback executes anything.
  assertWasmHoldCurrent(hold, 'before the local execution fallback');
  // Ordinary (non-guardian) account: nothing is pending authorization, so
  // there is no summary — but the dry run itself is still available and is
  // the same ground truth. `executeRequest` executes locally and submits,
  // proves and persists NOTHING (SDK: "does not submit it to the network
  // nor update the local database"), so it stays a dry run.
  //
  // A fresh deserialization: the first request handle was consumed by
  // `executeForSummaryAtTip` (wasm-bindgen moves it).
  const executed = await client.transactions.executeRequest(
    accountIdHex,
    TransactionRequest.deserialize(preparedBytes)
  );
  // `result.serialize()` borrows the same client — same rule as the
  // summary above. Still pre-submit: executeRequest broadcasts nothing.
  assertWasmHoldCurrent(hold, 'before the result serialize');
  return { executedBytes: u8ToB64(executed.result.serialize()) };
}
