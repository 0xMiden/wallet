import type { Hash } from 'viem';

import type { AccountScope } from 'lib/miden-chain/account-scope';

import type { ReviewedTransfer } from './core/review';
import type { BridgeApproval } from './evm/approval';
import type { SourceTransaction } from './evm/source-transaction';

export interface BridgeOperationInput {
  operationId: string;
  review: ReviewedTransfer;
}
export interface BridgeSourceAttempt {
  phase: 'running' | 'known' | 'uncertain';
  hash?: Hash;
  intentNonce?: string;
  transaction?: SourceTransaction;
}
export interface BridgeOperationSnapshot extends BridgeOperationInput {
  version: 1;
  owner: 'wallet';
  revision: string;
  walletScope?: Pick<AccountScope, 'network' | 'rpcUrl'>;
  sourceAttempt?: BridgeSourceAttempt;
  approvals?: BridgeApproval[];
}
export async function claimBridgeSourceAttempt(
  _operationId: string,
  _expectedRevision: string
): Promise<'claimed' | 'already-running' | 'uncertain'> {
  return 'uncertain';
}
export async function recordBridgeSourceAttempt(
  _operationId: string,
  _revision: string,
  _known: Omit<BridgeSourceAttempt, 'phase'>
): Promise<boolean> {
  return false;
}
export async function recordBridgeApproval(
  _operationId: string,
  _revision: string,
  _approval: BridgeApproval
): Promise<boolean> {
  return false;
}
