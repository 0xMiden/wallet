import assert from 'node:assert/strict';

// Read-only qualification for the Green10 activation. This module cannot sign or broadcast.
export function assertGreen10ActivationReadiness({ legs, views, priceUsdMicros, remainingUsdMicros }) {
  assert.deepEqual(legs, [], 'Original allocator intent must still be empty');
  assert.equal(remainingUsdMicros, 1_510_431n, 'Reconciled Green10 allowance changed');
  assert.ok(typeof priceUsdMicros === 'bigint' && priceUsdMicros >= 1_662_490_000n, 'Invalid ETH valuation');
  assert.equal(views?.length, 2, 'Require two RPC observations');
  let bound = 0n;
  for (const view of views) {
    const { chainId, finalized, depositMatches, lockMatches, held, status, withdrawableAt, nonce,
      ownerGasWei, gas, maxFeePerGas, timestamp, simulatedAt, simulatedMaturity } = view;
    assert.ok(chainId === 1 && finalized === true && depositMatches === true && lockMatches === true,
      'Original finalized deposit and lock must match');
    assert.ok(held === 981_231n && status === 0 && withdrawableAt === 0n && nonce === 122,
      'Original custody, timer or nonce changed');
    assert.ok(typeof gas === 'bigint' && gas > 0n && gas <= 80_000n &&
      typeof maxFeePerGas === 'bigint' && maxFeePerGas > 0n &&
      typeof ownerGasWei === 'bigint' && ownerGasWei >= gas * maxFeePerGas, 'Invalid gas or reserve');
    assert.ok(typeof timestamp === 'bigint' && timestamp > 0n && typeof simulatedAt === 'bigint' &&
      simulatedAt >= timestamp && simulatedAt <= timestamp + 60n && simulatedMaturity === simulatedAt + 3900n,
      'Activation simulation must match the original reset period');
    const maximum = (gas * maxFeePerGas * priceUsdMicros + 10n ** 18n - 1n) / 10n ** 18n;
    assert.ok(maximum <= 100_000n && maximum <= remainingUsdMicros, 'Activation exceeds gas allowance');
    if (maximum > bound) bound = maximum;
  }
  return bound;
}
