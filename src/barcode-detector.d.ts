/**
 * Minimal ambient declaration for the Shape Detection API's `BarcodeDetector`.
 *
 * TypeScript's bundled `lib.dom.d.ts` does not yet ship this interface, and the
 * extension's webcam QR scanner feature-detects and uses it at runtime
 * (`'BarcodeDetector' in window`). We declare only the surface we use — no
 * `@types` dependency — matching the real Web API shape.
 *
 * See: https://developer.mozilla.org/docs/Web/API/BarcodeDetector
 */

interface BarcodeDetectorOptions {
  formats?: string[];
}

interface DetectedBarcode {
  rawValue: string;
}

declare class BarcodeDetector {
  constructor(options?: BarcodeDetectorOptions);
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

interface Window {
  BarcodeDetector: typeof BarcodeDetector;
}
