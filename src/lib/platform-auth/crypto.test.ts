import { Buffer } from 'buffer';

import { parsePlatformUnlockRecord, unwrapPlatformVaultKey, wrapPlatformVaultKey } from './crypto';

const encode = (bytes: Uint8Array) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const vaultBytes = new Uint8Array(32).fill(7);
const prf = new Uint8Array(32).fill(19);
const credentialId = new Uint8Array([255, 254, 253, 252]);
const record = {
  version: 1,
  credentialId: encode(credentialId),
  prfSalt: encode(new Uint8Array(32).fill(11)),
  wrappedKey: encode(new Uint8Array(60)),
  backupEligible: true
};

it('wraps the original vault bytes under the specified HKDF context and a fresh 12-byte IV', async () => {
  const first = await wrapPlatformVaultKey(vaultBytes, prf, credentialId);
  expect(await wrapPlatformVaultKey(vaultBytes, prf, credentialId)).not.toBe(first);
  const payload = new Uint8Array(Buffer.from(first, 'base64'));
  expect(payload.byteLength).toBe(60);
  const material = await crypto.subtle.importKey('raw', prf.buffer, 'HKDF', false, ['deriveKey']);
  const oracle = await crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: credentialId.buffer,
      info: new TextEncoder().encode('miden-wallet:vault-key-platform:v1')
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: payload.slice(0, 12) }, oracle, payload.slice(12));
  expect(new Uint8Array(plain)).toEqual(vaultBytes);
});

it('imports the unwrapped key non-extractably with the existing vault encryption usages', async () => {
  const wrapped = await wrapPlatformVaultKey(vaultBytes, prf, credentialId);
  const key = await unwrapPlatformVaultKey(wrapped, prf, credentialId);
  expect(key.extractable).toBe(false);
  expect(key.usages).toEqual(['encrypt', 'decrypt']);
  const oracle = await crypto.subtle.importKey('raw', vaultBytes.buffer, 'AES-GCM', false, ['encrypt']);
  const iv = new Uint8Array(12).fill(5);
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, oracle, new Uint8Array([9, 8, 7]));
  expect(new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext))).toEqual(
    new Uint8Array([9, 8, 7])
  );
  await expect(crypto.subtle.exportKey('raw', key)).rejects.toBeTruthy();
});

it('refuses a different PRF, credential ID or corrupted authentication tag', async () => {
  const wrapped = await wrapPlatformVaultKey(vaultBytes, prf, credentialId);
  await expect(unwrapPlatformVaultKey(wrapped, new Uint8Array(32).fill(20), credentialId)).rejects.toBeTruthy();
  await expect(unwrapPlatformVaultKey(wrapped, prf, new Uint8Array([1, 2, 3, 4]))).rejects.toBeTruthy();
  const corrupt = new Uint8Array(Buffer.from(wrapped, 'base64'));
  corrupt[59] ^= 1;
  await expect(unwrapPlatformVaultKey(encode(corrupt), prf, credentialId)).rejects.toBeTruthy();
});

it.each([0, 31, 33])('refuses a %i-byte vault key or PRF before wrapping', async length => {
  await expect(wrapPlatformVaultKey(new Uint8Array(length), prf, credentialId)).rejects.toThrow();
  await expect(wrapPlatformVaultKey(vaultBytes, new Uint8Array(length), credentialId)).rejects.toThrow();
  await expect(unwrapPlatformVaultKey(record.wrappedKey, new Uint8Array(length), credentialId)).rejects.toThrow();
});

it.each([0, 1024])('refuses a %i-byte credential ID', async length => {
  await expect(wrapPlatformVaultKey(vaultBytes, prf, new Uint8Array(length))).rejects.toThrow();
  await expect(unwrapPlatformVaultKey(record.wrappedKey, prf, new Uint8Array(length))).rejects.toThrow();
});

it('accepts the largest credential ID without truncating its binding', async () => {
  const id = new Uint8Array(1023).fill(255);
  const wrapped = await wrapPlatformVaultKey(vaultBytes, prf, id);
  await expect(unwrapPlatformVaultKey(wrapped, prf, id)).resolves.toHaveProperty('extractable', false);
});

it.each(['', 'not+url', 'AAAA=', 'AA AA', encode(new Uint8Array(59)), encode(new Uint8Array(61))])(
  'refuses a malformed wrapped payload %s',
  async value => {
    await expect(unwrapPlatformVaultKey(value, prf, credentialId)).rejects.toThrow();
  }
);

it('parses only known record fields and treats backup eligibility as an unauthenticated hint', () => {
  expect(parsePlatformUnlockRecord({ ...record, prfSecret: 'must not persist' })).toEqual(record);
  expect(parsePlatformUnlockRecord({ ...record, backupEligible: false })).toEqual({ ...record, backupEligible: false });
});

it.each([
  null,
  [],
  {},
  1,
  { ...record, version: 2 },
  { ...record, version: '1' },
  { ...record, credentialId: '' },
  { ...record, credentialId: 'AB' },
  { ...record, credentialId: encode(new Uint8Array(1024)) },
  { ...record, prfSalt: encode(new Uint8Array(31)) },
  { ...record, prfSalt: encode(new Uint8Array(33)) },
  { ...record, prfSalt: 32 },
  { ...record, wrappedKey: encode(new Uint8Array(59)) },
  { ...record, wrappedKey: record.wrappedKey + '=' },
  { ...record, backupEligible: 'true' },
  { ...record, backupEligible: undefined }
])('refuses malformed or unsupported platform record %#', value => {
  expect(parsePlatformUnlockRecord(value)).toBeNull();
});
