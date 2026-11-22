import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeFunctionData, parseAbi } from 'viem';
import { green10WithdrawalIntent } from '../scripts/green10-compact-withdraw.mjs';

const owner = `0x${'1'.repeat(40)}`;
const compact = `0x${'2'.repeat(40)}`;
const lock = 3n;
const base = { finalized: true, status: 2, maturity: 1795366283n, timestamp: 1795366283n, held: 981231n, nonce: 123 };
const intent = views => green10WithdrawalIntent({ owner, compact, lock, views });

test('binds the entire exact mature lock to its original owner', () => {
  const tx = intent([base, base]);
  assert.deepEqual({ ...tx, data: undefined }, { to: compact, data: undefined, value: 0n, chainId: 1, nonce: 123, type: 'eip1559' });
  assert.deepEqual(decodeFunctionData({ abi: parseAbi(['function forcedWithdrawal(uint256,address,uint256) returns (bool)']), data: tx.data }), {
    functionName: 'forcedWithdrawal', args: [lock, owner, 981231n]
  });
});

test('rejects either RPC having an immature, non-finalized, or modified lock', () => {
  for (const changes of [{ finalized: false }, { status: 1 }, { maturity: base.maturity - 1n }, { timestamp: base.timestamp - 1n }, { held: 981230n }, { nonce: 124 }]) {
    assert.throws(() => intent([base, { ...base, ...changes }]));
  }
  assert.throws(() => intent([base]));
});
