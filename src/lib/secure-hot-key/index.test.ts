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

const mockReportHotKeyHardwareFailure = jest.fn();
jest.mock('lib/wallet-prompts', () => ({
  reportHotKeyHardwareFailure: (message: string) => mockReportHotKeyHardwareFailure(message)
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
    mockNativeGenerateHotKey.mockResolvedValue({
      ciphertext: 'native-ciphertext',
      publicKeyHex: 'native-public',
      commitmentHex: 'native-commitment'
    });
    mockNativeSignHotDigest.mockResolvedValue('0xnative-signature');
    mockNativeDeleteHotKey.mockResolvedValue(undefined);
    mockNativeRevealHotKey.mockResolvedValue('native-secret');

    await expect(secureHotKey.generateHotKey()).resolves.toEqual({
      ciphertext: 'native-ciphertext',
      publicKeyHex: 'native-public',
      commitmentHex: 'native-commitment'
    });
    await expect(secureHotKey.signHotDigest('native-ciphertext', '0xword')).resolves.toBe('0xnative-signature');
    await expect(secureHotKey.deleteHotKey('native-ciphertext')).resolves.toBeUndefined();
    await expect(secureHotKey.revealHotKey('native-ciphertext')).resolves.toBe('native-secret');

    expect(mockNativeGenerateHotKey).toHaveBeenCalledTimes(1);
    expect(mockNativeSignHotDigest).toHaveBeenCalledWith('native-ciphertext', '0xword');
    expect(mockNativeDeleteHotKey).toHaveBeenCalledWith('native-ciphertext');
    expect(mockNativeRevealHotKey).toHaveBeenCalledWith('native-ciphertext');
    expect(mockJsGenerateHotKey).not.toHaveBeenCalled();
    expect(mockJsSignHotDigest).not.toHaveBeenCalled();
    expect(mockJsDeleteHotKey).not.toHaveBeenCalled();
    expect(mockJsRevealHotKey).not.toHaveBeenCalled();
  });

  it('surfaces the report prompt (with code prefix) for any native op failure on mobile', async () => {
    mockIsMobile.mockReturnValue(true);
    mockReportHotKeyHardwareFailure.mockResolvedValue(undefined);
    const hardwareError = Object.assign(new Error('Secure hardware unavailable: INCOMPATIBLE_MGF_DIGEST'), {
      code: 'HARDWARE_UNAVAILABLE'
    });
    mockNativeSignHotDigest.mockRejectedValue(hardwareError);

    await expect(secureHotKey.signHotDigest('native-ciphertext', '0xword')).rejects.toBe(hardwareError);

    expect(mockReportHotKeyHardwareFailure).toHaveBeenCalledWith(
      '[HARDWARE_UNAVAILABLE] Secure hardware unavailable: INCOMPATIBLE_MGF_DIGEST'
    );
  });

  it('surfaces the report prompt for a code-less native failure on mobile', async () => {
    mockIsMobile.mockReturnValue(true);
    mockReportHotKeyHardwareFailure.mockResolvedValue(undefined);
    const plainError = new Error('Hot-key sign failed: something odd');
    mockNativeSignHotDigest.mockRejectedValue(plainError);

    await expect(secureHotKey.signHotDigest('native-ciphertext', '0xword')).rejects.toBe(plainError);

    expect(mockReportHotKeyHardwareFailure).toHaveBeenCalledWith('Hot-key sign failed: something odd');
  });

  it('does not surface the report prompt for failures off mobile (JS fallback path)', async () => {
    mockIsMobile.mockReturnValue(false);
    const error = Object.assign(new Error('nope'), { code: 'HARDWARE_UNAVAILABLE' });
    mockJsSignHotDigest.mockRejectedValue(error);

    await expect(secureHotKey.signHotDigest('js-ciphertext', '0xword')).rejects.toBe(error);

    expect(mockReportHotKeyHardwareFailure).not.toHaveBeenCalled();
  });
});
