import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';

import QRCodeStyling, { type Options } from 'qr-code-styling';

import { encodeAddress } from 'lib/qr/format';
import { composeQrShareCard, QR_MARGIN_RATIO } from 'lib/qr/share-card';
import { cn } from 'lib/ui/util';

import midenLogoUrl from '../../public/misc/brand/new-bread.svg?url';

export interface QRShareCopy {
  /** The wallet's name, drawn beside the mark at the top of the card. */
  brand: string;
  /** One line under the address saying what the code is for. */
  hint: string;
}

export interface QRCodeProps {
  /** The Miden address to encode in the QR code */
  address: string;
  /**
   * Size of the QR code in pixels: the drawn size, or with `fluid` only the
   * resolution of the exported PNG (the SVG scales through its viewBox).
   */
  size: number;
  /**
   * Short label naming the network the code belongs to (#875), e.g. "Miden Testnet". The shared
   * card always carries it; it is also drawn under the modules on screen unless `showCaption` is
   * false (a page that names the network itself).
   */
  caption?: string;
  /** Draw `caption` on screen too. Defaults to true; the shared card always carries it. */
  showCaption?: boolean;
  /**
   * The copy the shared PNG carries besides the code. With it `getImageBlob` returns the designed
   * share card (see `lib/qr/share-card`); without it, the bare QR.
   */
  share?: QRShareCopy;
  /**
   * Fill the parent's width as a square instead of drawing at `size`, so the
   * caller sizes the QR from its layout (e.g. the height left on screen).
   */
  fluid?: boolean;
  /** How the modules are coloured. Defaults to `brand`, the flat accent orange. */
  palette?: QRPalette;
}

/**
 * The QR's colour treatments: one per account-card colour, each blending that colour into another
 * of the five, so a treatment still reads as "the green one" while the modules carry a gradient.
 * `brand` is the flat accent the rest of the app draws in.
 */
export const QR_PALETTES = ['brand', 'green', 'orange', 'slate', 'blue', 'purple'] as const;

export type QRPalette = (typeof QR_PALETTES)[number];

/**
 * Each treatment as the two custom properties it blends and the gradient's rotation in radians.
 * Every colour is a `--qr-*` token — the card palette pinned to its light values, because the
 * modules are always drawn on a white tile (see src/main.css).
 */
const PALETTE_STOPS: Record<QRPalette, { from: string; to: string; rotation: number }> = {
  brand: { from: '--accent-primary', to: '--accent-primary', rotation: 0 },
  green: { from: '--qr-green', to: '--qr-blue', rotation: Math.PI / 4 },
  orange: { from: '--qr-orange', to: '--qr-purple', rotation: Math.PI / 2 },
  slate: { from: '--qr-slate', to: '--qr-green', rotation: (3 * Math.PI) / 4 },
  blue: { from: '--qr-blue', to: '--qr-purple', rotation: Math.PI },
  purple: { from: '--qr-purple', to: '--qr-orange', rotation: (5 * Math.PI) / 4 }
};

export interface QRCodeHandle {
  /**
   * Returns the shareable PNG Blob, or null if unavailable. With `share` it is the designed
   * card — brand, code on its tile, network and address (`lib/qr/share-card`), so taller and
   * wider than `size`; if composing that fails it falls back to the plain QR.
   */
  getImageBlob: () => Promise<Blob | null>;
}

/** Fallback accent color when the CSS variable can't be resolved (matches --accent-primary). */
const ACCENT_FALLBACK = '#e77537';

const readToken = (name: string): string => {
  if (typeof window === 'undefined') return ACCENT_FALLBACK;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || ACCENT_FALLBACK;
};

type DotsOptions = NonNullable<Options['dotsOptions']>;

/**
 * The module colouring for a treatment: `color` alone when both stops resolve to the same value
 * (the flat brand), a linear gradient otherwise. Both stops are card colours, so a treatment never
 * lightens the modules past what the palette already ships — the QR stays scannable.
 */
const paletteOptions = (palette: QRPalette): { color: string; gradient?: DotsOptions['gradient'] } => {
  const stops = PALETTE_STOPS[palette];
  const from = readToken(stops.from);
  const to = readToken(stops.to);
  if (from === to) return { color: from };
  return {
    color: from,
    gradient: {
      type: 'linear',
      rotation: stops.rotation,
      colorStops: [
        { offset: 0, color: from },
        { offset: 1, color: to }
      ]
    }
  };
};

/**
 * QR code display component for Miden addresses.
 * Renders a styled QR (circular dots in the `palette` treatment, Miden logo centered)
 * encoding the address in miden:<address> format via qr-code-styling.
 */
export const QRCode = forwardRef<QRCodeHandle, QRCodeProps>(
  ({ address, size, caption, showCaption, fluid, palette = 'brand', share }, ref) => {
    const qrValue = encodeAddress(address);
    const containerRef = useRef<HTMLDivElement>(null);

    const options = useMemo<Options>(() => {
      const colors = paletteOptions(palette);
      // Quiet zone around the modules, and the gap around the logo cutout. Both are in the
      // rendered size's own units, so they scale with it: raising `size` for a crisper export
      // must not shrink the quiet zone the on-screen code is drawn with.
      const margin = Math.round(size * QR_MARGIN_RATIO);
      return {
        type: 'svg',
        width: size,
        height: size,
        margin,
        data: qrValue,
        image: midenLogoUrl,
        // Higher error correction compensates for the centered logo cutout.
        qrOptions: { errorCorrectionLevel: 'H' },
        imageOptions: { crossOrigin: 'anonymous', margin, imageSize: 0.35, hideBackgroundDots: true },
        dotsOptions: { type: 'dots', ...colors },
        cornersSquareOptions: { type: 'extra-rounded', ...colors },
        cornersDotOptions: { type: 'dot', ...colors },
        backgroundOptions: { color: '#FFFFFF' }
      };
    }, [qrValue, size, palette]);

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
          if (!share) return data;
          try {
            const card = await composeQrShareCard({
              qr: data,
              logoUrl: midenLogoUrl,
              brand: share.brand,
              hint: share.hint,
              network: caption,
              address
            });
            if (card) return card;
            // The share falls back to the bare code; leave a trace.
            console.warn('[QRCode] share card unavailable, sharing the raw QR');
            return data;
          } catch (e) {
            console.warn('[QRCode] share card failed, sharing the raw QR:', e);
            return data;
          }
        }
      }),
      [address, caption, qrCode, share]
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
        className={cn('flex flex-col items-center bg-pure-white rounded-2xl p-2', fluid && 'w-full')}
        data-testid="qr-code"
        data-qr-payload={paintedValue || undefined}
        data-qr-palette={palette}
      >
        {fluid ? (
          <div ref={containerRef} className="aspect-square w-full [&>svg]:block [&>svg]:h-full [&>svg]:w-full" />
        ) : (
          <div ref={containerRef} style={{ width: size, height: size }} />
        )}
        {caption && showCaption !== false && (
          <span
            className="pb-2 font-heading text-sm font-bold uppercase tracking-wider text-accent-primary"
            data-testid="qr-code-caption"
          >
            {caption}
          </span>
        )}
      </div>
    );
  }
);

QRCode.displayName = 'QRCode';

export default QRCode;
