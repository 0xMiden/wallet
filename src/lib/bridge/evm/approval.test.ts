import { encodeFunctionData, erc20Abi } from 'viem';

import { assertApprovalTransaction, replaceApproval, type BridgeApproval } from './approval';
import type { SourceTransaction } from './source-transaction';

const approval: BridgeApproval = {
  chainId: 11155111,
  account: `0x${'1'.repeat(40)}`,
  token: `0x${'2'.repeat(40)}`,
  spender: `0x${'3'.repeat(40)}`,
  amount: '100',
  hash: `0x${'4'.repeat(64)}`
};
const transaction: SourceTransaction = {
  chainId: approval.chainId,
  hash: approval.hash,
  from: `0x${'1'.repeat(40)}`,
  to: approval.token,
  nonce: 3,
  input: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [approval.spender, 100n] }),
  value: '0'
};

it('binds approval to the exact token, spender, amount, account and chain', () => {
  expect(() => assertApprovalTransaction(approval, transaction)).not.toThrow();
  const reset = { ...approval, amount: '0' };
  expect(() =>
    assertApprovalTransaction(reset, {
      ...transaction,
      input: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [approval.spender, 0n] })
    })
  ).not.toThrow();
});

it.each([
  { chainId: 1 },
  { from: `0x${'5'.repeat(40)}` },
  { to: `0x${'5'.repeat(40)}` },
  { hash: `0x${'5'.repeat(64)}` },
  { value: '1' },
  { input: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [approval.spender, 101n] }) },
  { input: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [`0x${'5'.repeat(40)}`, 100n] }) },
  { input: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [approval.spender, 100n] }) }
] satisfies Partial<SourceTransaction>[])('refuses approval identity or calldata substitution %j', change => {
  expect(() => assertApprovalTransaction(approval, { ...transaction, ...change })).toThrow();
});

it('retains a repriced approval as an approval, not a bridge source transfer', () => {
  const next: SourceTransaction = { ...transaction, hash: `0x${'6'.repeat(64)}` };
  expect(replaceApproval({ ...approval, transaction }, next)).toEqual({
    ...approval,
    hash: next.hash,
    transaction: next,
    originalTransaction: transaction,
    replacementReason: 'repriced'
  });
});

it.each([
  [{ to: transaction.from, input: '0x', value: '0' }, 'cancelled'],
  [{ input: '0x1234' }, 'replaced']
] satisfies Array<[Partial<SourceTransaction>, string]>)(
  'retains the rejected approval replacement for recovery %j',
  (change, reason) => {
    const next: SourceTransaction = { ...transaction, hash: `0x${'6'.repeat(64)}`, ...change };
    const replaced = replaceApproval({ ...approval, transaction }, next);
    expect(replaced).toEqual({
      ...approval,
      hash: next.hash,
      transaction: next,
      originalTransaction: transaction,
      replacementReason: reason
    });
    expect(() => assertApprovalTransaction(replaced, next)).toThrow();
  }
);

it('cannot attach an unrelated nonce as a repriced approval', () => {
  expect(() => replaceApproval({ ...approval, transaction }, { ...transaction, nonce: 4 })).toThrow();
  expect(() => replaceApproval(approval, transaction)).toThrow();
});

it('preserves the first verified own approval through repeated repricing and later replacement facts', () => {
  const repriced = replaceApproval({ ...approval, transaction }, { ...transaction, hash: `0x${'6'.repeat(64)}` });
  const again = replaceApproval(repriced, { ...transaction, hash: `0x${'7'.repeat(64)}` });
  expect(again.originalTransaction).toEqual(transaction);
  const cancelled = replaceApproval(again, {
    ...transaction,
    hash: `0x${'8'.repeat(64)}`,
    to: transaction.from,
    input: '0x'
  });
  expect(cancelled.originalTransaction).toEqual(transaction);
  expect(cancelled.replacementReason).toBe('cancelled');
  const replaced = replaceApproval(cancelled, { ...transaction, hash: `0x${'9'.repeat(64)}`, input: '0x1234' });
  expect(replaced.originalTransaction).toEqual(transaction);
  expect(replaced.replacementReason).toBe('replaced');
  expect(() => assertApprovalTransaction(replaced, replaced.transaction ?? transaction)).toThrow();
});

it.each([
  { chainId: 1 },
  { from: `0x${'5'.repeat(40)}` },
  { to: `0x${'5'.repeat(40)}` },
  { hash: `0x${'5'.repeat(64)}` },
  { nonce: 4 },
  { value: '1' },
  { input: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [approval.spender, 101n] }) },
  { input: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [`0x${'5'.repeat(40)}`, 100n] }) }
] satisfies Partial<SourceTransaction>[])('never replaces a forged original own-approval identity case %#', change => {
  expect(() =>
    replaceApproval(
      { ...approval, transaction, originalTransaction: { ...transaction, ...change } },
      { ...transaction, hash: `0x${'6'.repeat(64)}` }
    )
  ).toThrow();
});

it('refuses a forged stored replacement reason even when the original and current hashes are individually well formed', () => {
  const current: SourceTransaction = { ...transaction, hash: `0x${'6'.repeat(64)}` };
  const forged: BridgeApproval = {
    ...approval,
    hash: current.hash,
    transaction: current,
    originalTransaction: transaction,
    replacementReason: 'cancelled'
  };
  expect(() => replaceApproval(forged, { ...current, hash: `0x${'7'.repeat(64)}` })).toThrow();
});
