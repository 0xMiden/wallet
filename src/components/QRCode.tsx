import React, { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';

import QRCodeStyling, { type Options } from 'qr-code-styling';

import { encodeAddress } from 'lib/qr/format';

import midenLogoUrl from '../../public/misc/brand/new-bread.svg?url';

export interface QRCodeProps {
  /** The Miden address to encode in the QR code */
  address: string;
  /**
   * Resolution in pixels the QR renders and exports at. On screen it fills its parent as a square,
   * scaling through the SVG's viewBox.
   */
  size: number;
  /**
   * Short label painted into the exported PNG, so a shared QR image says which network it belongs
   * to (#875). Export only: the page that shows the QR names the network itself.
   */
  caption?: string;
  /** How the modules are coloured: one of the five account-card treatments. */
  palette: QRPalette;
  /**
   * Fires with the palette once a recolour actually paints: the initial paint, an address/size
   * change, or a staged recolour once its draw lands. Never fires for a request whose draw fails,
   * so a caller cycling palettes can tell a shown colour from a merely requested one and retry.
   */
  onPaletteCommitted?: (palette: QRPalette) => void;
  /**
   * Bump on every recolour request, including a repeat of the current `palette`. A failed staged
   * draw never changes `applied` (below), so re-requesting the same colour leaves every value this
   * component keys its redraw effect on unchanged; without this, the effect's dependency check
   * would see nothing new and skip the retry entirely.
   */
  recolourAttempt?: number;
}

/** The QR's colour treatments: one per account-card colour, painted solid in that colour. */
export const QR_PALETTES = ['green', 'orange', 'slate', 'blue', 'purple'] as const;

export type QRPalette = (typeof QR_PALETTES)[number];

/**
 * Each treatment's colour as a `--qr-*` token — the card palette pinned to its light values, because
 * the modules are always drawn on a white tile (see src/main.css).
 */
const PALETTE_TOKENS: Record<QRPalette, string> = {
  green: '--qr-green',
  orange: '--qr-orange',
  slate: '--qr-slate',
  blue: '--qr-blue',
  purple: '--qr-purple'
};

export interface QRCodeHandle {
  /**
   * Returns the rendered QR (with logo) as a PNG Blob, or null if unavailable. With a
   * `caption` it is the captioned image (a strip under the modules, so taller than
   * `size`); if composing that fails it falls back to the plain QR.
   */
  getImageBlob: () => Promise<Blob | null>;
}

/** Fallback accent color when the CSS variable can't be resolved (matches --accent-primary). */
const ACCENT_FALLBACK = '#e77537';

/** Height of the caption strip added to the exported PNG, as a fraction of the QR size. */
const CAPTION_STRIP_RATIO = 0.14;
/** Caption font size in the exported PNG, as a fraction of the QR size. */
const CAPTION_FONT_RATIO = 0.055;

const readToken = (name: string): string => {
  if (typeof window === 'undefined') return ACCENT_FALLBACK;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || ACCENT_FALLBACK;
};

/**
 * The module colouring for a treatment: its card colour, solid. The card colours are dark enough on
 * the white tile that the QR stays scannable.
 */
const paletteOptions = (palette: QRPalette): { color: string } => ({ color: readToken(PALETTE_TOKENS[palette]) });

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

const isUsableDraw = (data: unknown) =>
  (data instanceof Blob && data.size > 0) ||
  (typeof Buffer !== 'undefined' && Buffer.isBuffer(data) && data.length > 0);

/**
 * QR code display component for Miden addresses.
 * Renders a styled QR (circular dots in the `palette` treatment, Miden logo centered)
 * encoding the address in miden:<address> format via qr-code-styling.
 */
export const QRCode = forwardRef<QRCodeHandle, QRCodeProps>(
  ({ address, size, caption, palette, onPaletteCommitted, recolourAttempt }, ref) => {
    const qrValue = encodeAddress(address);
    // Two slots: the painted code stays on screen while a new colour is drawn into the other one.
    const slotA = useRef<HTMLDivElement>(null);
    const slotB = useRef<HTMLDivElement>(null);

    const options = useMemo<Options>(() => {
      const colors = paletteOptions(palette);
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
        dotsOptions: { type: 'dots', ...colors },
        cornersSquareOptions: { type: 'extra-rounded', ...colors },
        cornersDotOptions: { type: 'dot', ...colors },
        backgroundOptions: { color: '#FFFFFF' }
      };
    }, [qrValue, size, palette]);

    // Create the first styling instance once; re-use it across data/size changes via update().
    const firstInstance = useMemo(() => new QRCodeStyling(options), []); // eslint-disable-line react-hooks/exhaustive-deps

    // The instance on screen, its slot and palette: what is visible AND what a share exports.
    const committed = useRef<{ instance: QRCodeStyling; slot: 0 | 1; palette: QRPalette }>({
      instance: firstInstance,
      slot: 0,
      palette
    });
    const [shownSlot, setShownSlot] = useState<0 | 1>(0);
    // The palette the visible code was painted with, set only where a paint commits.
    const [shownPalette, setShownPalette] = useState<QRPalette>(palette);
    // What the committed instance was last drawn with, and a counter over every option change: a
    // staged colour that finishes after a newer change (another tap, a new address) is dropped.
    const applied = useRef<{ qrValue: string; size: number; palette: QRPalette } | null>(null);
    const generation = useRef(0);

    // The payload the encoder was LAST handed — see the attribute comment below.
    const [paintedValue, setPaintedValue] = useState('');

    useEffect(() => {
      const container = slotA.current;
      const other = slotB.current;
      if (!container) return;
      container.innerHTML = '';
      firstInstance.append(container);
      return () => {
        container.innerHTML = '';
        if (other) other.innerHTML = '';
      };
    }, [firstInstance]);

    useEffect(() => {
      const gen = ++generation.current;
      const last = applied.current;
      const sameCode = last !== null && last.qrValue === qrValue && last.size === size;
      // Back to the palette already painted, with a staged draw still pending: the bumped generation
      // drops that draw, and the painted code is left alone (update() would blank it).
      if (sameCode && last.palette === palette) return;
      // A colour change alone never clears the painted code: qr-code-styling's update() empties its
      // container and redraws asynchronously, so the new colour is drawn into the other slot and
      // swapped in once it is complete.
      if (sameCode) {
        const slot = committed.current.slot === 0 ? 1 : 0;
        const container = (slot === 0 ? slotA : slotB).current;
        if (!container) return;
        container.innerHTML = '';
        const staged = new QRCodeStyling(options);
        staged.append(container);
        void Promise.resolve(staged.getRawData('svg'))
          .then(drawn => {
            if (gen !== generation.current) return;
            // A draw can settle without drawing; committing it would swap a working code for a blank slot.
            if (!isUsableDraw(drawn) || !container.firstElementChild) {
              throw new Error('recolour draw produced no code');
            }
            committed.current = { instance: staged, slot, palette };
            applied.current = { qrValue, size, palette };
            setShownSlot(slot);
            setShownPalette(palette);
            onPaletteCommitted?.(palette);
          })
          .catch(e => {
            console.warn('[QRCode] recolour draw failed, keeping the painted palette:', e);
          });
        return;
      }
      committed.current.instance.update(options);
      committed.current = { ...committed.current, palette };
      applied.current = { qrValue, size, palette };
      setPaintedValue(typeof options.data === 'string' ? options.data : '');
      setShownPalette(palette);
      onPaletteCommitted?.(palette);
    }, [options, qrValue, size, palette, recolourAttempt, onPaletteCommitted]);

    useImperativeHandle(
      ref,
      () => ({
        getImageBlob: async () => {
          const { instance, palette: shownPalette } = committed.current;
          const data = await instance.getRawData('png');
          // In the browser getRawData resolves to a Blob; guard for the node Buffer path.
          if (!(data instanceof Blob)) return null;
          if (!caption) return data;
          try {
            // The caption is painted in the treatment's own leading colour, so a shared image
            // matches the QR the sender is looking at.
            const composed = await composeCaptionedPng(data, size, caption, paletteOptions(shownPalette).color);
            if (composed) return composed;
            // The shared image loses its network caption here; leave a trace.
            console.warn('[QRCode] caption compose unavailable, sharing the raw QR');
            return data;
          } catch (e) {
            console.warn('[QRCode] caption compose failed, sharing the raw QR:', e);
            return data;
          }
        }
      }),
      [caption, size]
    );

    return (
      // `data-qr-payload` and `data-qr-palette` mirror what was last PAINTED, and are
      // written where a paint commits (the committed instance's `update()`, or a staged
      // recolour once its draw lands) rather than straight from the props. Mirroring the
      // props would report what the component computed even when the paint never ran or
      // failed: a QR left showing a previous account, or its old colour, would still read
      // as correct. Sourcing them from the commit means a broken paint leaves them stale
      // (or, on first mount, absent) alongside the stale picture.
      //
      // The attribute exists because the rendered SVG carries no trace of its own
      // payload and the repo has no QR *decoder* (qr-code-styling is an encoder;
      // qrcode/qrcode-generator are transitive-only). It exposes nothing new — the
      // same address already renders in `receive-address-full` and the copy button.
      // Always fills its parent as a square: the layout sizes the QR, and `size` is only the resolution
      // it renders and exports at. The caption is painted into the EXPORTED image only - the page names
      // the network itself, so an on-screen copy of it had no caller.
      <div
        className="flex w-full flex-col items-center bg-pure-white rounded-2xl p-2"
        data-testid="qr-code"
        data-qr-payload={paintedValue || undefined}
        data-qr-palette={shownPalette}
      >
        {([slotA, slotB] as const).map((slotRef, slot) => (
          <div
            key={slot}
            ref={slotRef}
            hidden={shownSlot !== slot}
            className="aspect-square w-full [&>svg]:block [&>svg]:h-full [&>svg]:w-full"
          />
        ))}
      </div>
    );
  }
);

QRCode.displayName = 'QRCode';

export default QRCode;
