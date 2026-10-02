import type { MidenClient, TransactionRequest } from '@miden-sdk/miden-sdk/lazy';
import {
  BoundBlockNotDeclaredError,
  ChainBehindBoundBlockError,
  requestBoundBlockNum
} from '@openzeppelin/miden-multisig-client';

export const prepareGuardianTipExecution = async (
  client: Pick<MidenClient, 'syncChain' | 'getSyncHeight'>,
  request: TransactionRequest,
  assertLive: () => void
): Promise<void> => {
  const boundBlockNum = requestBoundBlockNum(request);
  if (boundBlockNum !== undefined && !request.blockNumbers().includes(boundBlockNum)) {
    throw new BoundBlockNotDeclaredError(boundBlockNum);
  }

  // Foreign accounts load at the store's tip, which may itself have been pruned.
  await client.syncChain();
  assertLive();
  if (boundBlockNum !== undefined) {
    const syncHeight = await client.getSyncHeight();
    assertLive();
    if (syncHeight < boundBlockNum) {
      throw new ChainBehindBoundBlockError({ syncHeight, boundBlockNum });
    }
  }
};
