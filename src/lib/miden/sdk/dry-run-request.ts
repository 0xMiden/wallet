import { dryRunPreparedCustomRequest } from 'lib/miden/sdk/custom-dry-run';
import { prepareCustomRequestBytes } from 'lib/miden/sdk/custom-request';
import { assertWasmHoldCurrent, type WasmLockHold } from 'lib/miden/sdk/miden-client';
import type { MidenClientInterface } from 'lib/miden/sdk/miden-client-interface';

/** What a dry run produced: the summary while authorization is pending, else the executed transaction. */
export interface DryRunResult {
  /** Base64 serialized TransactionSummary. */
  summaryBytes?: string;
  /** Base64 serialized TransactionResult, when the account was already fully authorized. */
  executedBytes?: string;
}

/**
 * Execute a transaction request locally for its effects, proving, submitting and persisting nothing.
 *
 * Unlike `simulateCustomTransaction` it imports no notes and runs no sync, so it executes against the client's last
 * synced state and suits a request that consumes nothing, such as the USDCx burn fee probe. The caller holds the WASM
 * lock and passes its hold, which is re-checked after every await before the next call on the client. It prepares the
 * request bytes, then runs `dryRunPreparedCustomRequest`, whose summary-fallback ladder is the only one: a trap is
 * thrown as itself, a killed pipeline as its kill link, and anything but the three summary failures as it stands.
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
  return dryRunPreparedCustomRequest(client.client, accountIdHex, preparedBytes, hold);
}
