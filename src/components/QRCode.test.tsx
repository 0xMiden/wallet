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

// The Miden logo is imported as `../../public/misc/brand/new-bread.svg?url`.
// The `?url` query suffix means it does NOT match the jest `\.svg$` asset
// mapper (anchored on a trailing `.svg`) and the real file has no `?url`
// variant on disk, so plain resolution fails. A virtual mock short-circuits
// resolution (mirrors src/app/atoms/Logo.test.tsx) and hands the import a
// distinct, assertable value.
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
      expect(outer).toHaveClass('bg-pure-white', 'rounded-10', 'p-2');

      const inner = outer.firstChild as HTMLElement;
      expect(inner.tagName).toBe('DIV');
      // Numeric size props become px strings on the DOM node.
      expect(inner).toHaveStyle({ width: '200px', height: '200px' });
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
