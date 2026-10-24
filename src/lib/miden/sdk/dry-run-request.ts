import { TransactionRequest } from '@miden-sdk/miden-sdk/lazy';
import { executeForSummaryAtTip } from '@openzeppelin/miden-multisig-client';

import { prepareCustomRequestBytes } from 'lib/miden/sdk/custom-request';
import { assertWasmHoldCurrent, type WasmLockHold } from 'lib/miden/sdk/miden-client';
import type { MidenClientInterface } from 'lib/miden/sdk/miden-client-interface';
import { extractSdkErrorCode } from 'lib/miden/sdk/sdk-error-code';
import { u8ToB64 } from 'lib/shared/helpers';

/** What a dry run produced: the summary while authorization is pending, else the executed transaction. */
export interface DryRunResult {
  /** Base64 serialized TransactionSummary. */
  summaryBytes?: string;
  /** Base64 serialized TransactionResult, when the account was already fully authorized. */
  executedBytes?: string;
}

/**
 * True for the SDK's "this transaction executed successfully, so there is nothing
 * pending authorization to summarize" rejection.
 *
 * web-sdk 0.16 inverted `executeForSummary`'s contract: the summary now exists
 * ONLY while authorization is pending (a multisig below threshold), and a
 * transaction that executes successfully rejects with code
 * `TRANSACTION_ALREADY_AUTHORIZED`, which is every ORDINARY single-sig account.
 * 0.15 did the opposite ("If the transaction succeeds, constructs a summary from
 * the executed transaction"). The code is carried as an error property in the
 * browser and prefixed onto the message on Node, so both are matched.
 */
export function isAlreadyAuthorizedError(err: unknown): boolean {
  if (extractSdkErrorCode(err) === 'TRANSACTION_ALREADY_AUTHORIZED') return true;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.includes('TRANSACTION_ALREADY_AUTHORIZED') || message.includes('already fully authorized');
}

/**
 * True when `executeForSummaryAtTip` died because it had no signer for this account, rather than
 * because the request itself is bad.
 *
 * Matched narrowly because the SDK reports signing failures as kernel event errors
 * without a code. Other execution failures must not enter the local fallback.
 */
export function isSummarySigningUnavailable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.includes('failed to generate signature') || message.includes('Failed to get secret key');
}

/**
 * Missing fee-faucet context can use the same local execution fallback as a
 * missing signer; the wallet client already has the network's faucet.
 */
export function isSummaryFeeFaucetMissing(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  return message.includes('no fee faucet is known') || message.includes('pass `feeFaucetId`');
}

/**
 * Execute a transaction request locally for its effects, proving, submitting and persisting nothing.
 *
 * Unlike `simulateCustomTransaction` it imports no notes and runs no sync, so it executes against the client's last
 * synced state and suits a request that consumes nothing, such as the USDCx burn fee probe. The caller holds the WASM
 * lock and passes its hold, which is re-checked after every await before the next call on the client. Only the three
 * summary failures a local execution answers fall back to `executeRequest`; anything else, a trap included, is thrown
 * as it stands.
 */
export async function dryRunRequest(
  client: MidenClientInterface,
  accountIdHex: string,
  requestBytes: Uint8Array,
  hold: WasmLockHold
): Promise<DryRunResult> {
  assertWasmHoldCurrent(hold, 'before the dry run');
  const preparedBytes = await prepareCustomRequestBytes(client.client, accountIdHex, requestBytes, hold);
  assertWasmHoldCurrent(hold, 'after the dry run request preparation');
  const request = TransactionRequest.deserialize(preparedBytes);
  let summary: Awaited<ReturnType<typeof executeForSummaryAtTip>> | undefined;
  let summaryFailure: unknown;
  try {
    summary = await executeForSummaryAtTip(client.client, accountIdHex, request);
  } catch (e) {
    summaryFailure = e;
  }
  if (summary !== undefined) {
    assertWasmHoldCurrent(hold, 'before the dry run summary serialize');
    return { summaryBytes: u8ToB64(summary.serialize()) };
  }
  if (
    (typeof WebAssembly !== 'undefined' && summaryFailure instanceof WebAssembly.RuntimeError) ||
    (!isAlreadyAuthorizedError(summaryFailure) &&
      !isSummarySigningUnavailable(summaryFailure) &&
      !isSummaryFeeFaucetMissing(summaryFailure))
  ) {
    throw summaryFailure;
  }
  assertWasmHoldCurrent(hold, 'before the dry run local execution');
  // A fresh deserialization: `executeForSummaryAtTip` consumed the first handle (wasm-bindgen moves it).
  const executed = await client.client.transactions.executeRequest(
    accountIdHex,
    TransactionRequest.deserialize(preparedBytes)
  );
  assertWasmHoldCurrent(hold, 'before the dry run result serialize');
  return { executedBytes: u8ToB64(executed.result.serialize()) };
}
