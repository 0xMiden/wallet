import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';

import QRCodeStyling, { type Options } from 'qr-code-styling';

import { encodeAddress } from 'lib/qr/format';

import midenLogoUrl from '../../public/misc/brand/new-bread.svg?url';

export interface QRCodeProps {
  /** The Miden address to encode in the QR code */
  address: string;
  /** Size of the QR code in pixels */
  size: number;
}

export interface QRCodeHandle {
  /** Returns the rendered QR (with logo) as a PNG Blob, or null if unavailable. */
  getImageBlob: () => Promise<Blob | null>;
}

/** Fallback accent color when the CSS variable can't be resolved (matches --accent-primary). */
const ACCENT_FALLBACK = '#e77537';

const getAccentColor = (): string => {
  if (typeof window === 'undefined') return ACCENT_FALLBACK;
  const value = getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim();
  return value || ACCENT_FALLBACK;
};

/**
 * QR code display component for Miden addresses.
 * Renders a styled QR (circular dots, accent-primary color, Miden logo centered)
 * encoding the address in miden:<address> format via qr-code-styling.
 */
export const QRCode = forwardRef<QRCodeHandle, QRCodeProps>(({ address, size }, ref) => {
  const qrValue = encodeAddress(address);
  const containerRef = useRef<HTMLDivElement>(null);

  const options = useMemo<Options>(() => {
    const color = getAccentColor();
    return {
      type: 'svg',
      width: size,
      height: size,
      // Quiet zone around the modules for reliable scanning.
      margin: 6,
      data: qrValue,
      image: midenLogoUrl,
      // Higher error correction compensates for the centered logo cutout.
      qrOptions: { errorCorrectionLevel: 'H' },
      imageOptions: { crossOrigin: 'anonymous', margin: 6, imageSize: 0.35, hideBackgroundDots: true },
      dotsOptions: { type: 'dots', color },
      cornersSquareOptions: { type: 'extra-rounded', color },
      cornersDotOptions: { type: 'dot', color },
      backgroundOptions: { color: '#FFFFFF' }
    };
  }, [qrValue, size]);

  // Create the styling instance once; re-use across data/size changes via update().
  const qrCode = useMemo(() => new QRCodeStyling(options), []); // eslint-disable-line react-hooks/exhaustive-deps

  // The payload the encoder was LAST handed — see the attribute comment below.
  const [paintedValue, setPaintedValue] = useState('');

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.innerHTML = '';
    qrCode.append(container);
    return () => {
      container.innerHTML = '';
    };
  }, [qrCode]);

  useEffect(() => {
    qrCode.update(options);
    setPaintedValue(typeof options.data === 'string' ? options.data : '');
  }, [qrCode, options]);

  useImperativeHandle(
    ref,
    () => ({
      getImageBlob: async () => {
        const data = await qrCode.getRawData('png');
        // In the browser getRawData resolves to a Blob; guard for the node Buffer path.
        return data instanceof Blob ? data : null;
      }
    }),
    [qrCode]
  );

  return (
    // `data-qr-payload` mirrors the payload the encoder was last PAINTED with, and
    // is deliberately written from inside the `qrCode.update(options)` effect above
    // rather than straight from `qrValue`. The instance is created once and only
    // that effect repaints it, so mirroring `qrValue` here would report what the
    // component computed even when the repaint never ran — a QR left showing a
    // previous account would still read as correct. Sourcing the attribute from the
    // repaint means a broken/removed `update()` leaves the attribute stale (or, on
    // first mount, absent) alongside the stale picture.
    //
    // The attribute exists because the rendered SVG carries no trace of its own
    // payload and the repo has no QR *decoder* (qr-code-styling is an encoder;
    // qrcode/qrcode-generator are transitive-only). It exposes nothing new — the
    // same address already renders in `receive-address-full` and the copy button.
    <div className="bg-pure-white rounded-10 p-2" data-testid="qr-code" data-qr-payload={paintedValue || undefined}>
      <div ref={containerRef} style={{ width: size, height: size }} />
    </div>
  );
});

QRCode.displayName = 'QRCode';

export default QRCode;
