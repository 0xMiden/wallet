import { isMobile, isAndroid, isExtension } from 'lib/platform';

/**
 * The iOS native plugin handle returned by `registerPlugin('BarcodeScanner')`.
 * `registerPlugin` runs at module load, so this object is captured by the
 * `@capacitor/core` mock factory and reused as the plugin instance.
 */
const mockBarcodeScanner = { scan: jest.fn() };

/** The Android npm-package scanner reached via `import('capacitor-barcode-scanner')`. */
const mockAndroidScanner = { scan: jest.fn() };

const mockRegisterPlugin = jest.fn((_name: string) => mockBarcodeScanner);

jest.mock('@capacitor/core', () => ({
  registerPlugin: (name: string) => mockRegisterPlugin(name)
}));

jest.mock('capacitor-barcode-scanner', () => ({
  BarcodeScanner: mockAndroidScanner
}));

jest.mock('lib/platform', () => ({
  isMobile: jest.fn(),
  isAndroid: jest.fn(),
  isExtension: jest.fn()
}));

// Uses the REAL ./format module (decodeAddress + isValidMidenAddress) so the
// success/validation branches exercise genuine parsing behaviour.

const mockIsMobile = isMobile as jest.MockedFunction<typeof isMobile>;
const mockIsAndroid = isAndroid as jest.MockedFunction<typeof isAndroid>;
const mockIsExtension = isExtension as jest.MockedFunction<typeof isExtension>;

// A syntactically valid Miden testnet address (starts with mtst1, length in range).
const VALID_ADDRESS = 'mtst1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5qruqqypuyph';

/** Load the module under test. It is cached, so `registerPlugin` runs exactly once. */
async function loadScanner() {
  return import('./scanner');
}

describe('qr/scanner', () => {
  beforeEach(() => {
    // Reset only the per-test mocks; leave `mockRegisterPlugin`'s call record
    // intact since the plugin is registered exactly once (on first import).
    mockIsMobile.mockReset();
    mockIsAndroid.mockReset();
    mockIsExtension.mockReset();
    mockBarcodeScanner.scan.mockReset();
    mockAndroidScanner.scan.mockReset();
    // The webcam path is feature-detected off `window.BarcodeDetector`; clear it
    // between tests so each case controls its own availability.
    delete (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector;
  });

  describe('module registration', () => {
    it('registers the native BarcodeScanner plugin on load', async () => {
      await loadScanner();
      expect(mockRegisterPlugin).toHaveBeenCalledWith('BarcodeScanner');
    });
  });

  describe('isScanAvailable', () => {
    it('returns true on mobile (native barcode plugin)', async () => {
      mockIsMobile.mockReturnValue(true);
      const { isScanAvailable } = await loadScanner();
      expect(isScanAvailable()).toBe(true);
    });

    it('returns false off mobile when not an extension', async () => {
      mockIsMobile.mockReturnValue(false);
      mockIsExtension.mockReturnValue(false);
      const { isScanAvailable } = await loadScanner();
      expect(isScanAvailable()).toBe(false);
    });

    it('returns true in the extension when window.BarcodeDetector is available', async () => {
      mockIsMobile.mockReturnValue(false);
      mockIsExtension.mockReturnValue(true);
      (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector = function () {};
      const { isScanAvailable } = await loadScanner();
      expect(isScanAvailable()).toBe(true);
    });

    it('returns false in the extension when window.BarcodeDetector is missing', async () => {
      mockIsMobile.mockReturnValue(false);
      mockIsExtension.mockReturnValue(true);
      // No window.BarcodeDetector (cleared in beforeEach) -> webcam scan unavailable.
      const { isScanAvailable } = await loadScanner();
      expect(isScanAvailable()).toBe(false);
    });
  });

  describe('isExtensionWebcamScanAvailable', () => {
    it('is false when not an extension even if BarcodeDetector exists', async () => {
      mockIsExtension.mockReturnValue(false);
      (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector = function () {};
      const { isExtensionWebcamScanAvailable } = await loadScanner();
      expect(isExtensionWebcamScanAvailable()).toBe(false);
    });

    it('is true in the extension with BarcodeDetector present', async () => {
      mockIsExtension.mockReturnValue(true);
      (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector = function () {};
      const { isExtensionWebcamScanAvailable } = await loadScanner();
      expect(isExtensionWebcamScanAvailable()).toBe(true);
    });
  });

  describe('checkCameraPermission', () => {
    it('resolves true on mobile', async () => {
      mockIsMobile.mockReturnValue(true);
      const { checkCameraPermission } = await loadScanner();
      await expect(checkCameraPermission()).resolves.toBe(true);
    });

    it('resolves false off mobile', async () => {
      mockIsMobile.mockReturnValue(false);
      const { checkCameraPermission } = await loadScanner();
      await expect(checkCameraPermission()).resolves.toBe(false);
    });
  });

  describe('scanQRCode - platform gating', () => {
    it('returns noQrCodeFound when not on mobile', async () => {
      mockIsMobile.mockReturnValue(false);
      const { scanQRCode } = await loadScanner();

      await expect(scanQRCode()).resolves.toEqual({ success: false, errorKey: 'noQrCodeFound' });
      // Neither native path should be touched.
      expect(mockBarcodeScanner.scan).not.toHaveBeenCalled();
      expect(mockAndroidScanner.scan).not.toHaveBeenCalled();
    });
  });

  describe('scanQRCode - iOS native plugin path', () => {
    beforeEach(() => {
      mockIsMobile.mockReturnValue(true);
      mockIsAndroid.mockReturnValue(false);
    });

    it('returns the scanned address on success (plain address)', async () => {
      mockBarcodeScanner.scan.mockResolvedValue({ barcode: VALID_ADDRESS });
      const { scanQRCode } = await loadScanner();

      await expect(scanQRCode()).resolves.toEqual({ success: true, address: VALID_ADDRESS });
      expect(mockBarcodeScanner.scan).toHaveBeenCalledTimes(1);
      expect(mockAndroidScanner.scan).not.toHaveBeenCalled();
    });

    it('strips the miden: URI prefix before returning the address', async () => {
      mockBarcodeScanner.scan.mockResolvedValue({ barcode: `miden:${VALID_ADDRESS}` });
      const { scanQRCode } = await loadScanner();

      await expect(scanQRCode()).resolves.toEqual({ success: true, address: VALID_ADDRESS });
    });

    it('returns noQrCodeFound when the barcode is empty', async () => {
      mockBarcodeScanner.scan.mockResolvedValue({ barcode: '' });
      const { scanQRCode } = await loadScanner();

      await expect(scanQRCode()).resolves.toEqual({ success: false, errorKey: 'noQrCodeFound' });
    });

    it('returns invalidMidenAddress when the decoded value is not a Miden address', async () => {
      mockBarcodeScanner.scan.mockResolvedValue({ barcode: 'not-a-miden-address' });
      const { scanQRCode } = await loadScanner();

      await expect(scanQRCode()).resolves.toEqual({ success: false, errorKey: 'invalidMidenAddress' });
    });
  });

  describe('scanQRCode - Android npm-package path', () => {
    beforeEach(() => {
      mockIsMobile.mockReturnValue(true);
      mockIsAndroid.mockReturnValue(true);
    });

    it('returns the scanned address on success', async () => {
      mockAndroidScanner.scan.mockResolvedValue({ result: true, code: VALID_ADDRESS });
      const { scanQRCode } = await loadScanner();

      await expect(scanQRCode()).resolves.toEqual({ success: true, address: VALID_ADDRESS });
      expect(mockAndroidScanner.scan).toHaveBeenCalledTimes(1);
      expect(mockBarcodeScanner.scan).not.toHaveBeenCalled();
    });

    it('returns noQrCodeFound when no code is present (code defaults to empty string)', async () => {
      // No `code` field -> `result.code || ''` yields '' -> noQrCodeFound.
      mockAndroidScanner.scan.mockResolvedValue({ result: false });
      const { scanQRCode } = await loadScanner();

      await expect(scanQRCode()).resolves.toEqual({ success: false, errorKey: 'noQrCodeFound' });
    });

    it('returns invalidMidenAddress for a non-Miden code', async () => {
      mockAndroidScanner.scan.mockResolvedValue({ result: true, code: 'eth1abc123def456' });
      const { scanQRCode } = await loadScanner();

      await expect(scanQRCode()).resolves.toEqual({ success: false, errorKey: 'invalidMidenAddress' });
    });
  });

  describe('scanQRCode - error handling (iOS path)', () => {
    beforeEach(() => {
      mockIsMobile.mockReturnValue(true);
      mockIsAndroid.mockReturnValue(false);
    });

    it('maps a lowercase "cancel" message to scanCancelled', async () => {
      mockBarcodeScanner.scan.mockRejectedValue(new Error('User cancelled the scan'));
      const { scanQRCode } = await loadScanner();

      await expect(scanQRCode()).resolves.toEqual({ success: false, errorKey: 'scanCancelled' });
    });

    it('maps a "dismissed" message to scanCancelled', async () => {
      mockBarcodeScanner.scan.mockRejectedValue(new Error('Scanner was dismissed'));
      const { scanQRCode } = await loadScanner();

      await expect(scanQRCode()).resolves.toEqual({ success: false, errorKey: 'scanCancelled' });
    });

    it('maps a capitalized "Cancel" message to scanCancelled', async () => {
      // 'Cancel' does not contain lowercase 'cancel' or 'dismissed', so this
      // exercises the third operand of the cancellation check specifically.
      mockBarcodeScanner.scan.mockRejectedValue(new Error('Cancel'));
      const { scanQRCode } = await loadScanner();

      await expect(scanQRCode()).resolves.toEqual({ success: false, errorKey: 'scanCancelled' });
    });

    it('maps a "permission" message to cameraPermissionDenied', async () => {
      mockBarcodeScanner.scan.mockRejectedValue(new Error('Camera permission required'));
      const { scanQRCode } = await loadScanner();

      await expect(scanQRCode()).resolves.toEqual({ success: false, errorKey: 'cameraPermissionDenied' });
    });

    it('maps a "denied" message to cameraPermissionDenied', async () => {
      // No 'permission' substring, so this exercises the second operand.
      mockBarcodeScanner.scan.mockRejectedValue(new Error('Access denied'));
      const { scanQRCode } = await loadScanner();

      await expect(scanQRCode()).resolves.toEqual({ success: false, errorKey: 'cameraPermissionDenied' });
    });

    it('maps an unrecognized Error to smthWentWrong', async () => {
      mockBarcodeScanner.scan.mockRejectedValue(new Error('kaboom'));
      const { scanQRCode } = await loadScanner();

      await expect(scanQRCode()).resolves.toEqual({ success: false, errorKey: 'smthWentWrong' });
    });

    it('maps a non-Error rejection to smthWentWrong (Unknown error path)', async () => {
      // Rejecting with a non-Error hits the `? :` false branch -> message = 'Unknown error'.
      mockBarcodeScanner.scan.mockRejectedValue('a bare string failure');
      const { scanQRCode } = await loadScanner();

      await expect(scanQRCode()).resolves.toEqual({ success: false, errorKey: 'smthWentWrong' });
    });
  });
});
