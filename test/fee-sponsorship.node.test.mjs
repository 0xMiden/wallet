import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalFeeSponsorshipNoteId } from '../node_modules/.cache/nightly-send-request.mjs';

// Frozen from the published standards0.18 serial/storage rules using independent SDK0.18 WASM primitives.
const scope = {
  senderAccountId: '0xa95e28ec96b9ae1132266aa4d4ddb9',
  targetAccountId: '0xe69e6ca6e39df1b10c1e5399399feb',
  featureNoteId: `0x${'01'.repeat(32)}`,
  feeFaucetId: '0xe69e6ca6e39df1b10c1e5399399feb'
};
const GOLDEN = '0x44a6abaa6eb3ac82a61222bb4775f56d8f0c473b9d50ef8f70bd5fc469d8b447';
const otherFaucet = '0x123456789abcda3111223344556677';

test('real SDK reconstructs the canonical sponsorship commitment for the approved feature', () => {
  assert.equal(canonicalFeeSponsorshipNoteId(scope, 119n), GOLDEN);
});

for (const [name, changed, amount] of [
  ['amount', scope, 120n],
  ['sender/reclaimer', { ...scope, senderAccountId: '0x593c167bec26769178dcbd1f9bcb40' }, 119n],
  ['target', { ...scope, targetAccountId: otherFaucet }, 119n],
  ['feature note', { ...scope, featureNoteId: `0x${'02'.repeat(32)}` }, 119n],
  ['fee asset', { ...scope, feeFaucetId: otherFaucet }, 119n]
]) {
  test(`the sponsorship commitment binds ${name}`, () => {
    assert.notEqual(canonicalFeeSponsorshipNoteId(changed, amount), GOLDEN);
  });
}

test('malformed scope is not repaired into an approved sponsorship', () => {
  assert.throws(() => canonicalFeeSponsorshipNoteId({ ...scope, featureNoteId: 'invalid' }, 119n));
  assert.throws(() => canonicalFeeSponsorshipNoteId({ ...scope, senderAccountId: 'invalid' }, 119n));
});
