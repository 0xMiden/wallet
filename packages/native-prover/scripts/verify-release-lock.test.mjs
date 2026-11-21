import assert from 'node:assert/strict';
import { test } from 'node:test';

import { verifyReleaseLock } from './verify-release-lock.mjs';

const crate = (name, version = '0.36.3', checksum = 'abc', source = 'registry+https://github.com/rust-lang/crates.io-index') =>
  `[[package]]\nname = "${name}"\nversion = "${version}"\nsource = "${source}"\nchecksum = "${checksum}"\n`;
const required = ['miden-client', 'miden-objects', 'miden-protocol', 'miden-standards', 'miden-tx', 'miden-core', 'miden-core-lib', 'miden-assembly', 'miden-mast-package', 'miden-prover'];
const lock = required.map(name => crate(name)).join('\n');

test('accepts matching release graph and native-only JNI dependencies', () => {
  assert.equal(verifyReleaseLock(lock + crate('jni'), lock).length, required.length);
});

test('rejects VM version, checksum, and source drift without exemptions', () => {
  for (const bad of [crate('miden-core', '0.36.2'), crate('miden-core', '0.36.3', 'changed'), crate('miden-core', '0.36.3', 'abc', 'git+https://example.com')]) {
    assert.throws(() => verifyReleaseLock(lock.replace(crate('miden-core'), bad), lock), /miden-core/);
  }
});

test('checks extra Miden dependencies and duplicate versions, not just required kernel names', () => {
  assert.throws(() => verifyReleaseLock(lock + crate('miden-precompiles-air'), lock), /miden-precompiles-air/);
  assert.throws(() => verifyReleaseLock(lock + crate('miden-core', '0.36.2'), lock), /miden-core/);
});

test('rejects absent required dependencies', () => {
  assert.throws(() => verifyReleaseLock(lock.replace(crate('miden-objects'), ''), lock), /miden-objects/);
});
