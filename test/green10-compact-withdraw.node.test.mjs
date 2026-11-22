import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256 } from 'viem';
import { runGreen10Activation } from '../scripts/green10-compact-activate.mjs';
import { decodeFunctionData, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyGreen10WithdrawalEnvelope } from '../scripts/green10-compact-envelope.mjs';
import { assertGreen10WithdrawalUnchanged, green10WithdrawalIntent } from '../scripts/green10-compact-withdraw.mjs';

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

test('rejects a signed withdrawal that changes the original recipient or spends a different nonce', async () => {
  const signer = privateKeyToAccount(`0x${'5'.repeat(64)}`);
  const context = { owner: signer.address, compact, lock, views: [base, base] };
  const transaction = { ...green10WithdrawalIntent(context), gas: 70000n, maxFeePerGas: 100000000n, maxPriorityFeePerGas: 1n };
  const plan = { transaction, account: signer.address };
  assert.match(await verifyGreen10WithdrawalEnvelope(await signer.signTransaction(transaction), plan), /^0x[0-9a-f]{64}$/);
  for (const change of [{ data: intent([base, base]).data }, { nonce: 124 }]) {
    await assert.rejects(verifyGreen10WithdrawalEnvelope(await signer.signTransaction({ ...transaction, ...change }), plan));
  }
  await assert.rejects(verifyGreen10WithdrawalEnvelope(await signer.signTransaction({ ...transaction, data: intent([base, base]).data }),
    { ...plan, transaction: { ...transaction, data: intent([base, base]).data } }));
});

test('revalidates the frozen withdrawal after ACK against both live fee and reserve views', () => {
  const first = { sha256: 'a', account: owner, ready: true, transaction: { ...intent([base, base]), gas: 50000n, maxFeePerGas: 100000000n, maxPriorityFeePerGas: 10n } };
  const view = { baseFeePerGas: 90000000n, gasBalance: 10n ** 18n };
  const fresh = { ...first, priceUsdMicros: 2_000_000_000n, feeViews: [view, view] };
  assert.equal(assertGreen10WithdrawalUnchanged(first, fresh), 10000n);
  assert.throws(() => assertGreen10WithdrawalUnchanged(first, { ...fresh, ready: false }));
  assert.throws(() => assertGreen10WithdrawalUnchanged(first, { ...fresh, feeViews: [view, { ...view, baseFeePerGas: 100000000n }] }));
  assert.throws(() => assertGreen10WithdrawalUnchanged(first, { ...fresh, feeViews: [view, { ...view, gasBalance: 1n }] }));
  assert.throws(() => assertGreen10WithdrawalUnchanged(first, { ...fresh, transaction: { ...first.transaction, gas: 50001n } }));
});

test('withdrawal cannot sign before maturity, then requires an exact ACK for one submission', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'green10-withdraw-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const signer = privateKeyToAccount(`0x${'5'.repeat(64)}`);
  const tx = { ...green10WithdrawalIntent({ owner: signer.address, compact, lock, views: [base, base] }), gas: 50000n, maxFeePerGas: 100000000n, maxPriorityFeePerGas: 10n };
  const view = { baseFeePerGas: 90000000n, gasBalance: 10n ** 18n };
  const plan = { transaction: tx, ready: true, sha256: 'a'.repeat(64), account: signer.address, priceUsdMicros: 2_000_000_000n, feeViews: [view, view], bound: 10000n };
  let signed = 0, submitted = 0;
  const hooks = { stage: 'withdraw', runId: '1', source: 'b'.repeat(40), marker: join(dir, 'withdraw.once'),
    inspect: async () => plan,
    sign: transaction => { signed++; return signer.signTransaction(transaction); },
    acknowledge: async bytes => {
      const journal = JSON.parse(bytes);
      assert.equal(journal.stage, 'withdraw');
      assert.equal(journal.nonce, 123);
      assert.equal(journal.transaction, undefined);
      return `${createHash('sha256').update(bytes).digest('hex')}\n`;
    },
    submit: async bytes => { submitted++; return keccak256(bytes); }
  };
  await assert.rejects(runGreen10Activation({ ...hooks, inspect: async () => ({ ready: false }) }), /mature/);
  assert.equal(signed, 0);
  await assert.rejects(runGreen10Activation({ ...hooks, acknowledge: async () => 'wrong' }), /ACK/);
  assert.equal(submitted, 0);
  assert.match(await runGreen10Activation(hooks), /^0x[0-9a-f]{64}$/);
  await assert.rejects(runGreen10Activation(hooks), /consumed/);
  assert.equal(submitted, 1);
});

test('rejects either RPC having an immature, non-finalized, or modified lock', () => {
  for (const changes of [{ finalized: false }, { status: 1 }, { maturity: base.maturity - 1n }, { timestamp: base.timestamp - 1n }, { held: 981230n }, { nonce: 124 }]) {
    assert.throws(() => intent([base, { ...base, ...changes }]));
  }
  assert.throws(() => intent([base]));
});
