import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';

import QRCodeStyling, { type Options } from 'qr-code-styling';

import { encodeAddress } from 'lib/qr/format';

import midenLogoUrl from '../../public/misc/brand/new-bread.svg?url';

export interface QRCodeProps {
  /** The Miden address to encode in the QR code */
  address: string;
  /** Size of the QR code in pixels */
  size: number;
  /**
   * Short label painted under the modules, on screen AND into the exported
   * PNG, so a shared QR image says which network it belongs to (#875).
   */
  caption?: string;
}

export interface QRCodeHandle {
  /** Returns the rendered QR (with logo) as a PNG Blob, or null if unavailable. */
  getImageBlob: () => Promise<Blob | null>;
}

/** Fallback accent color when the CSS variable can't be resolved (matches --accent-primary). */
const ACCENT_FALLBACK = '#e77537';

/** Height of the caption strip added to the exported PNG, as a fraction of the QR size. */
const CAPTION_STRIP_RATIO = 0.14;
/** Caption font size in the exported PNG, as a fraction of the QR size. */
const CAPTION_FONT_RATIO = 0.055;

const getAccentColor = (): string => {
  if (typeof window === 'undefined') return ACCENT_FALLBACK;
  const value = getComputedStyle(document.documentElement).getPropertyValue('--accent-primary').trim();
  return value || ACCENT_FALLBACK;
};

/**
 * Paint the caption under the raw QR PNG. Returns null when the realm has no
 * usable canvas (jsdom, some WebViews) so the caller can fall back to the raw
 * image rather than lose the share.
 */
async function composeCaptionedPng(qrPng: Blob, size: number, caption: string, color: string): Promise<Blob | null> {
  if (typeof document === 'undefined' || typeof createImageBitmap !== 'function') return null;
  const canvas = document.createElement('canvas');
  const strip = Math.round(size * CAPTION_STRIP_RATIO);
  canvas.width = size;
  canvas.height = size + strip;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const bitmap = await createImageBitmap(qrPng);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, size, size);
  bitmap.close();

  ctx.fillStyle = color;
  ctx.font = `700 ${Math.round(size * CAPTION_FONT_RATIO)}px Nunito, Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(caption.toUpperCase(), size / 2, size + strip / 2);

  return new Promise(resolve => canvas.toBlob(blob => resolve(blob), 'image/png'));
}

/**
 * QR code display component for Miden addresses.
 * Renders a styled QR (circular dots, accent-primary color, Miden logo centered)
 * encoding the address in miden:<address> format via qr-code-styling.
 */
export const QRCode = forwardRef<QRCodeHandle, QRCodeProps>(({ address, size, caption }, ref) => {
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
        if (!(data instanceof Blob)) return null;
        if (!caption) return data;
        try {
          return (await composeCaptionedPng(data, size, caption, getAccentColor())) ?? data;
        } catch (e) {
          console.warn('[QRCode] caption compose failed, sharing the raw QR:', e);
          return data;
        }
      }
    }),
    [caption, qrCode, size]
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
    <div
      className="flex flex-col items-center bg-pure-white rounded-10 p-2"
      data-testid="qr-code"
      data-qr-payload={paintedValue || undefined}
    >
      <div ref={containerRef} style={{ width: size, height: size }} />
      {caption && (
        <span
          className="pb-2 font-heading text-sm font-bold uppercase tracking-wider text-accent-primary"
          data-testid="qr-code-caption"
        >
          {caption}
        </span>
      )}
    </div>
  );
});

QRCode.displayName = 'QRCode';

export default QRCode;
