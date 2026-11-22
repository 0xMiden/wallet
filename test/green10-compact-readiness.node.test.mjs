import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertGreen10ActivationReadiness } from '../scripts/green10-compact-readiness.mjs';

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

test('rejects missing independent evidence, unknown or active intent, or changed ledger', () => {
  for (const rest of [{ views: [snapshot] }, { legs: null }, { legs: [{}] }, { remainingUsdMicros: 2_000_000n }]) {
    assert.throws(() => verify({}, rest));
  }
});
