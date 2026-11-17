#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const REQUIRED = [
  'miden-client', 'miden-objects', 'miden-protocol', 'miden-standards', 'miden-tx',
  'miden-core', 'miden-core-lib', 'miden-assembly', 'miden-mast-package', 'miden-prover'
];

function packages(lock) {
  return lock.split(/^\[\[package\]\]$/m).slice(1).map(block => {
    const field = name => block.match(new RegExp(`^${name} = "([^"]+)"$`, 'm'))?.[1];
    return { name: field('name'), version: field('version'), source: field('source'), checksum: field('checksum') };
  });
}

// Compare identities, not semver ranges: procedure roots and proof formats must match.
export function verifyReleaseLock(nativeLock, webLock) {
  const native = packages(nativeLock).filter(pkg => /^(miden-|winter-)/.test(pkg.name) && pkg.name !== 'miden-native-prover-jni');
  const web = new Set(packages(webLock).map(pkg => JSON.stringify(pkg)));
  for (const name of REQUIRED) assert(native.some(pkg => pkg.name === name), `Missing ${name}`);
  for (const pkg of native) {
    assert(pkg.source && pkg.checksum && web.has(JSON.stringify(pkg)), `Release graph mismatch: ${JSON.stringify(pkg)}`);
  }
  return native;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.argv.length, 4, 'Usage: verify-release-lock.mjs native/Cargo.lock web-sdk/Cargo.lock');
  console.log(JSON.stringify(verifyReleaseLock(fs.readFileSync(process.argv[2], 'utf8'), fs.readFileSync(process.argv[3], 'utf8')), null, 2));
}
