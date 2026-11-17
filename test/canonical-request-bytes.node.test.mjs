import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TransactionRequestBuilder } from '@miden-sdk/miden-sdk';
import { canonicalRequestBytes } from '../scripts/canonical-request-bytes.mjs';

test('SDK 0.18 default MerkleStore omits empty nodes and canonical bytes stay exact', () => {
  const bytes = new TransactionRequestBuilder().build().serialize();
  assert.equal(bytes.length, 24);
  const result = canonicalRequestBytes(bytes);
  assert.deepEqual(result, bytes);
  assert.notEqual(result, bytes);
});

test('no legacy store means unchanged bytes, not a declaration of request validity', () => {
  const invalidRequest = new Uint8Array([9, 8, 7]);
  assert.deepEqual(canonicalRequestBytes(invalidRequest), invalidRequest);
});

test('refuses invalid serialized sizes and ambiguous legacy stores', () => {
  assert.throws(() => canonicalRequestBytes([]), /Invalid serialized request size/);
  assert.throws(() => canonicalRequestBytes(new Uint8Array(1_048_577)), /Invalid serialized request size/);
  const ambiguous = new Uint8Array(208);
  const view = new DataView(ambiguous.buffer);
  view.setBigUint64(0, 1n, true);
  view.setBigUint64(104, 1n, true);
  assert.throws(() => canonicalRequestBytes(ambiguous), /not located exactly once/);
});
