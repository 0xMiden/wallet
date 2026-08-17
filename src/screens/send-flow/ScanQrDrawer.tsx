import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useTranslation } from 'react-i18next';

import { Loader } from 'components/Loader';
import { createQrDetector, detectAddressFromFrame } from 'lib/qr/webcam-scanner';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from 'lib/ui/drawer';
import useIsMounted from 'lib/ui/useIsMounted';

type ScanState = 'requesting' | 'scanning' | 'permission-denied' | 'no-camera';

export interface ScanQrDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A valid Miden recipient address decoded from a QR code. */
  onDetected: (address: string) => void;
  /** An i18n error key (e.g. a QR that decoded to a non-Miden value). */
  onError: (errorKey: string) => void;
}

/**
 * Extension-only webcam QR scanner (mobile keeps its native barcode plugin).
 *
 * Opens the webcam via `getUserMedia({ video: { facingMode: 'environment' } })`,
 * decodes each frame with the native `BarcodeDetector` (via
 * `detectAddressFromFrame`), and on a valid Miden address stops the camera and
 * hands the address back through `onDetected`.
 *
 * Teardown is load-bearing: every `MediaStreamTrack` is stopped and the frame
 * callback cancelled on close, unmount, and success, so the camera indicator
 * never lingers. Async state updates are guarded by `useIsMounted`, and the
 * camera is never requested while `open` is false.
 */
export const ScanQrDrawer: React.FC<ScanQrDrawerProps> = ({ open, onOpenChange, onDetected, onError }) => {
  const { t } = useTranslation();
  const isMounted = useIsMounted();

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameHandleRef = useRef<number | null>(null);
  // Which scheduler owns the pending handle, so teardown cancels the right one.
  const usingVideoCallbackRef = useRef(false);

  const [scanState, setScanState] = useState<ScanState>('requesting');
  const [invalidScan, setInvalidScan] = useState(false);

  // Full camera teardown: cancel the pending frame callback and stop every
  // track. Idempotent — safe to call from success, close, and unmount.
  const stopCamera = useCallback(() => {
    const video = videoRef.current;
    if (frameHandleRef.current != null) {
      if (usingVideoCallbackRef.current && video) {
        video.cancelVideoFrameCallback(frameHandleRef.current);
      } else {
        cancelAnimationFrame(frameHandleRef.current);
      }
      frameHandleRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (video) {
      video.srcObject = null;
    }
  }, []);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const detector = createQrDetector();
    setScanState('requesting');
    setInvalidScan(false);

    const finishWithAddress = (address: string) => {
      stopCamera();
      onDetected(address);
      onOpenChange(false);
    };

    const scheduleNextFrame = () => {
      const video = videoRef.current;
      if (cancelled || !video) return;
      if (typeof video.requestVideoFrameCallback === 'function') {
        usingVideoCallbackRef.current = true;
        frameHandleRef.current = video.requestVideoFrameCallback(() => {
          void scanFrame();
        });
      } else {
        usingVideoCallbackRef.current = false;
        frameHandleRef.current = requestAnimationFrame(() => {
          void scanFrame();
        });
      }
    };

    const scanFrame = async () => {
      const video = videoRef.current;
      if (cancelled || !detector || !video) return;
      const result = await detectAddressFromFrame(detector, video);
      if (cancelled) return;
      if (result?.success && result.address) {
        finishWithAddress(result.address);
        return;
      }
      // A QR that decoded to a non-Miden value: surface it but keep scanning.
      if (result && !result.success && isMounted()) {
        setInvalidScan(true);
      }
      scheduleNextFrame();
    };

    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
        if (cancelled) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          try {
            video.srcObject = stream;
          } catch {
            // Some environments (e.g. jsdom) don't implement srcObject; the real
            // webcam path in Chromium does. Attachment failure is non-fatal here.
          }
        }
        if (isMounted()) setScanState('scanning');
        // Kick off the first decode immediately; subsequent frames are driven by
        // requestVideoFrameCallback / requestAnimationFrame.
        void scanFrame();
      } catch (error) {
        if (cancelled || !isMounted()) return;
        const name = error instanceof Error ? error.name : '';
        if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
          setScanState('permission-denied');
          onError('cameraPermissionDenied');
        } else {
          // NotFoundError / OverconstrainedError and any other getUserMedia
          // failure surface as "no camera" with a Close affordance.
          setScanState('no-camera');
        }
      }
    })();

    return () => {
      cancelled = true;
      stopCamera();
    };
  }, [open, onDetected, onError, onOpenChange, stopCamera, isMounted]);

  const close = useCallback(() => onOpenChange(false), [onOpenChange]);

  return (
    <Drawer open={open} onOpenChange={onOpenChange} screenKey="scan-qr">
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle>{t('scanQrTitle')}</DrawerTitle>
        </DrawerHeader>
        <div data-testid="scan-qr-drawer" className="flex flex-col items-center gap-4 px-4 pb-6">
          {(scanState === 'requesting' || scanState === 'scanning') && (
            <div className="relative w-full overflow-hidden rounded-2xl bg-black" style={{ aspectRatio: '1 / 1' }}>
              <video
                ref={videoRef}
                data-testid="scan-qr-video"
                autoPlay
                muted
                playsInline
                className="h-full w-full object-cover"
              />
            </div>
          )}

          {scanState === 'requesting' && (
            <div className="flex flex-col items-center gap-3 py-4">
              <Loader size="lg" className="text-primary-500" />
              <p className="text-sm text-text-muted">{t('requestingCamera')}</p>
            </div>
          )}

          {scanState === 'scanning' && (
            <div className="flex flex-col items-center gap-1">
              <p className="text-sm text-text-muted">{t('pointCameraAtQr')}</p>
              {invalidScan && <p className="text-sm text-red-500">{t('invalidMidenAddress')}</p>}
            </div>
          )}

          {scanState === 'permission-denied' && (
            <div data-testid="scan-qr-permission-denied" className="flex flex-col items-center gap-3 py-6">
              <p className="text-sm text-text-muted">{t('cameraPermissionDenied')}</p>
              <button
                type="button"
                onClick={close}
                className="rounded-full bg-primary-500 px-6 py-2.5 text-sm font-medium text-pure-white"
              >
                {t('close')}
              </button>
            </div>
          )}

          {scanState === 'no-camera' && (
            <div data-testid="scan-qr-no-camera" className="flex flex-col items-center gap-3 py-6">
              <p className="text-sm text-text-muted">{t('noCameraFound')}</p>
              <button
                type="button"
                onClick={close}
                className="rounded-full bg-primary-500 px-6 py-2.5 text-sm font-medium text-pure-white"
              >
                {t('close')}
              </button>
            </div>
          )}
        </div>
      </DrawerContent>
    </Drawer>
  );
};
