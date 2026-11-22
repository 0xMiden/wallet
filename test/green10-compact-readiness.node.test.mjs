import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { verifyGreen10ActivationEnvelope } from '../scripts/green10-compact-envelope.mjs';
import { assertGreen10ActivationReadiness, consumeGreen10Activation, assertGreen10ActivationUnchanged } from '../scripts/green10-compact-readiness.mjs';

const snapshot = {
  chainId: 1, finalized: true, depositMatches: true, lockMatches: true,
  held: 981231n, status: 0, withdrawableAt: 0n, nonce: 122,
  ownerGasWei: 1_000_000_000_000_000n, gas: 48_000n, maxFeePerGas: 200_000_000n,
  timestamp: 1_800_000_000n, simulatedAt: 1_800_000_000n, simulatedMaturity: 1_800_003_900n
};
const verify = (second = {}, rest = {}) => assertGreen10ActivationReadiness({
  legs: [], views: [snapshot, { ...snapshot, ...second }],
  priceUsdMicros: 2_000_000_000n, remainingUsdMicros: 1_510_431n, ...rest
});

test('qualifies the observed activation only, under the existing per-stage cap', () => {
  assert.equal(verify(), 19_200n);
});

for (const [field, value] of Object.entries({
  chainId: 42161, finalized: false, depositMatches: false, lockMatches: false,
  held: 981230n, status: 1, withdrawableAt: 1n, nonce: 123,
  ownerGasWei: 1n, gas: 80_001n, maxFeePerGas: 5_000_000_000n,
  simulatedMaturity: 1_800_003_899n
})) test(`rejects changed ${field}`, () => assert.throws(() => verify({ [field]: value })));

test('consumes exactly one attempt only after the matching ACK and before expiry', t => {
  const dir = mkdtempSync(join(tmpdir(), 'compact-ack-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const marker = join(dir, 'enable.broadcast.once');
  const hash = `0x${'1'.repeat(64)}`;
  const journal = Buffer.from(JSON.stringify({ signedHash: hash }));
  const ack = `${createHash('sha256').update(journal).digest('hex')}\n`;
  const input = { marker, hash, journal, ack, preparedAt: 1000, now: 2000 };
  assert.throws(() => consumeGreen10Activation({ ...input, ack: 'changed' }));
  assert.throws(() => consumeGreen10Activation({ ...input, now: 241000 }));
  assert.throws(() => consumeGreen10Activation({ ...input, hash: `0x${'2'.repeat(64)}` }));
  consumeGreen10Activation(input);
  assert.equal(readFileSync(marker, 'utf8'), `${hash}\n`);
  assert.throws(() => consumeGreen10Activation(input));
});

test('rechecks immutable scope and frozen fees after ACK', () => {
  const transaction = { type: 'eip1559', chainId: 1, nonce: 122, to: 'compact', data: 'enable', value: 0n, gas: 48_000n, maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 1n };
  const first = { account: 'owner', sha256: 'checkpoint', transaction };
  const fresh = { ...first, priceUsdMicros: 2_000_000_000n, views: [{ ...snapshot, baseFeePerGas: 100_000_000n }, { ...snapshot, baseFeePerGas: 100_000_000n }] };
  assert.equal(assertGreen10ActivationUnchanged(first, fresh), 19_200n);
  for (const changed of [{ nonce: 123 }, { to: 'other' }, { data: 'withdraw' }, { gas: 48_001n }]) {
    assert.throws(() => assertGreen10ActivationUnchanged(first, { ...fresh, transaction: { ...transaction, ...changed } }));
  }
  for (const changed of [{ baseFeePerGas: 200_000_000n }, { ownerGasWei: 0n }]) {
    assert.throws(() => assertGreen10ActivationUnchanged(first, { ...fresh, views: [fresh.views[0], { ...fresh.views[1], ...changed }] }));
  }
});

test('verifies an exact activation envelope without a live key or transport', async () => {
  const fixtureSigner = privateKeyToAccount(`0x${'1'.repeat(64)}`);
  const transaction = {
    type: 'eip1559', chainId: 1, nonce: 122, to: `0x${'2'.repeat(40)}`, data: '0x12345678',
    value: 0n, gas: 48000n, maxFeePerGas: 200000000n, maxPriorityFeePerGas: 1n
  };
  const plan = { account: fixtureSigner.address, transaction };
  const serialized = await fixtureSigner.signTransaction(transaction);
  assert.match(await verifyGreen10ActivationEnvelope(serialized, plan), /^0x[0-9a-f]{64}$/);
  for (const change of [{ nonce: 123 }, { data: '0xdeadbeef' }, { gas: 48001n }, { value: 1n }, { to: `0x${'3'.repeat(40)}` }]) {
    const changed = await fixtureSigner.signTransaction({ ...transaction, ...change });
    await assert.rejects(verifyGreen10ActivationEnvelope(changed, plan));
  }
  await assert.rejects(verifyGreen10ActivationEnvelope(serialized, { ...plan, account: `0x${'3'.repeat(40)}` }));
});

test('rejects missing independent evidence, unknown or active intent, or changed ledger', () => {
  for (const rest of [{ views: [snapshot] }, { legs: null }, { legs: [{}] }, { remainingUsdMicros: 2_000_000n }]) {
    assert.throws(() => verify({}, rest));
  }
});
