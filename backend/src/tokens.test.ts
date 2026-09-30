import assert from 'node:assert/strict';
import { it } from 'node:test';

import { ONRAMP_TOKEN } from './chain-testnet/token.js';
import { toBaseUnits } from './orders/transak-sync.js';
import { ONRAMP_TOKENS } from './tokens.js';

it('uses USDC base units on Ethereum and TRNSK base units in staging', () => {
  assert.equal(ONRAMP_TOKENS[1].address.toLowerCase(), '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
  assert.equal(toBaseUnits(1.25, ONRAMP_TOKENS[1].decimals), 1_250_000n);
  assert.equal(ONRAMP_TOKEN.address.toLowerCase(), '0x0c86a754a29714c4fe9c6f1359fa7099ed174c0b');
  assert.equal(toBaseUnits(1.25, ONRAMP_TOKEN.decimals), 1_250_000_000_000_000_000n);
});
