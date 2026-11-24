import assert from 'node:assert/strict';
import test from 'node:test';
import { validateScreenshotJournal } from './screenshot-journal.mjs';

const binding = {
  appId: '6789341854',
  bundleId: 'com.miden.bread',
  version: '1.17.8',
  network: 'testnet',
  sourceSha: 'a'.repeat(40),
  manifestSha256: 'b'.repeat(64)
};
const image = {
  assetId: 'old',
  state: 'COMPLETE',
  checksum: { algorithm: 'md5', value: 'c'.repeat(32) },
  fileName: 'old.png',
  fileSize: 123
};
const journal = () => ({
  schemaVersion: 1,
  binding: { ...binding },
  versionId: 'draft',
  pending: null,
  groups: [
    {
      locale: 'en-US',
      displayType: 'APP_IPHONE_67',
      localizationId: 'locale',
      setId: 'large',
      desired: ['d'.repeat(64)],
      original: [image],
      images: [image],
      owned: []
    }
  ]
});

test('journal rejects unknown fields and binding drift instead of sanitizing them into authority', () => {
  assert.deepEqual(validateScreenshotJournal(journal(), binding), journal());
  for (const alter of [
    j => {
      j.uploadUrl = 'https://blob.apple.com/private';
    },
    j => {
      j.binding.sourceSha = 'f'.repeat(40);
    },
    j => {
      j.groups[0].images[0] = { ...image, Authorization: 'hidden' };
    },
    j => {
      j.groups[0].desired = Array(11).fill('d'.repeat(64));
    },
    j => {
      j.pending = { kind: 'delete', group: 0, assetId: 'absent' };
    }
  ]) {
    const value = structuredClone(journal());
    alter(value);
    assert.throws(() => validateScreenshotJournal(value, binding), /journal/i);
  }
});
test('journal pending operation has no unrelated payload fields or unowned completion authority', () => {
  for (const pending of [
    { kind: 'delete', group: 0, assetId: 'old', fileName: 'https://private.example/secret' },
    { kind: 'complete', group: 0, assetId: 'old' },
    { kind: 'create-set', group: 0 }
  ])
    assert.throws(() => validateScreenshotJournal({ ...journal(), pending }), /journal/i);
});
