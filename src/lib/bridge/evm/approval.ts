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
  /** The first verified own approve call, retained when the current transaction cancels or replaces it. */
  originalTransaction?: SourceTransaction;
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

/** Call identity is not a mined receipt or sufficient allowance; missing identities stay unverified. */
export function parseBridgeApproval(approval: BridgeApproval): BridgeApproval {
  if (
    !Number.isSafeInteger(approval.chainId) ||
    approval.chainId <= 0 ||
    !isAddress(approval.account, { strict: false }) ||
    !isAddress(approval.token, { strict: false }) ||
    !isAddress(approval.spender, { strict: false }) ||
    !isHash(approval.hash) ||
    !/^\d+$/.test(approval.amount) ||
    (approval.replacementReason !== undefined &&
      !['repriced', 'cancelled', 'replaced'].includes(approval.replacementReason))
  )
    throw new Error('Token approval terms changed');
  const transaction = approval.transaction === undefined ? undefined : parseSourceTransaction(approval.transaction);
  const original =
    approval.originalTransaction === undefined ? undefined : parseSourceTransaction(approval.originalTransaction);
  if (original) assertApprovalTransaction({ ...approval, hash: original.hash, replacementReason: undefined }, original);
  if (transaction) {
    if (
      transaction.hash.toLowerCase() !== approval.hash.toLowerCase() ||
      (approval.replacementReason !== undefined && !original)
    )
      throw new Error('Token approval identity changed');
    if (original) {
      if (
        (approval.replacementReason === undefined && original.hash.toLowerCase() !== transaction.hash.toLowerCase()) ||
        replacementReason(original, transaction) !== (approval.replacementReason ?? 'repriced')
      )
        throw new Error('Token approval replacement changed');
    } else assertApprovalTransaction(approval, transaction);
  }
  return {
    chainId: approval.chainId,
    account: approval.account,
    token: approval.token,
    spender: approval.spender,
    amount: approval.amount,
    hash: approval.hash,
    ...(transaction && { transaction }),
    ...(original && { originalTransaction: original }),
    ...(approval.replacementReason !== undefined && { replacementReason: approval.replacementReason })
  };
}

export function replaceApproval(approval: BridgeApproval, transaction: SourceTransaction): BridgeApproval {
  const current = parseBridgeApproval(approval);
  if (!current.transaction) throw new Error('Token approval identity is unknown');
  const original = current.originalTransaction ?? current.transaction;
  const replacement = parseSourceTransaction(transaction);
  return {
    ...current,
    hash: replacement.hash,
    transaction: replacement,
    originalTransaction: original,
    replacementReason: replacementReason(original, replacement)
  };
}
