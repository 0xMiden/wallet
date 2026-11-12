import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha2';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

import { deriveHardenedPath, mnemonicToSeed } from '@miden/hd-key';

import {
  SYNC_KEY_LABEL,
  SYNC_KEY_PATH,
  deriveSyncSecretKey,
  isValidSyncSecretKey,
  signSyncMessage,
  storageKeyMessage,
  syncLoginMessage,
  syncPublicKeyHex
} from './sync-key';
import { PHRASE_A, PHRASE_B } from './testing/backup-harness';

/** The sync public key of PHRASE_A. A change of label or path changes it, and makes every backup unreachable. */
const PHRASE_A_SYNC_PUBLIC_KEY = '022733ef2387454fc988da6bf6368b077eacfe0d525c057ad50c7ef8eb52d1bb0f';

const CURVE_ORDER = secp256k1.CURVE.n;

function scalarBytes(value: bigint): Uint8Array {
  return hexToBytes(value.toString(16).padStart(64, '0'));
}

describe('sync key derivation', () => {
  it("uses the label `miden sync` and the path m/44'/5063758'/1000'/0'", () => {
    expect(SYNC_KEY_LABEL).toBe('miden sync');
    expect(SYNC_KEY_PATH).toBe("m/44'/5063758'/1000'/0'");
  });

  it('is the SLIP-0010 secret of the sync path under the sync label', () => {
    const expected = deriveHardenedPath(mnemonicToSeed(PHRASE_A), 'miden sync', "m/44'/5063758'/1000'/0'").secret;
    expect(bytesToHex(deriveSyncSecretKey(PHRASE_A))).toBe(bytesToHex(expected));
  });

  it('pins the public key of a known phrase', () => {
    expect(syncPublicKeyHex(deriveSyncSecretKey(PHRASE_A))).toBe(PHRASE_A_SYNC_PUBLIC_KEY);
  });

  it('differs from the account branch label and from other paths', () => {
    const seed = mnemonicToSeed(PHRASE_A);
    const sync = bytesToHex(deriveSyncSecretKey(PHRASE_A));
    expect(bytesToHex(deriveHardenedPath(seed, 'miden seed', SYNC_KEY_PATH).secret)).not.toBe(sync);
    expect(bytesToHex(deriveHardenedPath(seed, SYNC_KEY_LABEL, "m/44'/5063758'/1000'/1'").secret)).not.toBe(sync);
    expect(bytesToHex(deriveSyncSecretKey(PHRASE_B))).not.toBe(sync);
  });

  it('gives a 33-byte compressed public key in lowercase hex', () => {
    const publicKey = syncPublicKeyHex(deriveSyncSecretKey(PHRASE_B));
    expect(publicKey).toMatch(/^0[23][0-9a-f]{64}$/);
  });

  it('refuses a derived value that is not a secp256k1 scalar and zeroes it', async () => {
    const zero = new Uint8Array(32);
    const chainCode = new Uint8Array(32).fill(7);
    const seed = new Uint8Array(64).fill(9);
    await jest.isolateModulesAsync(async () => {
      jest.doMock('@miden/hd-key', () => ({
        mnemonicToSeed: () => seed,
        deriveHardenedPath: () => ({ secret: zero, chainCode })
      }));
      const isolated = await import('./sync-key');
      expect(() => isolated.deriveSyncSecretKey(PHRASE_A)).toThrow('not a secp256k1 secret key');
    });
    expect(seed.every(byte => byte === 0)).toBe(true);
    expect(chainCode.every(byte => byte === 0)).toBe(true);
  });
});

describe('isValidSyncSecretKey', () => {
  it.each([
    ['zero', new Uint8Array(32), false],
    ['the curve order', scalarBytes(CURVE_ORDER), false],
    ['31 bytes', new Uint8Array(31).fill(1), false],
    ['one', scalarBytes(1n), true],
    ['the curve order minus one', scalarBytes(CURVE_ORDER - 1n), true]
  ])('gives %s → %s', (_name, secret, expected) => {
    expect(isValidSyncSecretKey(secret)).toBe(expected);
  });
});

describe('signSyncMessage', () => {
  const secret = deriveSyncSecretKey(PHRASE_A);

  it('gives the same 64 bytes for the same key and message', () => {
    const first = signSyncMessage(secret, storageKeyMessage('profile-1'));
    const second = signSyncMessage(secret, storageKeyMessage('profile-1'));
    expect(first).toHaveLength(64);
    expect(bytesToHex(first)).toBe(bytesToHex(second));
    expect(bytesToHex(signSyncMessage(secret, storageKeyMessage('profile-2')))).not.toBe(bytesToHex(first));
  });

  it('is a low-S ECDSA signature over the SHA-256 of the message', () => {
    const message = syncLoginMessage('ab'.repeat(32), PHRASE_A_SYNC_PUBLIC_KEY);
    const signature = signSyncMessage(secret, message);
    const digest = sha256(utf8ToBytes(message));
    expect(secp256k1.verify(signature, digest, hexToBytes(PHRASE_A_SYNC_PUBLIC_KEY))).toBe(true);
    expect(secp256k1.Signature.fromCompact(signature).hasHighS()).toBe(false);
  });
});

describe('sync messages', () => {
  it('formats the login and storage-key messages', () => {
    expect(syncLoginMessage('n0nce', 'pk')).toBe('miden-sync:login:n0nce:pk');
    expect(storageKeyMessage('5f1c-uuid')).toBe('miden-sync:storage-key:5f1c-uuid');
  });
});
