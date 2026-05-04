/**
 * Wrapper-level test for the iOS native hot-key path. This does NOT validate
 * byte-for-byte ECDSA wire-format parity against the WASM SDK — that gate is
 * the manual on-device run. What we do guard here:
 *  - iOS path forwards generate / sign / delete to the HotKey plugin.
 *  - Android path throws the dedicated Phase 4b sentinel.
 *  - The commitment derivation reframes the publicKey hex with the ECDSA
 *    type prefix (currently hardcoded as 0x01).
 */

const mockGenerateHotKey = jest.fn();
const mockSignWithHotKey = jest.fn();
const mockDeleteHotKey = jest.fn();
jest.mock('./hotKeyPlugin', () => ({
  HotKey: {
    generateHotKey: (...a: unknown[]) => mockGenerateHotKey(...a),
    signWithHotKey: (...a: unknown[]) => mockSignWithHotKey(...a),
    deleteHotKey: (...a: unknown[]) => mockDeleteHotKey(...a)
  }
}));

const mockIsIOS = jest.fn();
const mockIsAndroid = jest.fn();
jest.mock('lib/platform', () => ({
  isIOS: () => mockIsIOS(),
  isAndroid: () => mockIsAndroid()
}));

const publicKeyDeserialize = jest.fn((bytes: Uint8Array) => ({
  toCommitment: () => ({ toHex: () => `0xcommit:${Array.from(bytes).join(',')}` })
}));
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  PublicKey: {
    deserialize: (bytes: Uint8Array) => publicKeyDeserialize(bytes)
  }
}));

import * as nativePlugin from './nativePlugin';

beforeEach(() => {
  jest.clearAllMocks();
  mockIsIOS.mockReturnValue(true);
  mockIsAndroid.mockReturnValue(false);
});

describe('secure-hot-key nativePlugin (iOS)', () => {
  it('generateHotKey forwards to HotKey and frames commitment with the 0x01 type prefix', async () => {
    // Native plugin returns the compressed secp256k1 pubkey: 33 bytes
    // (parity prefix + 32-byte x). The wrapper enforces this length and
    // rejects anything else — see commitmentFromPublicKeyHex.
    const compressedHex = '02' + 'ab'.repeat(32);
    mockGenerateHotKey.mockResolvedValue({
      ciphertext: 'tag:payload',
      publicKeyHex: compressedHex
    });

    const out = await nativePlugin.generateHotKey();

    expect(mockGenerateHotKey).toHaveBeenCalledTimes(1);
    expect(out.ciphertext).toBe('tag:payload');
    expect(out.publicKeyHex).toBe(compressedHex);

    const framed = publicKeyDeserialize.mock.calls[0]?.[0];
    expect(framed).toBeInstanceOf(Uint8Array);
    expect(framed!.length).toBe(34); // 1 type prefix + 33 compressed pubkey
    expect(framed![0]).toBe(1); // type prefix
    expect(framed![1]).toBe(0x02); // first byte of compressed pubkey
    expect(out.commitmentHex).toMatch(/^0xcommit:1,2(,171){32}$/);
  });

  it('generateHotKey rejects when native returns a non-33-byte public key', async () => {
    mockGenerateHotKey.mockResolvedValue({
      ciphertext: 'tag:payload',
      publicKeyHex: 'aabbcc' // only 3 bytes
    });

    await expect(nativePlugin.generateHotKey()).rejects.toThrow('unexpected public key length 3 (expected 33)');
  });

  it('signHotDigest forwards ciphertext + digest and returns the native signatureHex unchanged', async () => {
    mockSignWithHotKey.mockResolvedValue({ signatureHex: '0xdeadbeef' });

    const sig = await nativePlugin.signHotDigest('tag:payload', '0xfeedface');

    expect(mockSignWithHotKey).toHaveBeenCalledWith({
      ciphertext: 'tag:payload',
      digestHex: '0xfeedface'
    });
    expect(sig).toBe('0xdeadbeef');
  });

  it('deleteHotKey forwards ciphertext to HotKey', async () => {
    mockDeleteHotKey.mockResolvedValue(undefined);

    await nativePlugin.deleteHotKey('tag:payload');

    expect(mockDeleteHotKey).toHaveBeenCalledWith({ ciphertext: 'tag:payload' });
  });
});

describe('secure-hot-key nativePlugin (Android)', () => {
  beforeEach(() => {
    mockIsIOS.mockReturnValue(false);
    mockIsAndroid.mockReturnValue(true);
  });

  it.each([
    ['generateHotKey', () => nativePlugin.generateHotKey()],
    ['signHotDigest', () => nativePlugin.signHotDigest('tag:payload', '0x00')],
    ['deleteHotKey', () => nativePlugin.deleteHotKey('tag:payload')]
  ])('%s rejects with the Phase 4b sentinel', async (_name, op) => {
    await expect(op()).rejects.toThrow('Phase 4b');
    expect(mockGenerateHotKey).not.toHaveBeenCalled();
    expect(mockSignWithHotKey).not.toHaveBeenCalled();
    expect(mockDeleteHotKey).not.toHaveBeenCalled();
  });
});
