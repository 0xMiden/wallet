import { CARD_HEIGHT, CARD_WIDTH } from './DappPeekCard';
import { FALLBACK_BOTTOM_GUTTER, FALLBACK_CAPSULE_HEIGHT, frontCardRect, resolveTargetRect } from './peek-target-rect';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

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

  it('starts right below the capsule on a test network too: no banner tops the page any more', () => {
    // The dApp confirm window still has one; the peek tray never shares a page with it.
    mountBanner(44);

    expect(resolveTargetRect(null, null)).toEqual({
      x: 0,
      y: FALLBACK_CAPSULE_HEIGHT,
      width: window.innerWidth,
      height: window.innerHeight - FALLBACK_CAPSULE_HEIGHT - FALLBACK_BOTTOM_GUTTER
    });
  });

  it('lands the fallback right under the capsule: safe area, content row, hairline and progress bar, no drag strip', () => {
    const IPHONE_SAFE_AREA_TOP = 62;
    const CAPSULE_ROW = 56;
    const CAPSULE_HAIRLINE = 1;
    const PROGRESS_BAR = 2;

    expect(FALLBACK_CAPSULE_HEIGHT).toBe(IPHONE_SAFE_AREA_TOP + CAPSULE_ROW + CAPSULE_HAIRLINE + PROGRESS_BAR);
  });

  it('ignores rects with no size and falls back', () => {
    expect(resolveTargetRect(unmeasured, unmeasured).y).toBe(FALLBACK_CAPSULE_HEIGHT);
  });
});

describe('frontCardRect', () => {
  it("frontCardRect anchors the card at the tray's bottom-right", () => {
    expect(frontCardRect(new DOMRect(214, 590, 164, CARD_HEIGHT))).toEqual({
      x: 378 - CARD_WIDTH,
      y: 590,
      width: CARD_WIDTH,
      height: CARD_HEIGHT,
      cornerRadius: 16
    });
  });
});
