import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { toBaseUnits } from './transak-sync.js';

const ONE = 10n ** 18n;

describe('toBaseUnits', () => {
  it('converts JSON numbers and cuts extra decimals', () => {
    assert.equal(toBaseUnits(10.5, 18), 10n * ONE + ONE / 2n);
    assert.equal(toBaseUnits(1e-7, 18), 100_000_000_000n);
    assert.equal(toBaseUnits(1.23456789, 6), 1_234_567n);
    assert.equal(toBaseUnits(3, 0), 3n);
  });
});
