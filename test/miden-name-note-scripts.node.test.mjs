import { NoteScript } from '@miden-sdk/miden-sdk';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const REPO_ROOT = process.cwd();
const ASSET_PATH = path.join(REPO_ROOT, 'public/miden-name/note-scripts.json');
const ROOTS_PATH = path.join(REPO_ROOT, 'src/lib/miden/name/note-script-roots.ts');

function readPinnedRootsSource() {
  const source = fs.readFileSync(ROOTS_PATH, 'utf8');
  const rootMatch = /export const REGISTER_DOMAIN_SCRIPT_ROOT_HEX\s*=\s*'([^']+)'/.exec(source);
  const lengthMatch = /export const REGISTER_DOMAIN_SCRIPT_BYTE_LENGTH\s*=\s*(\d+)/.exec(source);
  assert.ok(rootMatch?.[1], 'REGISTER_DOMAIN_SCRIPT_ROOT_HEX must be defined in note-script-roots.ts');
  assert.ok(lengthMatch?.[1], 'REGISTER_DOMAIN_SCRIPT_BYTE_LENGTH must be defined in note-script-roots.ts');
  return {
    rootHex: rootMatch[1].toLowerCase(),
    byteLength: Number(lengthMatch[1])
  };
}

function assertRegisterDomainAsset(asset, pinned) {
  const entry = asset?.registerDomain;
  assert.ok(entry && typeof entry.serializedBase64 === 'string', 'registerDomain.serializedBase64 must exist');
  assert.equal(entry.root.toLowerCase(), pinned.rootHex, 'asset root must match pinned script root');

  const bytes = Uint8Array.from(Buffer.from(entry.serializedBase64, 'base64'));
  assert.equal(bytes.length, pinned.byteLength, 'decoded script length must match pinned byte length');
  assert.equal(Buffer.from(bytes.subarray(0, 4)).toString('ascii'), 'MAST', 'decoded bytes must carry MAST header');

  const script = NoteScript.deserialize(bytes);
  try {
    const actualRoot = script.root().toHex().toLowerCase();
    assert.equal(
      actualRoot,
      pinned.rootHex,
      'deserialized MAST root must match pinned REGISTER_DOMAIN_SCRIPT_ROOT_HEX'
    );
  } finally {
    if (typeof script.free === 'function') {
      script.free();
    }
  }
}

test('vendored registerDomain script deserializes with real Miden SDK to pinned root', () => {
  const asset = JSON.parse(fs.readFileSync(ASSET_PATH, 'utf8'));
  const pinned = readPinnedRootsSource();
  assertRegisterDomainAsset(asset, pinned);
});

test('corrupting registerDomain payload while preserving length and MAST magic fails real SDK verification', () => {
  const asset = JSON.parse(fs.readFileSync(ASSET_PATH, 'utf8'));
  const pinned = readPinnedRootsSource();
  const bytes = Buffer.from(asset.registerDomain.serializedBase64, 'base64');
  // Flip a payload byte after the 4-byte MAST magic while keeping length identical.
  bytes[bytes.length - 1] ^= 0xff;
  const tampered = {
    ...asset,
    registerDomain: {
      ...asset.registerDomain,
      serializedBase64: bytes.toString('base64')
    }
  };
  assert.throws(() => assertRegisterDomainAsset(tampered, pinned));
});
