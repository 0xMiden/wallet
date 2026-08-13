/**
 * Webcam QR decoding core for the browser extension.
 *
 * This is the DOM-light, React-free half of the extension's webcam scanner:
 * it builds a native `BarcodeDetector` and turns a single decoded video frame
 * into a `ScanResult`. The camera lifecycle (getUserMedia, the decode loop and
 * teardown) lives in the `ScanQrDrawer` component; this module is what that
 * loop calls on every frame, and is unit-testable in isolation.
 *
 * Mobile keeps its native barcode plugin (see ./scanner) — this path is
 * extension-only.
 */

import { decodeAddress, isValidMidenAddress } from './format';
import type { ScanResult } from './scanner';

export type { ScanResult };

/**
 * Structural stand-in for the native `BarcodeDetector` — just the `detect`
 * method the decode loop calls. Keeps callers decoupled from the global type
 * and trivially mockable in tests.
 */
export interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
}

/**
 * Build a QR-only `BarcodeDetector`, or `null` when the API is unavailable
 * (non-Chromium browsers, or any context without `window`). Callers should gate
 * on `isExtensionWebcamScanAvailable()` first; this is the belt-and-braces guard.
 */
export function createQrDetector(): BarcodeDetectorLike | null {
  if (typeof window === 'undefined' || !('BarcodeDetector' in window)) {
    return null;
  }
  return new window.BarcodeDetector({ formats: ['qr_code'] });
}

/**
 * Decode a single video frame and map it to a `ScanResult`.
 *
 * @returns
 *  - `{ success: true, address }` when the frame holds a valid Miden address QR
 *    (the `miden:` URI prefix is stripped, and a wrong-network address still
 *    passes so the send screen can surface its specific message).
 *  - `{ success: false, errorKey: 'invalidMidenAddress' }` when a QR decodes
 *    but is not a Miden address.
 *  - `null` when there is no code in the frame, or when `detect()` throws — both
 *    are non-fatal, so the caller keeps polling subsequent frames.
 */
export async function detectAddressFromFrame(
  detector: BarcodeDetectorLike,
  videoEl: HTMLVideoElement
): Promise<ScanResult | null> {
  let barcodes: Array<{ rawValue: string }>;
  try {
    barcodes = await detector.detect(videoEl);
  } catch {
    // A transient decode failure (e.g. the frame isn't ready) must not kill the
    // loop — keep scanning.
    return null;
  }

  const first = barcodes[0];
  if (!first) {
    // No QR in this frame; keep polling.
    return null;
  }

  const address = decodeAddress(first.rawValue);
  if (!isValidMidenAddress(address)) {
    return { success: false, errorKey: 'invalidMidenAddress' };
  }

  return { success: true, address };
}
