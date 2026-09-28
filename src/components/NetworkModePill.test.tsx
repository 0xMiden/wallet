import React from 'react';

import { act, fireEvent, render, screen } from '@testing-library/react';

import { hapticLight } from 'lib/mobile/haptics';

import { NetworkModePill } from './NetworkModePill';

let mockLanguage = 'en';
jest.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, string>) => (params ? `${key}:${params.network}` : key),
    i18n: { resolvedLanguage: mockLanguage }
  })
}));

jest.mock('lib/mobile/haptics', () => ({ hapticLight: jest.fn() }));

let mockNetworkKey: 'testnet' | 'devnet' | 'localnet' | null = 'testnet';
jest.mock('lib/miden-chain/effective-endpoints', () => ({
  getTestNetworkNameKey: () => mockNetworkKey
}));

// The build's network drives the brand ramp (slate on a devnet build), independently of the
// effective network a Developer Settings override may point at. Other modules read it at import,
// before this file's own constants exist, so its state lives inside the factory.
jest.mock('lib/miden-chain/networks-config', () => {
  const build = { network: 'testnet' };
  return {
    ...jest.requireActual('lib/miden-chain/networks-config'),
    mockBuild: build,
    get DEFAULT_NETWORK() {
      return build.network;
    }
  };
});
const { mockBuild } = jest.requireMock<{ mockBuild: { network: string } }>('lib/miden-chain/networks-config');

// The real sheet, so opening from the pill and closing it are exercised end to end; only its
// platform edges are stubbed. The shared Drawer closes the sheet on mobile back (drawer.test pins
// how), so the stand-in records whether the sheet opts out and exposes the close it would call.
let mockDrawerCloseOnBack: boolean | undefined = true;
jest.mock('lib/woozie', () => ({ useLocation: () => ({ pathname: '/', hash: '' }) }));
jest.mock('app/providers/DappBrowserProvider', () => ({ useHideForegroundDappWhileOpen: jest.fn() }));
jest.mock('lib/ui/drawer', () => ({
  Drawer: ({
    open,
    onOpenChange,
    closeOnBack,
    children
  }: {
    open: boolean;
    onOpenChange?: (open: boolean) => void;
    closeOnBack?: boolean;
    children: React.ReactNode;
  }) => {
    mockDrawerCloseOnBack = closeOnBack;
    return open ? (
      <div role="dialog">
        <button type="button" data-testid="drawer-back" onClick={() => onOpenChange?.(false)} />
        {children}
      </div>
    ) : null;
  },
  DrawerContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DrawerTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  DrawerDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DrawerFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}));

const pill = () => screen.getByTestId('network-mode-pill');

describe('NetworkModePill', () => {
  beforeEach(() => {
    mockNetworkKey = 'testnet';
    mockBuild.network = 'testnet';
    mockLanguage = 'en';
    jest.mocked(hapticLight).mockClear();
  });

  it.each(['testnet', 'devnet', 'localnet'] as const)(
    'names the effective network and says its tokens have no value (%s)',
    key => {
      mockNetworkKey = key;
      render(<NetworkModePill />);

      expect(pill()).toHaveTextContent(`${key}·networkModePillNoValue`);
    }
  );

  it('renders nothing on mainnet', () => {
    mockNetworkKey = null;
    const { container } = render(<NetworkModePill />);

    expect(container).toBeEmptyDOMElement();
  });

  it('is named by the sentence it shows, and says it opens a dialog', () => {
    render(<NetworkModePill />);

    // Its visible words are its name, so voice control can say what the screen shows (WCAG 2.5.3).
    expect(screen.getByRole('button', { name: /^testnet.*networkModePillNoValue$/ })).toBe(pill());
    expect(pill()).not.toHaveAttribute('aria-label');
    expect(pill()).toHaveAttribute('aria-haspopup', 'dialog');
    expect(pill()).toHaveAttribute('aria-expanded', 'false');
  });

  it('is a full-width neutral pill: the network in ink, the reason and the info glyph muted', () => {
    render(<NetworkModePill />);

    expect(pill()).toHaveClass('w-full', 'bg-fill', 'text-ink', 'h-8');
    expect(screen.getByText('networkModePillNoValue')).toHaveClass('text-muted');
    expect(pill().querySelector('svg')).toHaveClass('text-muted');
  });

  it.each([
    ['en', '14px'],
    ['en-GB', '14px'],
    ['es', '11px'],
    ['ru', '11px'],
    ['zh-CN', '11px']
  ])('sets the line at the locale’s size (%s: %s)', (language, size) => {
    mockLanguage = language;
    render(<NetworkModePill />);

    expect(screen.getByTestId('network-mode-pill-text')).toHaveStyle({ fontSize: size });
  });

  it('opens the explanation sheet on tap, with one light haptic', () => {
    render(<NetworkModePill />);
    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();

    fireEvent.click(pill());

    expect(screen.getByTestId('network-mode-sheet')).toBeInTheDocument();
    expect(screen.getByRole('heading')).toHaveTextContent('networkModeSheetTitle:testnet');
    expect(pill()).toHaveAttribute('aria-expanded', 'true');
    expect(hapticLight).toHaveBeenCalledTimes(1);
  });

  it('closes the sheet on mobile back through the shared Drawer, which the sheet does not opt out of', () => {
    render(<NetworkModePill />);
    fireEvent.click(pill());
    expect(mockDrawerCloseOnBack).toBeUndefined();

    fireEvent.click(screen.getByTestId('drawer-back'));

    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();
    expect(pill()).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the sheet on "I understand"', () => {
    render(<NetworkModePill />);
    fireEvent.click(pill());

    fireEvent.click(screen.getByTestId('network-mode-sheet-cta'));

    expect(screen.queryByTestId('network-mode-sheet')).not.toBeInTheDocument();
  });
});

describe('NetworkModePill: fitting the line', () => {
  // The layout jsdom does not do. The sentence is `mockPerPx` wide per pixel of font plus the
  // separator's 12px of padding, which does not scale; the label starts 28px in, and the trailing
  // glyph sits `slot` plus the 6px gap after it. The boxes are found by the pill's structure, not by
  // the slots the fit reads, so the geometry is the same whichever way the fit finds them. The rects
  // give that geometry unrounded, and offsetLeft and offsetWidth give it rounded to whole pixels, as
  // a browser does.
  const SEPARATOR_PAD_PX = 6;
  const GAP_PX = 6;
  const LABEL_LEFT_PX = 28;
  let slot = 300;
  let mockPerPx = 30;

  const text = () => screen.getByTestId('network-mode-pill-text');
  const fontPx = () => parseFloat(text().style.fontSize);
  const lineWidth = () => text().getBoundingClientRect().width;
  const isPillChild = (el: HTMLElement) => el.parentElement?.dataset.testid === 'network-mode-pill';
  const isLabel = (el: HTMLElement) => isPillChild(el) && el.querySelector('[data-testid="network-mode-pill-text"]');
  const isTrailing = (el: HTMLElement) => isPillChild(el) && el.parentElement?.lastElementChild === el;
  const leftOf = (el: HTMLElement) => {
    if (isLabel(el)) return LABEL_LEFT_PX;
    if (isTrailing(el)) return LABEL_LEFT_PX + slot + GAP_PX;
    return 0;
  };
  const widthOf = (el: HTMLElement) =>
    el.dataset.testid === 'network-mode-pill-text'
      ? mockPerPx * parseFloat(el.style.fontSize) + 2 * SEPARATOR_PAD_PX
      : 0;

  let resize: () => void = () => {};
  const observed: Element[] = [];
  // Every observe and disconnect in order, each naming its observer by number, so a test can tell
  // which observers are still live.
  const observerCalls: string[] = [];
  let observerCount = 0;
  class MockResizeObserver {
    private readonly id = (observerCount += 1);
    constructor(callback: () => void) {
      resize = callback;
    }
    observe(target: Element) {
      observed.push(target);
      observerCalls.push(`observe ${this.id}`);
    }
    unobserve() {}
    disconnect() {
      observerCalls.push(`disconnect ${this.id}`);
    }
  }

  beforeEach(() => {
    mockNetworkKey = 'testnet';
    mockLanguage = 'en';
    slot = 300;
    mockPerPx = 30;
    observed.length = 0;
    observerCalls.length = 0;
    observerCount = 0;
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return new DOMRect(leftOf(this), 0, widthOf(this), 0);
    });
    jest.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return Math.round(widthOf(this));
    });
    jest.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
      return Math.round(leftOf(this));
    });
    // What Tailwind's stylesheet gives the classes the fit reads, and the line's own inline size.
    jest.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
      const style = document.createElement('span').style;
      if (el instanceof HTMLElement) style.fontSize = el.style.fontSize;
      if (el.classList.contains('gap-1.5')) style.columnGap = `${GAP_PX}px`;
      if (el.classList.contains('px-1.5')) {
        style.paddingLeft = `${SEPARATOR_PAD_PX}px`;
        style.paddingRight = `${SEPARATOR_PAD_PX}px`;
      }
      return style;
    });
    Object.defineProperty(window, 'ResizeObserver', { value: MockResizeObserver, configurable: true, writable: true });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Reflect.deleteProperty(window, 'ResizeObserver');
    Reflect.deleteProperty(document, 'fonts');
  });

  it('shrinks a line wider than its slot until it fits, the fixed separator padding included', () => {
    render(<NetworkModePill />);

    expect(fontPx()).toBeLessThan(14);
    expect(lineWidth()).toBeLessThanOrEqual(slot);
    // Exact, not merely small enough: within one 0.1px step of the slot.
    expect(lineWidth()).toBeGreaterThan(slot - 0.1 * mockPerPx);
  });

  it('fits the unrounded room, which whole-pixel offsets overstate', () => {
    // The glyph's edge at 336.85px rounds up to 337, a room of 303px where the line has 302.85px.
    slot = 302.85;
    render(<NetworkModePill />);

    expect(lineWidth()).toBeLessThanOrEqual(slot);
    expect(lineWidth()).toBeGreaterThan(slot - 0.1 * mockPerPx);
  });

  it.each([
    ['the language', () => (mockLanguage = 'ru')],
    ['the network name', () => (mockNetworkKey = 'localnet')]
  ])('re-fits when %s changes the sentence under the same ceiling', (_what, change) => {
    mockLanguage = 'es';
    mockPerPx = 20;
    const { rerender } = render(<NetworkModePill />);
    expect(fontPx()).toBe(11);

    change();
    mockPerPx = 30;
    rerender(<NetworkModePill />);

    expect(fontPx()).toBe(9.6);
    expect(lineWidth()).toBeLessThanOrEqual(slot);
  });

  it('re-fits when the pill resizes, observing its box rather than the inline line', () => {
    render(<NetworkModePill />);
    expect(observed).toEqual([pill()]);

    slot = 270;
    act(() => resize());

    expect(lineWidth()).toBeLessThanOrEqual(slot);
    expect(lineWidth()).toBeGreaterThan(slot - 0.1 * mockPerPx);
  });

  it('disconnects the old observer before the next observes when the language or network changes', () => {
    const { rerender } = render(<NetworkModePill />);
    expect(observerCalls).toEqual(['observe 1']);

    mockLanguage = 'ru';
    rerender(<NetworkModePill />);
    expect(observerCalls).toEqual(['observe 1', 'disconnect 1', 'observe 2']);

    mockNetworkKey = 'localnet';
    rerender(<NetworkModePill />);
    expect(observerCalls).toEqual(['observe 1', 'disconnect 1', 'observe 2', 'disconnect 2', 'observe 3']);
  });

  it('re-fits once web fonts load, and on unmount removes that listener and disconnects its observer', () => {
    const fonts = new EventTarget();
    Object.defineProperty(document, 'fonts', { value: fonts, configurable: true });
    const addListener = jest.spyOn(fonts, 'addEventListener');
    const removeListener = jest.spyOn(fonts, 'removeEventListener');
    mockPerPx = 20;
    const { unmount } = render(<NetworkModePill />);
    expect(fontPx()).toBe(14);
    expect(addListener).toHaveBeenCalledTimes(1);
    const listener = addListener.mock.calls[0]?.[1];

    // The web face is wider than the fallback the first fit measured.
    mockPerPx = 30;
    act(() => {
      fonts.dispatchEvent(new Event('loadingdone'));
    });
    expect(lineWidth()).toBeLessThanOrEqual(slot);
    expect(fontPx()).toBeLessThan(14);

    unmount();
    expect(removeListener).toHaveBeenCalledWith('loadingdone', listener);
    expect(observerCalls).toEqual(['observe 1', 'disconnect 1']);
  });
});
