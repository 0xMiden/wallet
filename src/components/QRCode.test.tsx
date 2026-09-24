import React from 'react';

import { act, render } from '@testing-library/react';

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
// Per-instance record, so a test can tell the painted instance from a staged one.
type MockInstance = { container?: HTMLElement; marker: string; rawData: string[]; updates: unknown[] };
const mockInstances: MockInstance[] = [];

// Like the library, append and update draw into the container: a marker naming this instance and the
// payload it carries, so a "shown" assertion can see the code itself and not just an empty wrapper.
jest.mock('qr-code-styling', () => ({
  __esModule: true,
  default: class QRCodeStylingStub {
    record: MockInstance;
    constructor(options: { data?: string }) {
      this.record = { marker: `${mockInstances.length}:${options.data}`, rawData: [], updates: [] };
      mockInstances.push(this.record);
      mockConstructor(options);
    }
    draw() {
      const { container, marker } = this.record;
      if (!container) return;
      container.innerHTML = '';
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('data-qr-marker', marker);
      container.appendChild(svg);
    }
    append(container: HTMLElement) {
      this.record.container = container;
      this.draw();
      return mockAppend(container);
    }
    update(options: { data?: string }) {
      this.record.updates.push(options);
      this.record.marker = `${mockInstances.indexOf(this.record)}:${options.data}`;
      this.draw();
      return mockUpdate(options);
    }
    getRawData(type: string) {
      this.record.rawData.push(type);
      return mockGetRawData(type);
    }
  }
}));

const deferred = () => {
  let resolve: (value: unknown) => void = () => undefined;
  const promise = new Promise(r => (resolve = r));
  return { promise, resolve };
};
const isShown = (el?: HTMLElement) => Boolean(el) && !el!.hidden && el!.isConnected;
/** The instance's own drawn code is in a visible slot. */
const showsCode = (instance: MockInstance) =>
  isShown(instance.container) && instance.container!.querySelector(`[data-qr-marker="${instance.marker}"]`) !== null;
const drawnSvg = () => new Blob(['<svg/>'], { type: 'image/svg+xml' });

// The Miden logo is imported as `../../public/misc/brand/new-bread.svg?url`.
// The `?url` query suffix means it does NOT match the jest `\.svg$` asset
// mapper (anchored on a trailing `.svg`) and the real file has no `?url`
// variant on disk, so plain resolution fails. A virtual mock short-circuits
// resolution (mirrors src/app/atoms/Logo.test.tsx) and hands the import a
// distinct, assertable value.
jest.mock('../../public/misc/brand/new-bread.svg?url', () => 'miden-logo-url-stub', { virtual: true });

const ADDRESS = 'mtst1aplqzwh6s4gvcyzsvx726y6xvsgt5qv5qruqqypuyph';

/** Options object passed to the (single) QRCodeStyling constructor call. */
const ctorOptions = () => mockConstructor.mock.calls[0][0] as Record<string, any>;

describe('QRCode', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockInstances.length = 0;
    // Keep the documentElement style clean between tests so the accent-color
    // resolution starts from a known (unset) state.
    document.documentElement.style.removeProperty('--accent-primary');
    mockGetRawData.mockReset();
  });

  describe('rendering', () => {
    it('renders the white padded wrapper with a sized inner container', () => {
      const { container } = render(<QRCode palette="green" address={ADDRESS} size={200} />);

      const outer = container.firstChild as HTMLElement;
      expect(outer).toHaveClass('bg-pure-white', 'rounded-2xl', 'p-2');

      const inner = outer.firstChild as HTMLElement;
      expect(inner.tagName).toBe('DIV');
      // Numeric size props become px strings on the DOM node.
      expect(inner).toHaveStyle({ width: '200px', height: '200px' });
    });

    it('fills its parent as a square when fluid, scaling the SVG instead of drawing at size', () => {
      const { container } = render(<QRCode palette="green" address={ADDRESS} size={288} fluid />);

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
      render(<QRCode palette="green" address={ADDRESS} size={200} />);

      expect(mockConstructor).toHaveBeenCalledTimes(1);
      // encodeAddress (real, un-mocked) prefixes the miden: URI scheme.
      expect(ctorOptions().data).toBe(`miden:${ADDRESS}`);
    });

    it('builds the full styling options for scan-reliable rendering', () => {
      render(<QRCode palette="green" address={ADDRESS} size={256} />);

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
      const { container } = render(<QRCode palette="green" address={ADDRESS} size={200} />);

      expect(mockAppend).toHaveBeenCalledTimes(1);
      const appended = mockAppend.mock.calls[0][0] as HTMLElement;
      // The append target is the inner sized div (the second-level element).
      expect(appended).toBe((container.firstChild as HTMLElement).firstChild);
    });

    it('runs the initial update() effect on mount', () => {
      render(<QRCode palette="green" address={ADDRESS} size={200} />);

      expect(mockUpdate).toHaveBeenCalledTimes(1);
      expect(mockUpdate.mock.calls[0][0]).toMatchObject({ data: `miden:${ADDRESS}`, width: 200 });
    });
  });

  describe('palette treatments', () => {
    /** Resolves every `--qr-*` token to a distinct, assertable color. */
    const stubTokens = () =>
      jest.spyOn(window, 'getComputedStyle').mockReturnValue({
        getPropertyValue: (name: string) => `resolved(${name})`
      } as unknown as CSSStyleDeclaration);

    it('requires a palette: the page always names one of the five treatments', () => {
      // Built, not rendered: the point is the type, and a palette-less render has no treatment to draw.
      // @ts-expect-error `palette` is required; there is no default treatment.
      const element = <QRCode address={ADDRESS} size={200} />;
      expect(element.props).not.toHaveProperty('palette');
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

    it('recolours on a palette tap without blanking the code: the new palette is drawn aside, then shown', async () => {
      const gcs = stubTokens();
      const draw = deferred();
      mockGetRawData.mockImplementation((type: string) => (type === 'svg' ? draw.promise : undefined));
      try {
        const { rerender } = render(<QRCode address={ADDRESS} size={200} palette="green" />);
        const painted = mockInstances[0]!;
        rerender(<QRCode address={ADDRESS} size={200} palette="purple" />);

        // The painted code is never torn down for a colour change.
        expect(painted.updates).toHaveLength(1);
        const staged = mockInstances[1]!;
        expect(mockConstructor.mock.calls[1][0].dotsOptions.color).toBe('resolved(--qr-purple)');
        expect(staged.rawData).toEqual(['svg']);
        expect(showsCode(painted)).toBe(true);
        expect(showsCode(staged)).toBe(false);

        await act(async () => draw.resolve(drawnSvg()));
        expect(showsCode(staged)).toBe(true);
        expect(showsCode(painted)).toBe(false);
      } finally {
        gcs.mockRestore();
      }
    });

    it('settles on the last palette when taps outrun the drawing', async () => {
      const draws = [deferred(), deferred()];
      let n = 0;
      mockGetRawData.mockImplementation((type: string) => (type === 'svg' ? draws[n++]!.promise : undefined));
      const { rerender } = render(<QRCode address={ADDRESS} size={200} palette="green" />);
      rerender(<QRCode address={ADDRESS} size={200} palette="purple" />);
      rerender(<QRCode address={ADDRESS} size={200} palette="blue" />);

      await act(async () => draws[1]!.resolve(drawnSvg()));
      await act(async () => draws[0]!.resolve(drawnSvg()));
      expect(showsCode(mockInstances[2]!)).toBe(true);
      // Both staged draws used the same spare slot; what is committed (and exported) is the last one.
      mockGetRawData.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
      const ref = React.createRef<QRCodeHandle>();
      rerender(<QRCode ref={ref} address={ADDRESS} size={200} palette="blue" />);
      await ref.current!.getImageBlob();
      expect(mockInstances[2]!.rawData).toContain('png');
      expect(mockInstances[1]!.rawData).not.toContain('png');
    });

    it('never shows or exports a colour drawn for an address the code no longer carries', async () => {
      const draw = deferred();
      mockGetRawData.mockImplementation((type: string) => (type === 'svg' ? draw.promise : undefined));
      const ref = React.createRef<QRCodeHandle>();
      const { rerender, getByTestId } = render(<QRCode ref={ref} address={ADDRESS} size={200} palette="green" />);
      const painted = mockInstances[0]!;
      rerender(<QRCode ref={ref} address={ADDRESS} size={200} palette="purple" />);
      rerender(<QRCode ref={ref} address="mtst1other" size={200} palette="purple" />);

      await act(async () => draw.resolve(drawnSvg()));
      expect(showsCode(painted)).toBe(true);
      expect(showsCode(mockInstances[1]!)).toBe(false);
      expect(getByTestId('qr-code')).toHaveAttribute('data-qr-payload', 'miden:mtst1other');
      // The address change repainted the committed instance itself, with the new payload and the
      // palette it now shows.
      expect((painted.updates.at(-1) as { data: string }).data).toBe('miden:mtst1other');
      expect(getByTestId('qr-code')).toHaveAttribute('data-qr-palette', 'purple');

      mockGetRawData.mockResolvedValue(new Blob(['png'], { type: 'image/png' }));
      await ref.current!.getImageBlob();
      expect(painted.rawData).toContain('png');
      expect(mockInstances[1]!.rawData).not.toContain('png');
    });

    it('never blanks the code for a tap back to the colour it already shows', async () => {
      const draw = deferred();
      mockGetRawData.mockImplementation((type: string) => (type === 'svg' ? draw.promise : undefined));
      const { rerender } = render(<QRCode address={ADDRESS} size={200} palette="green" />);
      const painted = mockInstances[0]!;
      rerender(<QRCode address={ADDRESS} size={200} palette="purple" />);
      rerender(<QRCode address={ADDRESS} size={200} palette="green" />);

      // Back to what is painted: no repaint of the visible code, and the late purple draw is dropped.
      expect(painted.updates).toHaveLength(1);
      await act(async () => draw.resolve(drawnSvg()));
      expect(showsCode(painted)).toBe(true);
      expect(showsCode(mockInstances[1]!)).toBe(false);
    });

    it('reports the colour it painted, not the one it was asked for', async () => {
      const draw = deferred();
      mockGetRawData.mockImplementation((type: string) => (type === 'svg' ? draw.promise : undefined));
      const { rerender, getByTestId } = render(<QRCode address={ADDRESS} size={200} palette="green" />);
      rerender(<QRCode address={ADDRESS} size={200} palette="purple" />);

      expect(getByTestId('qr-code')).toHaveAttribute('data-qr-palette', 'green');
      await act(async () => draw.resolve(drawnSvg()));
      expect(getByTestId('qr-code')).toHaveAttribute('data-qr-palette', 'purple');
    });

    it('keeps the painted code, and says so, when a recolour draw fails', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        mockGetRawData.mockImplementation((type: string) =>
          type === 'svg' ? Promise.reject(new Error('draw failed')) : undefined
        );
        const { rerender, getByTestId } = render(<QRCode address={ADDRESS} size={200} palette="green" />);
        const painted = mockInstances[0]!;
        await act(async () => {
          rerender(<QRCode address={ADDRESS} size={200} palette="purple" />);
        });

        expect(warn).toHaveBeenCalledWith(expect.stringContaining('[QRCode]'), expect.any(Error));
        expect(showsCode(painted)).toBe(true);
        expect(getByTestId('qr-code')).toHaveAttribute('data-qr-palette', 'green');
      } finally {
        warn.mockRestore();
      }
    });

    it('keeps the painted code when a recolour draw settles with nothing drawn', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const draw = deferred();
        mockGetRawData.mockImplementation((type: string) => (type === 'svg' ? draw.promise : undefined));
        const { rerender, getByTestId } = render(<QRCode address={ADDRESS} size={200} palette="green" />);
        const painted = mockInstances[0]!;
        rerender(<QRCode address={ADDRESS} size={200} palette="purple" />);

        await act(async () => draw.resolve(null));
        expect(showsCode(painted)).toBe(true);
        expect(showsCode(mockInstances[1]!)).toBe(false);
        expect(getByTestId('qr-code')).toHaveAttribute('data-qr-palette', 'green');
      } finally {
        warn.mockRestore();
      }
    });

    it('exports the code that is on screen after a colour change', async () => {
      const draw = deferred();
      mockGetRawData.mockImplementation((type: string) =>
        type === 'svg' ? draw.promise : Promise.resolve(new Blob(['png'], { type: 'image/png' }))
      );
      const ref = React.createRef<QRCodeHandle>();
      const { rerender } = render(<QRCode ref={ref} address={ADDRESS} size={200} palette="green" />);
      rerender(<QRCode ref={ref} address={ADDRESS} size={200} palette="purple" />);
      await act(async () => draw.resolve(drawnSvg()));

      await ref.current!.getImageBlob();
      expect(mockInstances[1]!.rawData).toContain('png');
      expect(mockInstances[0]!.rawData).not.toContain('png');
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
      const { rerender } = render(<QRCode palette="green" address={ADDRESS} size={200} />);

      expect(mockConstructor).toHaveBeenCalledTimes(1);
      expect(mockUpdate).toHaveBeenCalledTimes(1);

      const nextAddress = 'mtst1zzzqzwh6s4gvcyzsvx726y6xvsgt5qv5qruqqypuyph';
      rerender(<QRCode palette="green" address={nextAddress} size={320} />);

      // useMemo([]) → the instance is created once and reused.
      expect(mockConstructor).toHaveBeenCalledTimes(1);
      // The append effect keys off the (stable) instance, so it does not re-run.
      expect(mockAppend).toHaveBeenCalledTimes(1);
      // The update effect re-runs with the recomputed options.
      expect(mockUpdate).toHaveBeenCalledTimes(2);
      expect(mockUpdate.mock.calls[1][0]).toMatchObject({ data: `miden:${nextAddress}`, width: 320 });
    });

    it('does not re-run the update effect when props are unchanged across a rerender', () => {
      const { rerender } = render(<QRCode palette="green" address={ADDRESS} size={200} />);
      expect(mockUpdate).toHaveBeenCalledTimes(1);

      // Same primitive props → memoized options identity is stable → no update.
      rerender(<QRCode palette="green" address={ADDRESS} size={200} />);
      expect(mockUpdate).toHaveBeenCalledTimes(1);
    });

    it('clears the inner container when unmounted (append effect cleanup)', () => {
      const { container, unmount } = render(<QRCode palette="green" address={ADDRESS} size={200} />);
      const inner = (container.firstChild as HTMLElement).firstChild as HTMLElement;
      // Simulate the library having injected markup so cleanup has something to clear.
      inner.innerHTML = '<svg></svg>';

      unmount();

      expect(inner.innerHTML).toBe('');
    });
  });

  describe('caption (#875)', () => {
    it('renders the caption under the modules and omits it when absent', () => {
      const { container, rerender } = render(
        <QRCode palette="green" address={ADDRESS} size={200} caption="Miden Testnet" />
      );
      const caption = container.querySelector('[data-testid="qr-code-caption"]');
      expect(caption).toHaveTextContent('Miden Testnet');

      rerender(<QRCode palette="green" address={ADDRESS} size={200} />);
      expect(container.querySelector('[data-testid="qr-code-caption"]')).toBeNull();
    });

    it('keeps the caption off screen when showCaption is false, but still captions the export', async () => {
      mockGetRawData.mockResolvedValue(new Blob(['png-bytes'], { type: 'image/png' }));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const ref = React.createRef<QRCodeHandle>();
        const { container } = render(
          <QRCode palette="green" ref={ref} address={ADDRESS} size={200} caption="Miden Testnet" showCaption={false} />
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
        render(<QRCode palette="green" ref={ref} address={ADDRESS} size={200} caption="Miden Testnet" />);

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
        render(<QRCode palette="green" ref={ref} address={ADDRESS} size={SIZE} caption="Miden Devnet" />);
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
      render(<QRCode palette="green" ref={ref} address={ADDRESS} size={200} />);

      const result = await ref.current!.getImageBlob();

      expect(mockGetRawData).toHaveBeenCalledWith('png');
      expect(result).toBe(blob);
    });

    it('resolves to null when getRawData yields a non-Blob (node Buffer path)', async () => {
      // Emulate the node path where getRawData resolves to a Buffer-like value.
      mockGetRawData.mockResolvedValue(new Uint8Array([1, 2, 3]));

      const ref = React.createRef<QRCodeHandle>();
      render(<QRCode palette="green" ref={ref} address={ADDRESS} size={200} />);

      const result = await ref.current!.getImageBlob();

      expect(result).toBeNull();
    });
  });

  it('exposes the displayName for React devtools', () => {
    expect(QRCode.displayName).toBe('QRCode');
  });
});
