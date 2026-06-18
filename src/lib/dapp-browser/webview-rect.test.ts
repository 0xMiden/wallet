import { rectFromDOMRect, rectsEqual, type WebViewRect } from './webview-rect';

const mockDOMRect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({
    left,
    top,
    width,
    height,
    x: left,
    y: top,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({})
  }) as DOMRect;

describe('rectFromDOMRect', () => {
  it('rounds integer rects identically', () => {
    expect(rectFromDOMRect(mockDOMRect(10, 20, 100, 200))).toEqual({ x: 10, y: 20, width: 100, height: 200 });
  });

  it('rounds sub-pixel left/top values', () => {
    // Round (not floor) to minimize drift during animations.
    expect(rectFromDOMRect(mockDOMRect(10.4, 20.6, 100, 200))).toEqual({ x: 10, y: 21, width: 100, height: 200 });
  });

  it('rounds sub-pixel width/height values', () => {
    expect(rectFromDOMRect(mockDOMRect(0, 0, 99.5, 200.4))).toEqual({ x: 0, y: 0, width: 100, height: 200 });
  });

  it('handles negative coordinates (offscreen)', () => {
    expect(rectFromDOMRect(mockDOMRect(-50, -10, 100, 200))).toEqual({ x: -50, y: -10, width: 100, height: 200 });
  });

  it('handles zero dimensions', () => {
    expect(rectFromDOMRect(mockDOMRect(0, 0, 0, 0))).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('rectsEqual', () => {
  const base: WebViewRect = { x: 10, y: 20, width: 100, height: 200 };

  it('returns true for identical rects', () => {
    expect(rectsEqual(base, { ...base })).toBe(true);
  });

  it('returns false when x differs', () => {
    expect(rectsEqual(base, { ...base, x: 11 })).toBe(false);
  });

  it('returns false when y differs', () => {
    expect(rectsEqual(base, { ...base, y: 21 })).toBe(false);
  });

  it('returns false when width differs', () => {
    expect(rectsEqual(base, { ...base, width: 101 })).toBe(false);
  });

  it('returns false when height differs', () => {
    expect(rectsEqual(base, { ...base, height: 201 })).toBe(false);
  });

  it('returns true when both are undefined', () => {
    expect(rectsEqual(undefined, undefined)).toBe(true);
  });

  it('returns false when one is undefined', () => {
    expect(rectsEqual(base, undefined)).toBe(false);
    expect(rectsEqual(undefined, base)).toBe(false);
  });
});
