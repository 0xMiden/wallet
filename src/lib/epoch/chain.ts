import { RpcClient } from '@miden-sdk/miden-sdk/lazy';

import { ensureSdkWasmReady, getRpcEndpoint } from 'lib/miden-chain/constants';

/**
 * Fetches the latest Miden chain head. Used to compute an absolute
 * P2IDE `midenReclaimHeight` (currentBlock + delta) before submitting a
 * Miden→EVM intent — a stale value makes the note reclaimable at creation
 * and the intent fails.
 */
export async function getCurrentMidenBlock(): Promise<number> {
  await ensureSdkWasmReady();
  const rpc = new RpcClient(getRpcEndpoint());
  const header = await rpc.getBlockHeaderByNumber(undefined);
  return Number(header.blockNum());
}

/** Minimum reclaim window required by the allocator (per Epoch docs). */
export const MIDEN_MIN_RECLAIM_BLOCKS = 1000;
