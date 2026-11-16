import { encodeFunctionData, erc20Abi, isAddress, isHash, type Address, type Hash } from 'viem';

import { parseSourceTransaction, replacementReason, type SourceTransaction } from './source-transaction';

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

/** Approvals retain their own hash/call; neither a receipt nor a repricing turns one into a bridge deposit. */
export function assertApprovalTransaction(approval: BridgeApproval, transaction: SourceTransaction): void {
  const source = parseSourceTransaction(transaction);
  if (
    approval.replacementReason === 'cancelled' ||
    approval.replacementReason === 'replaced' ||
    !isHash(approval.hash) ||
    !isAddress(approval.token, { strict: false }) ||
    !isAddress(approval.spender, { strict: false }) ||
    !/^\d+$/.test(approval.amount) ||
    source.chainId !== approval.chainId ||
    source.hash.toLowerCase() !== approval.hash.toLowerCase() ||
    source.from.toLowerCase() !== approval.account.toLowerCase() ||
    source.to?.toLowerCase() !== approval.token.toLowerCase() ||
    BigInt(source.value) !== 0n ||
    source.input.toLowerCase() !==
      encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [approval.spender, BigInt(approval.amount)]
      }).toLowerCase()
  )
    throw new Error('Token approval terms changed');
}

export function replaceApproval(approval: BridgeApproval, transaction: SourceTransaction): BridgeApproval {
  if (!approval.transaction) throw new Error('Token approval identity is unknown');
  assertApprovalTransaction(approval, approval.transaction);
  const replacement = parseSourceTransaction(transaction);
  return {
    ...approval,
    hash: replacement.hash,
    transaction: replacement,
    replacementReason: replacementReason(approval.transaction, replacement)
  };
}
