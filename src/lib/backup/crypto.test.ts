import { scryptAsync } from '@noble/hashes/scrypt';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, concatBytes, utf8ToBytes } from '@noble/hashes/utils';

import { b64ToU8, u8ToB64 } from 'lib/shared/helpers';

import {
  AES_GCM_NONCE_LENGTH,
  DEFAULT_BLOB_CAP,
  DEFAULT_SCRYPT_PARAMS,
  ENVELOPE_VERSION,
  HISTORY_BLOB_CAP,
  type ScryptParams,
  decryptEntry,
  deriveEncryptionKeyBytes,
  encryptEntry,
  encryptedBlobLength,
  hashedEntryKey,
  importEncryptionKey,
  packKdfParams,
  plaintextDigest,
  storageKeyFromSignature,
  unpackKdfParams
} from './crypto';
import { installCopyingImportKey } from './testing/backup-harness';

jest.mock('@noble/hashes/scrypt', () => {
  const actual = jest.requireActual<typeof import('@noble/hashes/scrypt')>('@noble/hashes/scrypt');
  return { ...actual, scryptAsync: jest.fn(actual.scryptAsync) };
});

const NONCE = new Uint8Array(AES_GCM_NONCE_LENGTH).fill(3);

let removeImportShim: () => void;
beforeAll(() => {
  removeImportShim = installCopyingImportKey();
});
afterAll(() => removeImportShim());

async function keyOf(fill: number): Promise<CryptoKey> {
  return importEncryptionKey(new Uint8Array(32).fill(fill));
}

describe('kdf_params packing', () => {
  it('packs the envelope 1 parameters (scrypt, N = 2^17, r = 8, p = 1, dkLen 32, salt 16) to 36624', () => {
    expect(DEFAULT_SCRYPT_PARAMS).toEqual({ logN: 17, r: 8, p: 1, dkLen: 32, saltLen: 16 });
    expect(packKdfParams(DEFAULT_SCRYPT_PARAMS)).toBe(36624);
    expect(unpackKdfParams(36624)).toEqual(DEFAULT_SCRYPT_PARAMS);
  });

  it.each<ScryptParams>([
    { logN: 14, r: 1, p: 1, dkLen: 16, saltLen: 16 },
    { logN: 20, r: 16, p: 4, dkLen: 32, saltLen: 47 },
    { logN: 18, r: 8, p: 2, dkLen: 32, saltLen: 32 }
  ])('round-trips %j', params => {
    expect(unpackKdfParams(packKdfParams(params))).toEqual(params);
  });

  it.each([
    ['a negative value', -1],
    ['a fraction', 36624.5],
    ['a reserved bit', 36624 | (1 << 21)],
    ['another KDF id', 36624 | 1],
    ['log2 N below 14', packKdfParams({ ...DEFAULT_SCRYPT_PARAMS, logN: 13 })],
    ['log2 N above 20', packKdfParams({ ...DEFAULT_SCRYPT_PARAMS, logN: 21 })]
  ])('refuses %s', (_name, value) => {
    expect(unpackKdfParams(value)).toBeNull();
  });
});

describe('storage key and hashed keys', () => {
  it('takes the SHA-256 of the signature as the storage key', () => {
    const signature = new Uint8Array(64).fill(5);
    expect(bytesToHex(storageKeyFromSignature(signature))).toBe(bytesToHex(sha256(signature)));
  });

  it('hashes an entry key as sha256(utf8(entryKey) || storageKey), lowercase hex', () => {
    const storageKey = new Uint8Array(32).fill(1);
    const expected = bytesToHex(sha256(concatBytes(utf8ToBytes('contacts'), storageKey)));
    expect(hashedEntryKey('contacts', storageKey)).toBe(expected);
    expect(hashedEntryKey('contacts', storageKey)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives other hashes for another entry key or another storage key', () => {
    const storageKey = new Uint8Array(32).fill(1);
    const hash = hashedEntryKey('history:dev:0', storageKey);
    expect(hashedEntryKey('history:dev:1', storageKey)).not.toBe(hash);
    expect(hashedEntryKey('history:dev:0', new Uint8Array(32).fill(2))).not.toBe(hash);
  });

  it('digests a plaintext as lowercase hex SHA-256', () => {
    expect(plaintextDigest('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('deriveEncryptionKeyBytes', () => {
  it('runs scrypt with N = 2^17, r = 8, p = 1, dkLen = 32 by default', async () => {
    const storageKey = new Uint8Array(32).fill(1);
    const salt = new Uint8Array(16).fill(2);
    const bytes = await deriveEncryptionKeyBytes(storageKey, salt);
    expect(bytes).toHaveLength(32);
    expect(jest.mocked(scryptAsync)).toHaveBeenCalledWith(storageKey, salt, { N: 131072, r: 8, p: 1, dkLen: 32 });
  });

  it('matches the RFC 7914 vector for the given parameters', async () => {
    // RFC 7914 section 12: P = "password", S = "NaCl", N = 1024, r = 8, p = 16. dkLen 32 is the first half of its 64 bytes.
    const bytes = await deriveEncryptionKeyBytes(utf8ToBytes('password'), utf8ToBytes('NaCl'), {
      logN: 10,
      r: 8,
      p: 16,
      dkLen: 32,
      saltLen: 4
    });
    expect(bytesToHex(bytes)).toBe('fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b373162');
  });

  it('refuses a salt that is not saltLen bytes', async () => {
    await expect(deriveEncryptionKeyBytes(new Uint8Array(32), new Uint8Array(15))).rejects.toThrow(
      'The profile salt must be 16 bytes'
    );
  });
});

describe('AES-256-GCM entries', () => {
  it('imports a non-extractable key', async () => {
    const key = await keyOf(1);
    expect(key.extractable).toBe(false);
    expect(key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toBeDefined();
  });

  it("keeps the caller's bytes; the caller zeroes them", async () => {
    const raw = new Uint8Array(32).fill(9);
    await importEncryptionKey(raw);
    expect(raw.every(byte => byte === 9)).toBe(true);
  });

  it('seals nonce || ciphertext || tag and opens it again', async () => {
    const key = await keyOf(1);
    const plaintext = 'Grüße 👋';
    const entry = await encryptEntry(key, plaintext, 36624, NONCE);
    expect(entry.envelope).toBe(ENVELOPE_VERSION);
    expect(entry.kdfParams).toBe(36624);
    const blob = b64ToU8(entry.blob);
    expect(blob.length).toBe(encryptedBlobLength(utf8ToBytes(plaintext).length));
    expect(bytesToHex(blob.subarray(0, AES_GCM_NONCE_LENGTH))).toBe(bytesToHex(NONCE));
    await expect(decryptEntry(key, entry, DEFAULT_BLOB_CAP)).resolves.toBe(plaintext);
  });

  it('takes a fresh random nonce for each call', async () => {
    const key = await keyOf(1);
    const first = await encryptEntry(key, 'same', 1);
    const second = await encryptEntry(key, 'same', 1);
    expect(first.blob).not.toBe(second.blob);
  });

  it('refuses a nonce that is not 12 bytes', async () => {
    await expect(encryptEntry(await keyOf(1), 'x', 1, new Uint8Array(11))).rejects.toThrow(
      'The AES-GCM nonce must be 12 bytes'
    );
  });

  it('refuses another key and a changed byte', async () => {
    const entry = await encryptEntry(await keyOf(1), 'secret', 1, NONCE);
    await expect(decryptEntry(await keyOf(2), entry, DEFAULT_BLOB_CAP)).rejects.toBeDefined();

    const blob = b64ToU8(entry.blob);
    blob[AES_GCM_NONCE_LENGTH] = (blob[AES_GCM_NONCE_LENGTH] ?? 0) ^ 1;
    await expect(
      decryptEntry(await keyOf(1), { ...entry, blob: u8ToB64(blob) }, DEFAULT_BLOB_CAP)
    ).rejects.toBeDefined();
  });

  it('refuses an unknown envelope', async () => {
    const entry = await encryptEntry(await keyOf(1), 'x', 1, NONCE);
    await expect(decryptEntry(await keyOf(1), { ...entry, envelope: 2 }, DEFAULT_BLOB_CAP)).rejects.toThrow(
      'Unknown backup envelope 2'
    );
  });

  it('refuses a blob shorter than a nonce and a tag, or over the cap', async () => {
    const key = await keyOf(1);
    const short = { envelope: 1, kdfParams: 1, blob: u8ToB64(new Uint8Array(27)) };
    await expect(decryptEntry(key, short, DEFAULT_BLOB_CAP)).rejects.toThrow('Backup blob length 27 is out of range');

    const entry = await encryptEntry(key, 'x'.repeat(100), 1, NONCE);
    await expect(decryptEntry(key, entry, 100)).rejects.toThrow('Backup blob length 128 is out of range');
    await expect(decryptEntry(key, entry, 128)).resolves.toBe('x'.repeat(100));
  });

  it('refuses a plaintext that is not UTF-8', async () => {
    const key = await keyOf(1);
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: NONCE, tagLength: 128 },
      key,
      new Uint8Array([0xff, 0xfe])
    );
    const entry = { envelope: 1, kdfParams: 1, blob: u8ToB64(concatBytes(NONCE, new Uint8Array(sealed))) };
    await expect(decryptEntry(key, entry, DEFAULT_BLOB_CAP)).rejects.toBeDefined();
  });

  it('caps a history blob at 25600 bytes and every other blob at 4096', () => {
    expect(HISTORY_BLOB_CAP).toBe(25600);
    expect(DEFAULT_BLOB_CAP).toBe(4096);
    expect(encryptedBlobLength(0)).toBe(28);
  });
});
