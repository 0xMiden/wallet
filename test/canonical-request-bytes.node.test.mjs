import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { TransactionRequestBuilder } from '@miden-sdk/miden-sdk';
import { canonicalRequestBytes } from '../scripts/canonical-request-bytes.mjs';

test('SDK 0.18 default MerkleStore omits empty nodes and canonical bytes stay exact', () => {
  const bytes = new TransactionRequestBuilder().build().serialize();
  assert.equal(bytes.length, 24);
  const result = canonicalRequestBytes(bytes);
  assert.deepEqual(result, bytes);
  assert.notEqual(result, bytes);
});

test('frozen published SDK 0.17.5 authorities keep their canonical identity', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/sdk017-canonical-request.json', import.meta.url), 'utf8'));
  assert.equal(fixture.sdk, '0.17.5');
  const bytes = new Uint8Array(Buffer.from(fixture.serializedBase64, 'base64'));
  const digest = input => createHash('sha256').update(canonicalRequestBytes(input)).digest('hex');
  assert.equal(digest(bytes), fixture.canonicalSha256);
  const reordered = Uint8Array.from(bytes);
  const start = 16;
  for (let index = 0; index < 255; index++) {
    reordered.set(bytes.subarray(start + index * 96, start + (index + 1) * 96), start + (254 - index) * 96);
  }
  assert.equal(digest(reordered), fixture.canonicalSha256);
  const changed = Uint8Array.from(bytes);
  changed[changed.length - 1] ^= 1;
  assert.notEqual(digest(changed), fixture.canonicalSha256);
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
