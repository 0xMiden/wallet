import type { Address, Hash } from 'viem';

import type { SourceTransaction } from './source-transaction';

export interface BridgeApproval {
  chainId: number;
  account: string;
  token: Address;
  spender: Address;
  amount: string;
  hash: Hash;
  transaction?: SourceTransaction;
  replacementReason?: 'repriced' | 'cancelled' | 'replaced';
}
export function assertApprovalTransaction(_approval: BridgeApproval, _transaction: SourceTransaction): void {
  throw new Error('Unsupported approval identity');
}
export function replaceApproval(_approval: BridgeApproval, _transaction: SourceTransaction): BridgeApproval {
  throw new Error('Unsupported approval replacement');
}
