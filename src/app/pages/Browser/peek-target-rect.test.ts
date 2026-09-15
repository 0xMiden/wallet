import { FALLBACK_BOTTOM_GUTTER, FALLBACK_CAPSULE_HEIGHT, resolveTargetRect } from './peek-target-rect';

describe('resolveTargetRect', () => {
  const mountBanner = (height: number) => {
    const banner = document.createElement('button');
    banner.setAttribute('data-testid', 'network-mode-banner');
    // jsdom has no layout, so the measured height is defined on the element.
    Object.defineProperty(banner, 'offsetHeight', { value: height });
    document.body.appendChild(banner);
  };

  afterEach(() => {
    document.body.innerHTML = '';
  });

  const live = { x: 0, y: 200, width: 390, height: 500 };
  const cached = { x: 0, y: 190, width: 390, height: 510 };
  const unmeasured = { x: 0, y: 0, width: 0, height: 0 };

  it('prefers the live slot rect over the cached one', () => {
    mountBanner(44);

    expect(resolveTargetRect(live, cached)).toBe(live);
  });

  it('uses the cached slot rect when the live one is missing or has no size yet', () => {
    expect(resolveTargetRect(null, cached)).toBe(cached);
    expect(resolveTargetRect(unmeasured, cached)).toBe(cached);
  });

  it('falls back below the capsule when nothing is measured and no banner renders (mainnet)', () => {
    expect(resolveTargetRect(null, null)).toEqual({
      x: 0,
      y: FALLBACK_CAPSULE_HEIGHT,
      width: window.innerWidth,
      height: window.innerHeight - FALLBACK_CAPSULE_HEIGHT - FALLBACK_BOTTOM_GUTTER
    });
  });

  it('starts the fallback below the network banner on a test network', () => {
    mountBanner(44);

    expect(resolveTargetRect(null, null)).toEqual({
      x: 0,
      y: FALLBACK_CAPSULE_HEIGHT + 44,
      width: window.innerWidth,
      height: window.innerHeight - FALLBACK_CAPSULE_HEIGHT - 44 - FALLBACK_BOTTOM_GUTTER
    });
  });

  it('ignores rects with no size and falls back', () => {
    expect(resolveTargetRect(unmeasured, unmeasured).y).toBe(FALLBACK_CAPSULE_HEIGHT);
  });
});
