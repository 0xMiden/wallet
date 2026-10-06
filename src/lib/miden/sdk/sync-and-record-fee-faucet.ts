import { cacheScope, captureNativeAssetSnapshot, recordSyncedFeeFaucetId } from 'lib/miden-chain/native-asset';

import { assertWasmHoldCurrent, getCurrentWasmLockHold } from './miden-client';

type FeeIdentityClient = { feeFaucetId(): Promise<{ toString(): string }> };
const clientScopes = new WeakMap<object, string>();

/** The scope is captured before construction awaits, never inferred from a later sync. */
export function bindFeeFaucetClientScope(client: object, scope = cacheScope()): void {
  if (!clientScopes.has(client)) clientScopes.set(client, scope);
}

export async function syncAndRecordFeeFaucet<T>(
  client: FeeIdentityClient,
  sync: () => Promise<T>,
  assertLive: () => void = () => {}
): Promise<T> {
  const scope = clientScopes.get(client);
  if (scope === undefined) throw new Error('sync client has no construction scope');
  const snapshot = captureNativeAssetSnapshot(scope);
  const hold = getCurrentWasmLockHold();
  const check = () => {
    if (hold) assertWasmHoldCurrent(hold, 'publishing synchronized fee faucet');
    assertLive();
  };
  check();
  const summary = await sync();
  check();
  const faucet = await client.feeFaucetId();
  check();
  const id = faucet.toString();
  await recordSyncedFeeFaucetId(id, snapshot, check);
  check();
  return summary;
}
