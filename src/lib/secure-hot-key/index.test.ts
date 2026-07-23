import * as secureHotKey from './index';

const mockIsMobile = jest.fn();
jest.mock('lib/platform', () => ({
  isMobile: () => mockIsMobile()
}));

const mockJsGenerateHotKey = jest.fn();
const mockJsSignHotDigest = jest.fn();
const mockJsDeleteHotKey = jest.fn();
const mockJsRevealHotKey = jest.fn();
jest.mock('./jsFallback', () => ({
  generateHotKey: () => mockJsGenerateHotKey(),
  signHotDigest: (ciphertext: string, wordHex: string) => mockJsSignHotDigest(ciphertext, wordHex),
  deleteHotKey: (ciphertext: string) => mockJsDeleteHotKey(ciphertext),
  revealHotKey: (ciphertext: string) => mockJsRevealHotKey(ciphertext)
}));

const mockNativeGenerateHotKey = jest.fn();
const mockNativeSignHotDigest = jest.fn();
const mockNativeDeleteHotKey = jest.fn();
const mockNativeRevealHotKey = jest.fn();
jest.mock('./nativePlugin', () => ({
  generateHotKey: () => mockNativeGenerateHotKey(),
  signHotDigest: (ciphertext: string, wordHex: string) => mockNativeSignHotDigest(ciphertext, wordHex),
  deleteHotKey: (ciphertext: string) => mockNativeDeleteHotKey(ciphertext),
  revealHotKey: (ciphertext: string) => mockNativeRevealHotKey(ciphertext)
}));

beforeEach(() => {
  jest.clearAllMocks();
});

describe('secure-hot-key facade', () => {
  it('routes every operation to the JS fallback off mobile', async () => {
    mockIsMobile.mockReturnValue(false);
    mockJsGenerateHotKey.mockResolvedValue({
      ciphertext: 'js-ciphertext',
      publicKeyHex: 'js-public',
      commitmentHex: 'js-commitment'
    });
    mockJsSignHotDigest.mockResolvedValue('0xjs-signature');
    mockJsDeleteHotKey.mockResolvedValue(undefined);
    mockJsRevealHotKey.mockResolvedValue('js-secret');

    await expect(secureHotKey.generateHotKey()).resolves.toEqual({
      ciphertext: 'js-ciphertext',
      publicKeyHex: 'js-public',
      commitmentHex: 'js-commitment'
    });
    await expect(secureHotKey.signHotDigest('js-ciphertext', '0xword')).resolves.toBe('0xjs-signature');
    await expect(secureHotKey.deleteHotKey('js-ciphertext')).resolves.toBeUndefined();
    await expect(secureHotKey.revealHotKey('js-ciphertext')).resolves.toBe('js-secret');

    expect(mockJsGenerateHotKey).toHaveBeenCalledTimes(1);
    expect(mockJsSignHotDigest).toHaveBeenCalledWith('js-ciphertext', '0xword');
    expect(mockJsDeleteHotKey).toHaveBeenCalledWith('js-ciphertext');
    expect(mockJsRevealHotKey).toHaveBeenCalledWith('js-ciphertext');
    expect(mockNativeGenerateHotKey).not.toHaveBeenCalled();
    expect(mockNativeSignHotDigest).not.toHaveBeenCalled();
    expect(mockNativeDeleteHotKey).not.toHaveBeenCalled();
    expect(mockNativeRevealHotKey).not.toHaveBeenCalled();
  });

  it('routes every operation to the native plugin on mobile', async () => {
    mockIsMobile.mockReturnValue(true);
    // Native ciphertexts are "<b64-tag>:<b64-payload>" — the ':' is what the
    // per-blob router keys off.
    const nativeCiphertext = 'dGFn:cGF5bG9hZA==';
    mockNativeGenerateHotKey.mockResolvedValue({
      ciphertext: nativeCiphertext,
      publicKeyHex: 'native-public',
      commitmentHex: 'native-commitment'
    });
    mockNativeSignHotDigest.mockResolvedValue('0xnative-signature');
    mockNativeDeleteHotKey.mockResolvedValue(undefined);
    mockNativeRevealHotKey.mockResolvedValue('native-secret');

    await expect(secureHotKey.generateHotKey()).resolves.toEqual({
      ciphertext: nativeCiphertext,
      publicKeyHex: 'native-public',
      commitmentHex: 'native-commitment'
    });
    await expect(secureHotKey.signHotDigest(nativeCiphertext, '0xword')).resolves.toBe('0xnative-signature');
    await expect(secureHotKey.deleteHotKey(nativeCiphertext)).resolves.toBeUndefined();
    await expect(secureHotKey.revealHotKey(nativeCiphertext)).resolves.toBe('native-secret');

    expect(mockNativeGenerateHotKey).toHaveBeenCalledTimes(1);
    expect(mockNativeSignHotDigest).toHaveBeenCalledWith(nativeCiphertext, '0xword');
    expect(mockNativeDeleteHotKey).toHaveBeenCalledWith(nativeCiphertext);
    expect(mockNativeRevealHotKey).toHaveBeenCalledWith(nativeCiphertext);
    expect(mockJsGenerateHotKey).not.toHaveBeenCalled();
    expect(mockJsSignHotDigest).not.toHaveBeenCalled();
    expect(mockJsDeleteHotKey).not.toHaveBeenCalled();
    expect(mockJsRevealHotKey).not.toHaveBeenCalled();
  });

  it('falls back to the JS implementation when generate rejects with HARDWARE_UNAVAILABLE on mobile', async () => {
    mockIsMobile.mockReturnValue(true);
    mockNativeGenerateHotKey.mockRejectedValue(
      Object.assign(new Error('Secure hardware unavailable'), { code: 'HARDWARE_UNAVAILABLE' })
    );
    mockJsGenerateHotKey.mockResolvedValue({
      ciphertext: 'deadbeef',
      publicKeyHex: 'js-public',
      commitmentHex: 'js-commitment'
    });

    await expect(secureHotKey.generateHotKey()).resolves.toEqual({
      ciphertext: 'deadbeef',
      publicKeyHex: 'js-public',
      commitmentHex: 'js-commitment'
    });
    expect(mockNativeGenerateHotKey).toHaveBeenCalledTimes(1);
    expect(mockJsGenerateHotKey).toHaveBeenCalledTimes(1);
  });

  it('re-throws other native generate errors without falling back', async () => {
    mockIsMobile.mockReturnValue(true);
    mockNativeGenerateHotKey.mockRejectedValue(
      Object.assign(new Error('Hot key not accessible while device is locked'), { code: 'DEVICE_LOCKED' })
    );

    await expect(secureHotKey.generateHotKey()).rejects.toThrow('device is locked');
    expect(mockJsGenerateHotKey).not.toHaveBeenCalled();
  });

  it('routes per-key operations by blob format on mobile (JS-fallback key stays JS)', async () => {
    mockIsMobile.mockReturnValue(true);
    mockJsSignHotDigest.mockResolvedValue('0xjs-signature');
    mockJsDeleteHotKey.mockResolvedValue(undefined);
    mockJsRevealHotKey.mockResolvedValue('js-secret');

    // Hex blob (no ':') = minted via the JS fallback — must not hit native.
    await expect(secureHotKey.signHotDigest('deadbeef', '0xword')).resolves.toBe('0xjs-signature');
    await expect(secureHotKey.deleteHotKey('deadbeef')).resolves.toBeUndefined();
    await expect(secureHotKey.revealHotKey('deadbeef')).resolves.toBe('js-secret');

    expect(mockJsSignHotDigest).toHaveBeenCalledWith('deadbeef', '0xword');
    expect(mockNativeSignHotDigest).not.toHaveBeenCalled();
    expect(mockNativeDeleteHotKey).not.toHaveBeenCalled();
    expect(mockNativeRevealHotKey).not.toHaveBeenCalled();
  });
});
