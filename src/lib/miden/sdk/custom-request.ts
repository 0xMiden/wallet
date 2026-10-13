import { MidenClient, TransactionRequest } from '@miden-sdk/miden-sdk/lazy';

import { accountRefToSdk, feeAwareRequestBuilder, randomFeeSalt } from './helpers';
import { assertWasmHoldCurrent, type WasmLockHold } from './miden-client';
import { enrichOwnOutputRequest } from './own-output-request';

/** Resolve a dApp request's missing Guardian auth while holding the wallet's client lock. */
export async function prepareCustomRequestBytes(
  client: MidenClient,
  account: string,
  bytes: Uint8Array,
  hold: WasmLockHold
): Promise<Uint8Array> {
  assertWasmHoldCurrent(hold, 'before custom request preparation');
  const request = TransactionRequest.deserialize(bytes);
  if (request.authArg() !== undefined) return bytes;
  const builder = await feeAwareRequestBuilder(client, accountRefToSdk(account).toString(), randomFeeSalt());
  assertWasmHoldCurrent(hold, 'after the custom request fee-aware builder');
  const prepared = enrichOwnOutputRequest(request, builder, bytes);
  return prepared === request ? bytes : prepared.serialize();
}
