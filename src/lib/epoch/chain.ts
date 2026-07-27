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

/**
 * Extra reclaim-window headroom on top of the allocator minimum.
 *
 * `midenReclaimHeight` is computed from the chain head read BEFORE the P2IDE note
 * is proved and submitted, but the allocator validates the intent against ITS
 * (later) chain head — by which point several blocks have elapsed. Without a
 * buffer the remaining window falls just under the minimum (e.g. 992 < 1000) and
 * the allocator rejects the solve ("P2IDE reclaim window too small"), so no funds
 * are ever delivered. This headroom covers the blocks that pass during note
 * creation/submission; it only lengthens the user's eventual reclaim window on a
 * failed intent, which is harmless.
 */
export const MIDEN_RECLAIM_BUFFER_BLOCKS = 200;
