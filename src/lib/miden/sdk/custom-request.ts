import { MidenClient, TransactionRequest } from '@miden-sdk/miden-sdk/lazy';

import type { TransactionFailureDiagnostics } from 'lib/telemetry/transaction-failure';

import { customRequestAccountAuthCode, customRequestAuthDiagnostics } from './custom-request-diagnostics';
import { accountRefToSdk, randomFeeSalt } from './helpers';
import { assertWasmHoldCurrent, type WasmLockHold } from './miden-client';

/**
 * Resolve a dApp request's missing Guardian auth while holding the wallet's client lock.
 *
 * The SDK adds the auth inputs to the request that the dApp sent and keeps all its other fields, so a request of
 * any shape (input notes, a custom script) gets auth. The dry run on the approval screen executes these prepared
 * bytes, so the user sees the request that runs.
 */
export async function prepareCustomRequestBytes(
  client: MidenClient,
  account: string,
  bytes: Uint8Array,
  hold: WasmLockHold,
  observe?: (diagnostics: TransactionFailureDiagnostics) => void
): Promise<Uint8Array> {
  let diagnostics: TransactionFailureDiagnostics = {
    authPreparation: 'unavailable',
    authLayout: 'unavailable',
    commitmentMatch: 'unavailable',
    ...(observe ? { accountAuthCode: 'unavailable' as const } : {})
  };
  const record = (authPreparation: TransactionFailureDiagnostics['authPreparation']) => {
    diagnostics = { ...diagnostics, authPreparation };
    try {
      observe?.(diagnostics);
    } catch {
      // Diagnostics must not affect execution or replace its original error.
    }
  };
  try {
    assertWasmHoldCurrent(hold, 'before custom request preparation');
    const request = TransactionRequest.deserialize(bytes);
    diagnostics = { ...diagnostics, ...customRequestAuthDiagnostics(request) };
    if (observe) {
      try {
        diagnostics.accountAuthCode = await customRequestAccountAuthCode(client, accountRefToSdk(account).toString());
      } catch {
        diagnostics.accountAuthCode = 'unavailable';
      }
      assertWasmHoldCurrent(hold, 'after custom request diagnostics');
    }
    // The dApp owns an auth argument that it supplies. The wallet does not replace it.
    if (request.authArg() !== undefined) {
      record('provided');
      return bytes;
    }
    record('unchanged');
    // For a Guardian (multisig) account the SDK adds the auth argument, its advice preimage and the bound block. It
    // replaces a fee conversion salt that the dApp declared. For other accounts it returns the request unchanged.
    const prepared = await client.withFeeAwareAuth(request, accountRefToSdk(account).toString(), {
      feeConversionSalt: randomFeeSalt()
    });
    assertWasmHoldCurrent(hold, 'after the custom request fee-aware auth');
    if (prepared.authArg() === undefined) {
      record('unchanged');
      return bytes;
    }
    const preparedBytes = prepared.serialize();
    diagnostics = { ...diagnostics, ...customRequestAuthDiagnostics(prepared) };
    record('wallet_enriched');
    return preparedBytes;
  } catch (error) {
    record('failed');
    throw error;
  }
}
