import { createQrDetector, detectAddressFromFrame, BarcodeDetectorLike } from './webcam-scanner';

/**
 * `webcam-scanner` is the DOM-light core of the extension's webcam QR path: it
 * builds a native `BarcodeDetector` and turns a single decoded frame into a
 * `ScanResult`. These tests mock `window.BarcodeDetector` (jsdom lacks it) but
 * exercise the REAL `./format` decode + validation so the address branches
 * behave exactly as production does.
 */

// A syntactically valid Miden testnet address (same fixture as format.test.ts).
const VALID_ADDRESS = 'mtst1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5qruqqypuyph';

type WindowWithDetector = { BarcodeDetector?: unknown };

const stubVideo = {} as HTMLVideoElement;

/** Build a stand-in detector whose `detect` yields the given barcodes. */
const detectorReturning = (barcodes: Array<{ rawValue: string }>): BarcodeDetectorLike => ({
  detect: jest.fn().mockResolvedValue(barcodes)
});

describe('qr/webcam-scanner', () => {
  afterEach(() => {
    delete (window as unknown as WindowWithDetector).BarcodeDetector;
  });

  describe('createQrDetector', () => {
    it('returns null when window.BarcodeDetector is unavailable', () => {
      delete (window as unknown as WindowWithDetector).BarcodeDetector;
      expect(createQrDetector()).toBeNull();
    });

    it('constructs a BarcodeDetector limited to the qr_code format when available', () => {
      const ctor = jest.fn();
      (window as unknown as WindowWithDetector).BarcodeDetector = class {
        constructor(options: unknown) {
          ctor(options);
        }
        detect = jest.fn();
      };

      const detector = createQrDetector();

      expect(detector).not.toBeNull();
      expect(ctor).toHaveBeenCalledWith({ formats: ['qr_code'] });
    });
  });

  describe('detectAddressFromFrame', () => {
    it('returns success with the address for a valid plain-address QR', async () => {
      const detector = detectorReturning([{ rawValue: VALID_ADDRESS }]);
      await expect(detectAddressFromFrame(detector, stubVideo)).resolves.toEqual({
        success: true,
        address: VALID_ADDRESS
      });
    });

    it('strips the miden: URI prefix before returning the address', async () => {
      const detector = detectorReturning([{ rawValue: `miden:${VALID_ADDRESS}` }]);
      await expect(detectAddressFromFrame(detector, stubVideo)).resolves.toEqual({
        success: true,
        address: VALID_ADDRESS
      });
    });

    it('returns invalidMidenAddress when a QR decodes but is not a Miden address', async () => {
      const detector = detectorReturning([{ rawValue: 'not-an-address' }]);
      await expect(detectAddressFromFrame(detector, stubVideo)).resolves.toEqual({
        success: false,
        errorKey: 'invalidMidenAddress'
      });
    });

    it('returns null when no barcode is present in the frame (keep polling)', async () => {
      const detector = detectorReturning([]);
      await expect(detectAddressFromFrame(detector, stubVideo)).resolves.toBeNull();
    });

    it('returns null (non-fatal) when detect() rejects', async () => {
      const detector: BarcodeDetectorLike = { detect: jest.fn().mockRejectedValue(new Error('detect failed')) };
      await expect(detectAddressFromFrame(detector, stubVideo)).resolves.toBeNull();
    });
  });
});
