import React from 'react';

import { render } from '@testing-library/react';

import { QRCode, type QRCodeHandle } from './QRCode';

// ---------------------------------------------------------------------------
// `qr-code-styling` is a DOM/canvas-driven library (SVG + PNG rasterization via
// <canvas>), none of which jsdom implements. Replace the default-exported class
// with a lightweight stub whose methods are jest.fns we can assert against.
// The `type Options` named import is erased at compile time, so only the
// default export needs to exist. Factory-local names are `mock`-prefixed so
// jest's hoisting guard allows referencing them.
// ---------------------------------------------------------------------------
const mockConstructor = jest.fn();
const mockAppend = jest.fn();
const mockUpdate = jest.fn();
const mockGetRawData = jest.fn();

jest.mock('qr-code-styling', () => ({
  __esModule: true,
  default: class QRCodeStylingStub {
    constructor(options: unknown) {
      mockConstructor(options);
    }
    append(container: HTMLElement) {
      return mockAppend(container);
    }
    update(options: unknown) {
      return mockUpdate(options);
    }
    getRawData(type: string) {
      return mockGetRawData(type);
    }
  }
}));

// The Miden logo is imported as `../../public/misc/brand/new-bread.svg?url`,
// which resolves through jest's `\.svg\?url$` mapper to the shared file stub.
// The virtual mock (mirrors src/app/atoms/Logo.test.tsx) is kept to hand the
// import a distinct, assertable value.
jest.mock('../../public/misc/brand/new-bread.svg?url', () => 'miden-logo-url-stub', { virtual: true });

const ACCENT_FALLBACK = '#e77537';
const ADDRESS = 'mtst1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5qruqqypuyph';

/** Options object passed to the (single) QRCodeStyling constructor call. */
const ctorOptions = () => mockConstructor.mock.calls[0][0] as Record<string, any>;

describe('QRCode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Keep the documentElement style clean between tests so the accent-color
    // resolution starts from a known (unset) state.
    document.documentElement.style.removeProperty('--accent-primary');
    mockGetRawData.mockReset();
  });

  describe('rendering', () => {
    it('renders the white padded wrapper with a sized inner container', () => {
      const { container } = render(<QRCode address={ADDRESS} size={200} />);

      const outer = container.firstChild as HTMLElement;
      expect(outer).toHaveClass('bg-pure-white', 'rounded-2xl', 'p-2');

      const inner = outer.firstChild as HTMLElement;
      expect(inner.tagName).toBe('DIV');
      // Numeric size props become px strings on the DOM node.
      expect(inner).toHaveStyle({ width: '200px', height: '200px' });
    });

    it('fills its parent as a square when fluid, scaling the SVG instead of drawing at size', () => {
      const { container } = render(<QRCode address={ADDRESS} size={288} fluid />);

      const outer = container.firstChild as HTMLElement;
      expect(outer).toHaveClass('w-full');

      const inner = outer.firstChild as HTMLElement;
      expect(inner).toHaveClass('aspect-square', 'w-full', '[&>svg]:h-full', '[&>svg]:w-full');
      expect(inner.style.width).toBe('');
      expect(inner.style.height).toBe('');
      // `size` is still the rendered resolution (the exported PNG and the SVG's viewBox).
      expect(ctorOptions()).toMatchObject({ width: 288, height: 288 });
    });

    it('constructs the styling instance exactly once with the encoded payload', () => {
      render(<QRCode address={ADDRESS} size={200} />);

      expect(mockConstructor).toHaveBeenCalledTimes(1);
      // encodeAddress (real, un-mocked) prefixes the miden: URI scheme.
      expect(ctorOptions().data).toBe(`miden:${ADDRESS}`);
    });

    it('builds the full styling options for scan-reliable rendering', () => {
      render(<QRCode address={ADDRESS} size={256} />);

      const opts = ctorOptions();
      expect(opts).toMatchObject({
        type: 'svg',
        width: 256,
        height: 256,
        margin: 6,
        data: `miden:${ADDRESS}`,
        image: 'miden-logo-url-stub',
        qrOptions: { errorCorrectionLevel: 'H' },
        imageOptions: { crossOrigin: 'anonymous', margin: 6, imageSize: 0.35, hideBackgroundDots: true },
        dotsOptions: { type: 'dots' },
        cornersSquareOptions: { type: 'extra-rounded' },
        cornersDotOptions: { type: 'dot' },
        backgroundOptions: { color: '#FFFFFF' }
      });
    });

    it('appends the styled QR into the inner container on mount', () => {
      const { container } = render(<QRCode address={ADDRESS} size={200} />);

      expect(mockAppend).toHaveBeenCalledTimes(1);
      const appended = mockAppend.mock.calls[0][0] as HTMLElement;
      // The append target is the inner sized div (the second-level element).
      expect(appended).toBe((container.firstChild as HTMLElement).firstChild);
    });

    it('runs the initial update() effect on mount', () => {
      render(<QRCode address={ADDRESS} size={200} />);

      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(mockUpdate.mock.calls[0][0]).toMatchObject({ data: `miden:${ADDRESS}`, width: 200 });
    });
  });

  describe('accent color resolution', () => {
    it('falls back to the accent-primary hex when the CSS variable is unset', () => {
      render(<QRCode address={ADDRESS} size={200} />);

      const opts = ctorOptions();
      expect(opts.dotsOptions.color).toBe(ACCENT_FALLBACK);
      expect(opts.cornersSquareOptions.color).toBe(ACCENT_FALLBACK);
      expect(opts.cornersDotOptions.color).toBe(ACCENT_FALLBACK);
    });

    it('uses (and trims) the resolved --accent-primary CSS variable when present', () => {
      // Drive the truthy `value || ACCENT_FALLBACK` branch deterministically,
      // independent of jsdom's custom-property computation, and exercise
      // `.trim()` by padding the returned value with whitespace.
      const gcsSpy = jest.spyOn(window, 'getComputedStyle').mockReturnValue({
        getPropertyValue: () => '  #123abc  '
      } as unknown as CSSStyleDeclaration);

      try {
        render(<QRCode address={ADDRESS} size={200} />);
      } finally {
        gcsSpy.mockRestore();
      }

      expect(ctorOptions().dotsOptions.color).toBe('#123abc');
    });
  });

  describe('palette treatments', () => {
    /** Resolves every `--qr-*` token to a distinct, assertable color. */
    const stubTokens = () =>
      jest.spyOn(window, 'getComputedStyle').mockReturnValue({
        getPropertyValue: (name: string) => `resolved(${name})`
      } as unknown as CSSStyleDeclaration);

    it('draws the flat accent by default, with no gradient', () => {
      render(<QRCode address={ADDRESS} size={200} />);

      const opts = ctorOptions();
      expect(opts.dotsOptions.color).toBe(ACCENT_FALLBACK);
      expect(opts.dotsOptions.gradient).toBeUndefined();
      expect(opts.cornersSquareOptions.gradient).toBeUndefined();
    });

    it('blends two card colors across the dots and both corner marks', () => {
      const gcs = stubTokens();
      try {
        const { container } = render(<QRCode address={ADDRESS} size={200} palette="green" />);

        const opts = ctorOptions();
        const gradient = {
          type: 'linear',
          rotation: Math.PI / 4,
          colorStops: [
            { offset: 0, color: 'resolved(--qr-green)' },
            { offset: 1, color: 'resolved(--qr-blue)' }
          ]
        };
        expect(opts.dotsOptions).toMatchObject({ color: 'resolved(--qr-green)', gradient });
        expect(opts.cornersSquareOptions).toMatchObject({ gradient });
        expect(opts.cornersDotOptions).toMatchObject({ gradient });
        // The tile the modules sit on never changes: that is what keeps the QR scannable.
        expect(opts.backgroundOptions).toEqual({ color: '#FFFFFF' });
        expect(container.querySelector('[data-testid="qr-code"]')).toHaveAttribute('data-qr-palette', 'green');
      } finally {
        gcs.mockRestore();
      }
    });

    it('repaints when the palette changes', () => {
      const gcs = stubTokens();
      try {
        const { rerender } = render(<QRCode address={ADDRESS} size={200} palette="green" />);
        expect(mockUpdate).toHaveBeenCalledTimes(1);

        rerender(<QRCode address={ADDRESS} size={200} palette="purple" />);

        expect(mockConstructor).toHaveBeenCalledTimes(1);
        expect(mockUpdate).toHaveBeenCalledTimes(2);
        expect(mockUpdate.mock.calls[1][0].dotsOptions.color).toBe('resolved(--qr-purple)');
      } finally {
        gcs.mockRestore();
      }
    });

    it('paints the shared image caption in the treatment color', async () => {
      const gcs = stubTokens();
      mockGetRawData.mockResolvedValue(new Blob(['png-bytes'], { type: 'image/png' }));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const ctx = { fillText: jest.fn(), drawImage: jest.fn(), fillRect: jest.fn(), fillStyle: '' };
      const getContext = jest.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as any);
      (globalThis as any).createImageBitmap = jest.fn().mockResolvedValue({ close: jest.fn() });
      const toBlob = HTMLCanvasElement.prototype.toBlob;
      HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) {
        callback(new Blob(['captioned'], { type: 'image/png' }));
      };
      try {
        const ref = React.createRef<QRCodeHandle>();
        render(<QRCode ref={ref} address={ADDRESS} size={200} caption="Miden Devnet" palette="slate" />);

        await ref.current!.getImageBlob();
        expect(ctx.fillStyle).toBe('resolved(--qr-slate)');
      } finally {
        HTMLCanvasElement.prototype.toBlob = toBlob;
        delete (globalThis as any).createImageBitmap;
        getContext.mockRestore();
        warn.mockRestore();
        gcs.mockRestore();
      }
    });
  });

  describe('reactivity', () => {
    it('reuses the same instance and calls update() again when props change', () => {
      const { rerender } = render(<QRCode address={ADDRESS} size={200} />);

      expect(mockConstructor).toHaveBeenCalledTimes(1);
      expect(mockUpdate).toHaveBeenCalledTimes(1);

      const nextAddress = 'mtst1zzzqzwh6s4gvcyzsvx726y6xvsgt5qv5qruqqypuyph';
      rerender(<QRCode address={nextAddress} size={320} />);

      // useMemo([]) → the instance is created once and reused.
      expect(mockConstructor).toHaveBeenCalledTimes(1);
      // The append effect keys off the (stable) instance, so it does not re-run.
      expect(mockAppend).toHaveBeenCalledTimes(1);
      // The update effect re-runs with the recomputed options.
      expect(mockUpdate).toHaveBeenCalledTimes(2);
      expect(mockUpdate.mock.calls[1][0]).toMatchObject({ data: `miden:${nextAddress}`, width: 320 });
    });

    it('does not re-run the update effect when props are unchanged across a rerender', () => {
      const { rerender } = render(<QRCode address={ADDRESS} size={200} />);
      expect(mockUpdate).toHaveBeenCalledTimes(1);

      // Same primitive props → memoized options identity is stable → no update.
      rerender(<QRCode address={ADDRESS} size={200} />);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    });

    it('clears the inner container when unmounted (append effect cleanup)', () => {
      const { container, unmount } = render(<QRCode address={ADDRESS} size={200} />);
      const inner = (container.firstChild as HTMLElement).firstChild as HTMLElement;
      // Simulate the library having injected markup so cleanup has something to clear.
      inner.innerHTML = '<svg></svg>';

      unmount();

      expect(inner.innerHTML).toBe('');
    });
  });

  describe('caption (#875)', () => {
    it('renders the caption under the modules and omits it when absent', () => {
      const { container, rerender } = render(<QRCode address={ADDRESS} size={200} caption="Miden Testnet" />);
      const caption = container.querySelector('[data-testid="qr-code-caption"]');
      expect(caption).toHaveTextContent('Miden Testnet');

      rerender(<QRCode address={ADDRESS} size={200} />);
      expect(container.querySelector('[data-testid="qr-code-caption"]')).toBeNull();
    });

    it('keeps the caption off screen when showCaption is false, but still captions the export', async () => {
      mockGetRawData.mockResolvedValue(new Blob(['png-bytes'], { type: 'image/png' }));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const ref = React.createRef<QRCodeHandle>();
        const { container } = render(
          <QRCode ref={ref} address={ADDRESS} size={200} caption="Miden Testnet" showCaption={false} />
        );

        expect(container.querySelector('[data-testid="qr-code-caption"]')).toBeNull();
        // The export still tries to paint the caption strip (jsdom has no canvas to finish it).
        await ref.current!.getImageBlob();
        expect(warn).toHaveBeenCalledWith('[QRCode] caption compose unavailable, sharing the raw QR');
      } finally {
        warn.mockRestore();
      }
    });

    it('falls back to the raw PNG when the realm has no createImageBitmap', async () => {
      // jsdom has no createImageBitmap, so composeCaptionedPng returns null at its
      // first guard and the share still gets the plain QR instead of nothing.
      const blob = new Blob(['png-bytes'], { type: 'image/png' });
      mockGetRawData.mockResolvedValue(blob);
      const getContext = jest.spyOn(HTMLCanvasElement.prototype, 'getContext');
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const ref = React.createRef<QRCodeHandle>();
        render(<QRCode ref={ref} address={ADDRESS} size={200} caption="Miden Testnet" />);

        expect(await ref.current!.getImageBlob()).toBe(blob);
        expect(getContext).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith('[QRCode] caption compose unavailable, sharing the raw QR');
      } finally {
        getContext.mockRestore();
        warn.mockRestore();
      }
    });

    describe('composing the captioned PNG', () => {
      const SIZE = 200;
      const STRIP = Math.round(SIZE * 0.14);
      const raw = new Blob(['png-bytes'], { type: 'image/png' });
      const composed = new Blob(['captioned'], { type: 'image/png' });
      const close = jest.fn();
      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      const originalToBlob = HTMLCanvasElement.prototype.toBlob;
      let ctx: { fillText: jest.Mock; drawImage: jest.Mock; fillRect: jest.Mock };
      let canvasSize: { width: number; height: number } | null;

      beforeEach(() => {
        close.mockClear();
        canvasSize = null;
        ctx = { fillText: jest.fn(), drawImage: jest.fn(), fillRect: jest.fn() };
        mockGetRawData.mockResolvedValue(raw);
        (globalThis as any).createImageBitmap = jest.fn().mockResolvedValue({ close });
        HTMLCanvasElement.prototype.getContext = jest.fn(() => ctx) as any;
        HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, callback: BlobCallback) {
          canvasSize = { width: this.width, height: this.height };
          callback(composed);
        };
      });

      afterEach(() => {
        delete (globalThis as any).createImageBitmap;
        HTMLCanvasElement.prototype.getContext = originalGetContext;
        HTMLCanvasElement.prototype.toBlob = originalToBlob;
      });

      const imageBlob = async () => {
        const ref = React.createRef<QRCodeHandle>();
        render(<QRCode ref={ref} address={ADDRESS} size={SIZE} caption="Miden Devnet" />);
        return ref.current!.getImageBlob();
      };

      it('paints the upper-cased caption into a strip under the QR', async () => {
        expect(await imageBlob()).toBe(composed);
        expect(canvasSize).toEqual({ width: SIZE, height: SIZE + STRIP });
        expect(ctx.drawImage).toHaveBeenCalledWith({ close }, 0, 0, SIZE, SIZE);
        expect(ctx.fillText).toHaveBeenCalledWith('MIDEN DEVNET', SIZE / 2, SIZE + STRIP / 2);
        expect(close).toHaveBeenCalledTimes(1);
      });

      it('shares the raw PNG when composing throws, and says so', async () => {
        const failure = new Error('decode failed');
        (globalThis as any).createImageBitmap = jest.fn().mockRejectedValue(failure);
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          expect(await imageBlob()).toBe(raw);
          expect(warn).toHaveBeenCalledWith('[QRCode] caption compose failed, sharing the raw QR:', failure);
        } finally {
          warn.mockRestore();
        }
      });

      it('shares the raw PNG when the canvas has no 2d context', async () => {
        HTMLCanvasElement.prototype.getContext = jest.fn(() => null) as any;
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          expect(await imageBlob()).toBe(raw);
          expect((globalThis as any).createImageBitmap).not.toHaveBeenCalled();
          expect(warn).toHaveBeenCalledWith('[QRCode] caption compose unavailable, sharing the raw QR');
        } finally {
          warn.mockRestore();
        }
      });

      it('shares the raw PNG when the canvas cannot encode', async () => {
        HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback) {
          callback(null);
        };
        const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          expect(await imageBlob()).toBe(raw);
          expect(close).toHaveBeenCalledTimes(1);
          expect(warn).toHaveBeenCalledWith('[QRCode] caption compose unavailable, sharing the raw QR');
        } finally {
          warn.mockRestore();
        }
      });
    });
  });

  describe('imperative handle: getImageBlob', () => {
    it('resolves to the PNG Blob when getRawData yields a Blob', async () => {
      const blob = new Blob(['png-bytes'], { type: 'image/png' });
      mockGetRawData.mockResolvedValue(blob);

      const ref = React.createRef<QRCodeHandle>();
      render(<QRCode ref={ref} address={ADDRESS} size={200} />);

      const result = await ref.current!.getImageBlob();

      expect(mockGetRawData).toHaveBeenCalledWith('png');
      expect(result).toBe(blob);
    });

    it('resolves to null when getRawData yields a non-Blob (node Buffer path)', async () => {
      // Emulate the node path where getRawData resolves to a Buffer-like value.
      mockGetRawData.mockResolvedValue(new Uint8Array([1, 2, 3]));

      const ref = React.createRef<QRCodeHandle>();
      render(<QRCode ref={ref} address={ADDRESS} size={200} />);

      const result = await ref.current!.getImageBlob();

      expect(result).toBeNull();
    });
  });

  it('exposes the displayName for React devtools', () => {
    expect(QRCode.displayName).toBe('QRCode');
  });
});
