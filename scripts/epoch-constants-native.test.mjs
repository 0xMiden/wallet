import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MIDEN_VIRTUAL_CHAIN_ID } from '@epoch-protocol/epoch-intents-sdk/dist/constants.js';

test('Epoch Miden chain constant loads in the native Node E2E runtime', () => {
  assert.equal(MIDEN_VIRTUAL_CHAIN_ID, 999999999);
});
