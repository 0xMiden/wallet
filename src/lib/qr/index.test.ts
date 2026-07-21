import { isMobile, isAndroid } from 'lib/platform';

import type { ScanResult } from './index';

/**
 * `src/lib/qr/index.ts` is a barrel that re-exports the QR public API from
 * `./format` (encode/decode/validate) and `./scanner` (scan/availability/
 * permission). Importing the barrel runs `./scanner`, whose module body calls
 * `registerPlugin('BarcodeScanner')` at load time, so `@capacitor/core` and the
 * Android npm package must be mocked exactly as the sibling `scanner.test.ts`
 * does. `lib/platform` is mocked so the scanner branches are steerable.
 *
 * The module is loaded via a dynamic `import()` (see `loadQr`) rather than a
 * static top-level import: `registerPlugin` executes at module-load time, so a
 * static import would run the scanner body before the `mock*` consts below are
 * initialised (temporal dead zone). Deferring the import — the same pattern the
 * sibling `scanner.test.ts` uses — keeps the mock objects ready first.
 */

const mockBarcodeScanner = { scan: jest.fn() };
const mockAndroidScanner = { scan: jest.fn() };

jest.mock('@capacitor/core', () => ({
  registerPlugin: () => mockBarcodeScanner
}));

jest.mock('capacitor-barcode-scanner', () => ({
  BarcodeScanner: mockAndroidScanner
}));

jest.mock('lib/platform', () => ({
  isMobile: jest.fn(),
  isAndroid: jest.fn()
}));

const mockIsMobile = isMobile as jest.MockedFunction<typeof isMobile>;
const mockIsAndroid = isAndroid as jest.MockedFunction<typeof isAndroid>;

// A syntactically valid Miden testnet address (starts with mtst1, length in range).
const VALID_ADDRESS = 'mtst1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5qruqqypuyph';

/** Load the barrel under test. Cached after first import, so scanner's
 *  `registerPlugin` runs exactly once. */
async function loadQr() {
  return import('./index');
}

describe('qr/index barrel', () => {
  beforeEach(() => {
    mockIsMobile.mockReset();
    mockIsAndroid.mockReset();
    mockBarcodeScanner.scan.mockReset();
    mockAndroidScanner.scan.mockReset();
  });

  describe('exports surface', () => {
    it('re-exports every public symbol as a function', async () => {
      const qr = await loadQr();
      expect(typeof qr.encodeAddress).toBe('function');
      expect(typeof qr.decodeAddress).toBe('function');
      expect(typeof qr.isValidMidenAddress).toBe('function');
      expect(typeof qr.scanQRCode).toBe('function');
      expect(typeof qr.isScanAvailable).toBe('function');
      expect(typeof qr.checkCameraPermission).toBe('function');
    });

    it('re-exports the same implementations as the underlying modules', async () => {
      const qr = await loadQr();
      const format = await import('./format');
      const scanner = await import('./scanner');
      expect(qr.encodeAddress).toBe(format.encodeAddress);
      expect(qr.decodeAddress).toBe(format.decodeAddress);
      expect(qr.isValidMidenAddress).toBe(format.isValidMidenAddress);
      expect(qr.scanQRCode).toBe(scanner.scanQRCode);
      expect(qr.isScanAvailable).toBe(scanner.isScanAvailable);
      expect(qr.checkCameraPermission).toBe(scanner.checkCameraPermission);
    });
  });

  describe('re-exported format helpers behave correctly', () => {
    it('encodeAddress adds the miden: prefix', async () => {
      const { encodeAddress } = await loadQr();
      expect(encodeAddress(VALID_ADDRESS)).toBe(`miden:${VALID_ADDRESS}`);
    });

    it('decodeAddress strips the miden: prefix', async () => {
      const { decodeAddress } = await loadQr();
      expect(decodeAddress(`miden:${VALID_ADDRESS}`)).toBe(VALID_ADDRESS);
    });

    it('isValidMidenAddress accepts a valid address and rejects junk', async () => {
      const { isValidMidenAddress } = await loadQr();
      expect(isValidMidenAddress(VALID_ADDRESS)).toBe(true);
      expect(isValidMidenAddress('not-a-miden-address')).toBe(false);
    });
  });

  describe('re-exported scanner helpers are wired through', () => {
    it('isScanAvailable reflects platform mobility', async () => {
      const { isScanAvailable } = await loadQr();
      mockIsMobile.mockReturnValue(true);
      expect(isScanAvailable()).toBe(true);
      mockIsMobile.mockReturnValue(false);
      expect(isScanAvailable()).toBe(false);
    });

    it('checkCameraPermission resolves the mobile flag', async () => {
      const { checkCameraPermission } = await loadQr();
      mockIsMobile.mockReturnValue(true);
      await expect(checkCameraPermission()).resolves.toBe(true);
    });

    it('scanQRCode returns a typed success ScanResult on a valid iOS scan', async () => {
      const { scanQRCode } = await loadQr();
      mockIsMobile.mockReturnValue(true);
      mockIsAndroid.mockReturnValue(false);
      mockBarcodeScanner.scan.mockResolvedValue({ barcode: `miden:${VALID_ADDRESS}` });

      const result: ScanResult = await scanQRCode();
      expect(result).toEqual({ success: true, address: VALID_ADDRESS });
    });

    it('scanQRCode short-circuits off mobile', async () => {
      const { scanQRCode } = await loadQr();
      mockIsMobile.mockReturnValue(false);
      await expect(scanQRCode()).resolves.toEqual({ success: false, errorKey: 'noQrCodeFound' });
    });
  });
});
