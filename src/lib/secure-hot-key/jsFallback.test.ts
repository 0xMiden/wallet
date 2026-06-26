import * as jsFallback from './jsFallback';

const mockEcdsaWithRNG = jest.fn();
const mockDeserialize = jest.fn();
const mockWordFromHex = jest.fn();
jest.mock('@miden-sdk/miden-sdk/lazy', () => ({
  AuthSecretKey: {
    ecdsaWithRNG: (seed: Uint8Array) => mockEcdsaWithRNG(seed),
    deserialize: (bytes: Uint8Array) => mockDeserialize(bytes)
  },
  Word: {
    fromHex: (hex: string) => mockWordFromHex(hex)
  }
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('secure-hot-key jsFallback', () => {
  it('generates an ECDSA hot key and returns ciphertext, public key, and commitment hex', async () => {
    const randomSpy = jest.spyOn(crypto, 'getRandomValues').mockImplementation(array => {
      (array as Uint8Array).fill(0x7a);
      return array;
    });
    const publicKey = {
      serialize: jest.fn(() => new Uint8Array([0x01, 0x02, ...new Array(32).fill(0xab)])),
      toCommitment: jest.fn(() => ({ toHex: () => '0xcommitment' }))
    };
    const sk = {
      serialize: jest.fn(() => new Uint8Array([0x01, ...new Array(32).fill(0xcd)])),
      publicKey: jest.fn(() => publicKey)
    };
    mockEcdsaWithRNG.mockReturnValue(sk);

    try {
      const generated = await jsFallback.generateHotKey();

      expect(mockEcdsaWithRNG).toHaveBeenCalledWith(new Uint8Array(32).fill(0x7a));
      expect(generated).toEqual({
        ciphertext: `01${'cd'.repeat(32)}`,
        publicKeyHex: `02${'ab'.repeat(32)}`,
        commitmentHex: '0xcommitment'
      });
      expect(sk.publicKey).toHaveBeenCalledTimes(1);
      expect(publicKey.toCommitment).toHaveBeenCalledTimes(1);
    } finally {
      randomSpy.mockRestore();
    }
  });

  it('signs a word using a serialized AuthSecretKey ciphertext', async () => {
    const word = { tag: 'word' };
    const signature = {
      serialize: jest.fn(() => new Uint8Array([0x01, 0x11, 0x22, 0x33]))
    };
    const sk = {
      sign: jest.fn(() => signature)
    };
    mockDeserialize.mockReturnValue(sk);
    mockWordFromHex.mockReturnValue(word);

    const signatureHex = await jsFallback.signHotDigest('0a0b0c', '0xword');

    expect(mockDeserialize).toHaveBeenCalledWith(new Uint8Array([0x0a, 0x0b, 0x0c]));
    expect(mockWordFromHex).toHaveBeenCalledWith('0xword');
    expect(sk.sign).toHaveBeenCalledWith(word);
    expect(signatureHex).toBe('0x112233');
  });

  it('deleteHotKey is a no-op for the JS fallback', async () => {
    await expect(jsFallback.deleteHotKey('serialized-key')).resolves.toBeUndefined();
  });

  it('reveals the raw secret key bytes without the serialized scheme prefix', async () => {
    mockDeserialize.mockReturnValue({
      serialize: jest.fn(() => new Uint8Array([0x01, ...new Array(32).fill(0xef)]))
    });

    const secret = await jsFallback.revealHotKey('010203');

    expect(mockDeserialize).toHaveBeenCalledWith(new Uint8Array([0x01, 0x02, 0x03]));
    expect(secret).toBe('ef'.repeat(32));
  });
});
