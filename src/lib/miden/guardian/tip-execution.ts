import type { MidenClient, TransactionRequest } from '@miden-sdk/miden-sdk/lazy';
import {
  BoundBlockNotDeclaredError,
  ChainBehindBoundBlockError,
  requestBoundBlockNum
} from '@openzeppelin/miden-multisig-client';

import { syncAndRecordFeeFaucet } from 'lib/miden/sdk/sync-and-record-fee-faucet';

/**
 * A hand-built proposal request with no multisig auth args binds no block, and the Guardian
 * refuses a proposal without one only after it was pushed.
 */
export class UnboundGuardianRequestError extends Error {
  constructor(accountId: string, requestKind: string) {
    super(`Guardian account ${accountId}: the ${requestKind} request carries no multisig auth args`);
    this.name = 'UnboundGuardianRequestError';
  }
}

/** The block a hand-built proposal request binds; read before its summary executes. */
export const requireRequestBoundBlockNum = (
  request: TransactionRequest,
  accountId: string,
  requestKind: string
): number => {
  const boundBlockNum = requestBoundBlockNum(request);
  if (boundBlockNum === undefined) throw new UnboundGuardianRequestError(accountId, requestKind);
  return boundBlockNum;
};

export const prepareGuardianTipExecution = async (
  client: Pick<MidenClient, 'syncChain' | 'getSyncHeight' | 'feeFaucetId'>,
  request: TransactionRequest,
  assertLive: () => void
): Promise<void> => {
  const boundBlockNum = requestBoundBlockNum(request);
  if (boundBlockNum !== undefined && !request.blockNumbers().includes(boundBlockNum)) {
    throw new BoundBlockNotDeclaredError(boundBlockNum);
  }

  // Foreign accounts load at the store's tip, which may itself have been pruned.
  await syncAndRecordFeeFaucet(client, () => client.syncChain(), assertLive);
  assertLive();
  if (boundBlockNum !== undefined) {
    const syncHeight = await client.getSyncHeight();
    assertLive();
    if (syncHeight < boundBlockNum) {
      throw new ChainBehindBoundBlockError({ syncHeight, boundBlockNum });
    }
  }
};
