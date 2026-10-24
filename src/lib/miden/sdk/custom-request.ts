import { MidenClient, TransactionRequest } from '@miden-sdk/miden-sdk/lazy';

import type { TransactionFailureDiagnostics } from 'lib/telemetry/transaction-failure';

import { customRequestAccountAuthCode, customRequestAuthDiagnostics } from './custom-request-diagnostics';
import { accountRefToSdk, feeAwareRequestBuilder, randomFeeSalt } from './helpers';
import { assertWasmHoldCurrent, type WasmLockHold } from './miden-client';
import { enrichOwnOutputRequest } from './own-output-request';

/** Resolve a dApp request's missing Guardian auth while holding the wallet's client lock. */
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
    if (request.authArg() !== undefined) {
      record('provided');
      return bytes;
    }
    record('unchanged');
    const builder = await feeAwareRequestBuilder(client, accountRefToSdk(account).toString(), randomFeeSalt());
    assertWasmHoldCurrent(hold, 'after the custom request fee-aware builder');
    const prepared = enrichOwnOutputRequest(request, builder, bytes);
    const preparedBytes = prepared === request ? bytes : prepared.serialize();
    diagnostics = { ...diagnostics, ...customRequestAuthDiagnostics(prepared) };
    record(prepared === request ? 'unchanged' : 'wallet_enriched');
    return preparedBytes;
  } catch (error) {
    record('failed');
    throw error;
  }
}
