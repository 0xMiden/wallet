import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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

export function assertGreen10ActivationUnchanged(first, fresh) {
  assert.equal(fresh.account, first.account);
  assert.equal(fresh.sha256, first.sha256);
  const tx = first.transaction;
  for (const key of ['type', 'chainId', 'nonce', 'to', 'data', 'value'])
    assert.equal(fresh.transaction[key], tx[key], `Activation ${key} changed`);
  assert.ok(fresh.transaction.gas <= tx.gas, 'Frozen gas no longer sufficient');
  assert.ok(tx.maxPriorityFeePerGas >= 0n && tx.maxPriorityFeePerGas <= tx.maxFeePerGas);
  for (const view of fresh.views) {
    assert.ok(typeof view.baseFeePerGas === 'bigint' && view.baseFeePerGas >= 0n);
    assert.ok(view.baseFeePerGas + tx.maxPriorityFeePerGas <= tx.maxFeePerGas, 'Frozen fee no longer sufficient');
  }
  return assertGreen10ActivationReadiness({ legs: [], views: fresh.views.map(view => ({ ...view, gas: tx.gas, maxFeePerGas: tx.maxFeePerGas })),
    priceUsdMicros: fresh.priceUsdMicros, remainingUsdMicros: 1_510_431n });
}

export function consumeGreen10Activation({ marker, hash, journal, ack, preparedAt, now }) {
  assert.ok(Number.isSafeInteger(preparedAt) && preparedAt > 0 && Number.isSafeInteger(now));
  assert.ok(now >= preparedAt && now - preparedAt < 240_000, 'Activation authority expired');
  assert.match(hash, /^0x[0-9a-f]{64}$/);
  assert.ok(Buffer.isBuffer(journal) && journal.length > 0 && journal.length <= 65_536);
  assert.equal(ack, `${createHash('sha256').update(journal).digest('hex')}\n`, 'Immutable ACK does not match');
  assert.equal(JSON.parse(journal).signedHash, hash, 'Signed hash changed');
  const fd = openSync(marker, 'wx', 0o600);
  try {
    writeFileSync(fd, `${hash}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const directory = openSync(dirname(marker), 'r');
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
