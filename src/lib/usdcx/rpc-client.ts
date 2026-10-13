import { RpcClient } from '@miden-sdk/miden-sdk/lazy';

import { getRpcEndpoint } from 'lib/miden-chain/constants';

/**
 * Run one read on its own RpcClient and free the client once that read settles. Wrapped in `withRpcTimeout`, a
 * read the caller stopped waiting for may still be running, so the client is never freed under it.
 */
export function readWithOwnRpcClient<T>(read: (rpc: RpcClient) => Promise<T>): Promise<T> {
  const rpc = new RpcClient(getRpcEndpoint());
  let pending: Promise<T>;
  try {
    pending = read(rpc);
  } catch (error) {
    rpc.free();
    throw error;
  }
  void pending.then(
    () => rpc.free(),
    () => rpc.free()
  );
  return pending;
}
