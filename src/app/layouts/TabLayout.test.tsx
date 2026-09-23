import React from 'react';

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { Transition } from 'framer-motion';

import { hapticSelection } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';

import { PageActiveContext, usePageActive } from './page-active';
import TabLayout from './TabLayout';

// ---------------------------------------------------------------------------
// Mutable mock state. Each mocked module reads from one of these objects so a
// test can drive platform / env / route / hook branches without re-mocking.
// (Prefixed `mock*` so the jest hoister lets the factories close over them.)
// ---------------------------------------------------------------------------
const mockLocation = { pathname: '/' };
const mockPlatform = { isMobile: false, isDesktop: false, isExtension: false, isIOS: false };
const mockEnv = { fullPage: false, sidePanel: false };
const mockReturning = { value: false };
const mockHasUnclaimed = { value: false };
const mockKeyboardVisible = { value: false };

// `lib/woozie` pulls in the full location/history/analytics stack. Stub the two
// symbols the layout uses: `navigate` (a spy) and `useLocation` (reads state).
jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
  useLocation: () => ({ pathname: mockLocation.pathname })
}));

// Haptics wrap the native Capacitor plugin; a spy lets us assert the selection
// buzz fires on a real tab change and stays silent on no-op re-taps.
jest.mock('lib/mobile/haptics', () => ({
  hapticSelection: jest.fn()
}));

// Platform detectors are pure booleans in production; make them read the shared
// state object so every containerStyles / skipSlideIn branch is reachable.
jest.mock('lib/platform', () => ({
  isMobile: () => mockPlatform.isMobile,
  isDesktop: () => mockPlatform.isDesktop,
  isExtension: () => mockPlatform.isExtension,
  isIOS: () => mockPlatform.isIOS
}));

jest.mock('lib/mobile/webview-state', () => ({
  isReturningFromWebview: () => mockReturning.value
}));

jest.mock('app/env', () => ({
  useAppEnv: () => ({ fullPage: mockEnv.fullPage, sidePanel: mockEnv.sidePanel })
}));

jest.mock('app/hooks/useHasUnclaimedNotes', () => ({
  useHasUnclaimedNotes: () => mockHasUnclaimed.value
}));

// Mobile soft-keyboard visibility. Driven by mock state so the hide-navbar
// wiring is testable; useHideNavbarWhileOpen is left REAL so it actually
// toggles body[data-hide-navbar].
jest.mock('lib/mobile/useKeyboardVisible', () => ({
  useKeyboardVisible: () => mockKeyboardVisible.value
}));

// `springs` is animation config only; the value is irrelevant to behaviour.
// `usePreset('fade')` returns a stand-in whose values the mount-fade tests
// look for on the motion wrapper.
const mockFadePreset = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  transition: { type: 'tween', duration: 0.42 }
};
jest.mock('lib/animation', () => ({
  springs: { standard: { type: 'spring' } },
  useMotion: (transition: Transition) => transition,
  usePreset: (name: string) => (name === 'fade' ? mockFadePreset : undefined)
}));

// Icons are SVG re-exports; render a stub that carries the name and classes the layout gives it,
// and expose the enum keys the layout references so `IconName.X` lookups don't blow up.
jest.mock('app/icons/v2', () => ({
  Icon: ({ name, className }: { name: string; className?: string }) => (
    <span data-testid={`icon-${name}`} className={className} />
  ),
  IconName: {
    Home: 'Home',
    Explore: 'Explore',
    Activity: 'Activity',
    Settings: 'Settings',
    Wallet: 'Wallet',
    Send: 'Send',
    Receive: 'Receive',
    Earn: 'Earn',
    Convert: 'Convert'
  }
}));

// Tab labels are localized; echo the key back so assertions read as keys.
jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key })
}));

// The home-group carousel is E2E territory; a marker div is enough to assert it
// mounts (vs. `children`) when the action bar is showing.
const homeSwipeRenders = { count: 0 };
jest.mock('app/layouts/HomeSwipeContainer', () => ({
  __esModule: true,
  default: () => {
    homeSwipeRenders.count += 1;
    return <div data-testid="home-swipe" />;
  }
}));

// framer-motion's `motion.div` — forward props onto a plain div and surface the
// `initial` prop (false = slide-in skipped, object = slide-in) for assertions.
jest.mock('framer-motion', () => ({
  useReducedMotion: () => false,
  motion: {
    div: React.forwardRef(({ children, initial, animate, transition, ...props }: any, ref: any) => (
      <div
        ref={ref}
        data-testid="motion-div"
        data-initial={JSON.stringify(initial)}
        data-animate={JSON.stringify(animate)}
        data-transition={JSON.stringify(transition)}
        {...props}
      >
        {children}
      </div>
    ))
  }
}));

// BottomNav / SegmentedActionBar — expose items, activeId and onChange as
// clickable buttons plus a synthetic "unknown id" button so the layout's
// route-lookup guard branches are all reachable.
jest.mock('components/ui', () => ({
  BottomNav: ({ items, activeId, onChange, docked, corner }: any) => (
    <div data-testid="bottom-nav" data-active={activeId} data-docked={String(!!docked)}>
      <div data-testid="bottom-nav-corner">{corner}</div>
      {items.map((it: any) => (
        <button
          key={it.id}
          data-testid={`nav-${it.id}`}
          data-dot={String(!!it.showDot)}
          onClick={() => onChange(it.id)}
        >
          {it.label}
        </button>
      ))}
      <button data-testid="nav-unknown" onClick={() => onChange('__nope__')}>
        unknown
      </button>
    </div>
  ),
  SegmentedActionBar: ({ items, activeId, onChange, className }: any) => (
    <div data-testid="action-bar" data-active={activeId} className={className}>
      {items.map((it: any) => (
        <button key={it.id} data-testid={`action-${it.id}`} onClick={() => onChange(it.id)}>
          {it.icon}
          {it.label}
        </button>
      ))}
      <button data-testid="action-unknown" onClick={() => onChange('__nope__')}>
        unknown
      </button>
    </div>
  )
}));

// The ribbon has its own suite; here it only has to land in the bar's corner, told which bar it is on.
jest.mock('components/NetworkModeRibbon', () => ({
  NetworkModeRibbon: ({ docked }: { docked: boolean }) => (
    <div data-testid="network-mode-ribbon" data-docked={String(docked)} />
  )
}));

const mockNavigate = navigate as jest.Mock;
const mockHaptic = hapticSelection as jest.Mock;

const renderLayout = (children: React.ReactNode = <div data-testid="child-content" />) =>
  render(<TabLayout>{children}</TabLayout>);

const getRoot = (container: HTMLElement) => container.firstChild as HTMLElement;

beforeEach(() => {
  jest.clearAllMocks();
  mockLocation.pathname = '/';
  mockPlatform.isMobile = false;
  mockPlatform.isDesktop = false;
  mockPlatform.isExtension = false;
  mockPlatform.isIOS = false;
  mockEnv.fullPage = false;
  mockEnv.sidePanel = false;
  mockReturning.value = false;
  mockHasUnclaimed.value = false;
  mockKeyboardVisible.value = false;
});

describe('TabLayout — active tab derivation (activeTabFromPath)', () => {
  it('maps the root path to the home tab', () => {
    mockLocation.pathname = '/';
    renderLayout();
    expect(screen.getByTestId('bottom-nav')).toHaveAttribute('data-active', 'home');
  });

  it('maps /browser to the explore tab', () => {
    mockLocation.pathname = '/browser';
    renderLayout();
    expect(screen.getByTestId('bottom-nav')).toHaveAttribute('data-active', 'explore');
  });

  it('maps /history to the activity tab', () => {
    mockLocation.pathname = '/history';
    renderLayout();
    expect(screen.getByTestId('bottom-nav')).toHaveAttribute('data-active', 'activity');
  });

  it('maps /activity-details to the activity tab', () => {
    mockLocation.pathname = '/activity-details/note-123';
    renderLayout();
    expect(screen.getByTestId('bottom-nav')).toHaveAttribute('data-active', 'activity');
  });

  it('maps /settings to the settings tab', () => {
    mockLocation.pathname = '/settings';
    renderLayout();
    expect(screen.getByTestId('bottom-nav')).toHaveAttribute('data-active', 'settings');
  });

  it('maps only the bare /settings root, since sub-pages never mount this shell', () => {
    // `/settings/<slug>` renders in FullScreenPage, so it cannot reach
    // activeTabFromPath at all — asserting a settings tab for it would be
    // testing a state the app cannot produce.
    mockLocation.pathname = '/settings/general-settings';
    renderLayout();
    expect(screen.getByTestId('bottom-nav')).toHaveAttribute('data-active', 'home');
  });

  it('maps an unrelated path (e.g. /token-detail) to the home tab', () => {
    mockLocation.pathname = '/token-detail/0xabc';
    renderLayout();
    expect(screen.getByTestId('bottom-nav')).toHaveAttribute('data-active', 'home');
  });

  it('falls back to the home tab when the path has no second segment (?? "" branch)', () => {
    // An empty pathname → split('/')[1] is undefined → the `?? ''` fallback.
    mockLocation.pathname = '';
    renderLayout();
    expect(screen.getByTestId('bottom-nav')).toHaveAttribute('data-active', 'home');
  });
});

describe('TabLayout — active action derivation (activeActionFromPath)', () => {
  it('marks Overview active on the root path', () => {
    mockLocation.pathname = '/';
    renderLayout();
    expect(screen.getByTestId('action-bar')).toHaveAttribute('data-active', 'overview');
  });

  it('marks Send active on /send', () => {
    mockLocation.pathname = '/send';
    renderLayout();
    expect(screen.getByTestId('action-bar')).toHaveAttribute('data-active', 'send');
  });

  it('marks Receive active on /receive', () => {
    mockLocation.pathname = '/receive';
    renderLayout();
    expect(screen.getByTestId('action-bar')).toHaveAttribute('data-active', 'receive');
  });

  it('marks Earn active on /earn', () => {
    mockLocation.pathname = '/earn';
    renderLayout();
    expect(screen.getByTestId('action-bar')).toHaveAttribute('data-active', 'earn');
  });

  it('marks Swap active on /swap', () => {
    mockLocation.pathname = '/swap';
    renderLayout();
    expect(screen.getByTestId('action-bar')).toHaveAttribute('data-active', 'swap');
  });
});

describe('TabLayout — action bar visibility (showActionBar)', () => {
  it('renders the action bar and HomeSwipeContainer for home-group routes', () => {
    mockLocation.pathname = '/send';
    renderLayout();
    expect(screen.getByTestId('action-bar')).toBeInTheDocument();
    // Nothing pads the row down from the top of the pane: the bar's own 4px is the whole gap.
    expect(screen.getByTestId('action-bar').parentElement!.className).toBe('shrink-0 relative z-10');
    expect(screen.getByTestId('home-swipe')).toBeInTheDocument();
    expect(screen.queryByTestId('child-content')).toBeNull();
  });

  it('gives the action bar its band on mobile only', () => {
    mockLocation.pathname = '/';
    mockPlatform.isMobile = true;
    const { unmount } = renderLayout();
    expect(screen.getByTestId('action-bar')).toHaveClass('bg-action-bar');
    unmount();

    mockPlatform.isMobile = false;
    renderLayout();
    expect(screen.getByTestId('action-bar')).not.toHaveClass('bg-action-bar');
  });

  it('hides the action bar and renders children for non-home routes', () => {
    mockLocation.pathname = '/history';
    renderLayout();
    expect(screen.queryByTestId('action-bar')).toBeNull();
    expect(screen.queryByTestId('home-swipe')).toBeNull();
    expect(screen.getByTestId('child-content')).toBeInTheDocument();
  });
});

describe('TabLayout — tabs list composition', () => {
  it('includes the Explore tab off-extension (4 tabs)', () => {
    mockPlatform.isExtension = false;
    renderLayout();
    expect(screen.getByTestId('nav-home')).toBeInTheDocument();
    expect(screen.getByTestId('nav-explore')).toBeInTheDocument();
    expect(screen.getByTestId('nav-activity')).toBeInTheDocument();
    expect(screen.getByTestId('nav-settings')).toBeInTheDocument();
  });

  it('drops the Explore tab on the extension (3 tabs)', () => {
    mockPlatform.isExtension = true;
    renderLayout();
    expect(screen.getByTestId('nav-home')).toBeInTheDocument();
    expect(screen.queryByTestId('nav-explore')).toBeNull();
    expect(screen.getByTestId('nav-activity')).toBeInTheDocument();
    expect(screen.getByTestId('nav-settings')).toBeInTheDocument();
  });

  it('orders Settings last, after Activity', () => {
    mockPlatform.isExtension = false;
    renderLayout();
    const ids = Array.from(screen.getByTestId('bottom-nav').querySelectorAll('[data-testid^="nav-"]')).map(el =>
      el.getAttribute('data-testid')
    );
    expect(ids).toEqual(['nav-home', 'nav-explore', 'nav-activity', 'nav-settings', 'nav-unknown']);
  });

  it('localizes every tab label', () => {
    // The `react-i18next` stub echoes the key, so a hardcoded English literal
    // would show up here as 'Home'/'Settings' rather than 'home'/'settings'.
    mockPlatform.isExtension = false;
    renderLayout();
    expect(screen.getByTestId('nav-home')).toHaveTextContent('home');
    expect(screen.getByTestId('nav-explore')).toHaveTextContent('explore');
    expect(screen.getByTestId('nav-activity')).toHaveTextContent('activity');
    expect(screen.getByTestId('nav-settings')).toHaveTextContent('settings');
  });

  it('shows the unclaimed-notes dot on the Activity tab when notes are pending', () => {
    mockHasUnclaimed.value = true;
    renderLayout();
    expect(screen.getByTestId('nav-activity')).toHaveAttribute('data-dot', 'true');
  });

  it('hides the unclaimed-notes dot when there are no pending notes', () => {
    mockHasUnclaimed.value = false;
    renderLayout();
    expect(screen.getByTestId('nav-activity')).toHaveAttribute('data-dot', 'false');
  });
});

describe('TabLayout — network corner ribbon', () => {
  it.each([
    ['mobile (docked)', true],
    ['extension/desktop (floating)', false]
  ])('puts the network ribbon in the bottom nav’s corner on %s', (_label, mobile) => {
    mockPlatform.isMobile = mobile;
    renderLayout();
    expect(screen.getByTestId('bottom-nav-corner')).toContainElement(screen.getByTestId('network-mode-ribbon'));
    expect(screen.getByTestId('network-mode-ribbon')).toHaveAttribute('data-docked', String(mobile));
  });

  it('shows no banner above the tabs', () => {
    renderLayout();
    expect(screen.queryByTestId('network-mode-banner')).not.toBeInTheDocument();
  });
});

describe('TabLayout — swap action availability (isSwapEnabled)', () => {
  it('shows the Swap action segment off-iOS', () => {
    mockPlatform.isIOS = false;
    mockLocation.pathname = '/';
    renderLayout();
    expect(screen.getByTestId('action-swap')).toBeInTheDocument();
  });

  it('shows the Swap action segment on iOS too (swap re-enabled for distribution)', () => {
    mockPlatform.isIOS = true;
    mockLocation.pathname = '/';
    renderLayout();
    expect(screen.getByTestId('action-swap')).toBeInTheDocument();
    // The rest of the action bar is unaffected.
    expect(screen.getByTestId('action-overview')).toBeInTheDocument();
    expect(screen.getByTestId('action-send')).toBeInTheDocument();
    expect(screen.getByTestId('action-receive')).toBeInTheDocument();
  });
});

describe('TabLayout — action colours', () => {
  it.each([
    ['overview', 'Wallet'],
    ['send', 'Send'],
    ['receive', 'Receive'],
    ['earn', 'Earn'],
    ['swap', 'Convert']
  ])('draws the %s icon in its action colour', (action, icon) => {
    mockLocation.pathname = '/';
    renderLayout();
    const glyph = within(screen.getByTestId(`action-${action}`)).getByTestId(`icon-${icon}`);
    expect(glyph).toHaveClass(`text-action-${action}`);
  });
});

describe('TabLayout — tab change handling (handleTabChange)', () => {
  it('navigates and fires haptics when tapping a different tab', () => {
    mockLocation.pathname = '/';
    renderLayout();
    fireEvent.click(screen.getByTestId('nav-explore'));
    expect(mockHaptic).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/browser');
  });

  it('is a silent no-op when re-tapping the tab already on-route', () => {
    // Home maps to '/', and we are already on '/', so to === pathname.
    mockLocation.pathname = '/';
    renderLayout();
    fireEvent.click(screen.getByTestId('nav-home'));
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockHaptic).not.toHaveBeenCalled();
  });

  it('ignores taps for an unknown tab id (no matching route)', () => {
    mockLocation.pathname = '/';
    renderLayout();
    fireEvent.click(screen.getByTestId('nav-unknown'));
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockHaptic).not.toHaveBeenCalled();
  });

  it('navigates to /settings and fires haptics when tapping the Settings tab', () => {
    mockLocation.pathname = '/';
    renderLayout();
    fireEvent.click(screen.getByTestId('nav-settings'));
    expect(mockHaptic).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/settings');
  });

  it('is a silent no-op when re-tapping Settings while already on /settings', () => {
    mockLocation.pathname = '/settings';
    renderLayout();
    fireEvent.click(screen.getByTestId('nav-settings'));
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockHaptic).not.toHaveBeenCalled();
  });
});

describe('TabLayout — action change handling (handleActionChange)', () => {
  it('navigates when tapping a different action segment', () => {
    mockLocation.pathname = '/';
    renderLayout();
    fireEvent.click(screen.getByTestId('action-send'));
    expect(mockNavigate).toHaveBeenCalledWith('/send');
  });

  it('is a no-op when the tapped action is already the current route', () => {
    // Overview maps to '/', matching the current pathname.
    mockLocation.pathname = '/';
    renderLayout();
    fireEvent.click(screen.getByTestId('action-overview'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('ignores an unknown action id (no matching route)', () => {
    mockLocation.pathname = '/';
    renderLayout();
    fireEvent.click(screen.getByTestId('action-unknown'));
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});

describe('TabLayout — container sizing (containerStyles) & clip class', () => {
  it('fills 100% and clips horizontally on mobile', () => {
    mockPlatform.isMobile = true;
    const { container } = renderLayout();
    const root = getRoot(container);
    expect(root).toHaveStyle({ height: '100%', width: '100%' });
    expect(root).toHaveClass('overflow-x-clip');
    expect(root).not.toHaveClass('overflow-hidden');
  });

  it('caps width on desktop', () => {
    mockPlatform.isDesktop = true;
    const { container } = renderLayout();
    const root = getRoot(container);
    expect(root).toHaveStyle({ height: '100%', width: '100%', maxWidth: '600px' });
    expect(root).toHaveClass('overflow-hidden');
  });

  it('fills the frame in the extension side panel', () => {
    mockEnv.sidePanel = true;
    const { container } = renderLayout();
    expect(getRoot(container)).toHaveStyle({ height: '100%', width: '100%' });
  });

  it('uses fixed full-page dimensions in the extension full-page mode', () => {
    mockEnv.fullPage = true;
    const { container } = renderLayout();
    expect(getRoot(container)).toHaveStyle({ height: '640px', width: '600px' });
  });

  it('uses fixed popup dimensions in the extension popup (all flags off)', () => {
    const { container } = renderLayout();
    expect(getRoot(container)).toHaveStyle({ height: '100%', width: '360px' });
  });
});

describe('TabLayout — bottom nav footer padding', () => {
  it('adds bottom padding to the footer off-mobile', () => {
    mockPlatform.isMobile = false;
    renderLayout();
    expect(screen.getByTestId('bottom-nav').parentElement).toHaveClass('pb-2');
  });

  it('omits footer bottom padding on mobile (safe-area handles it)', () => {
    mockPlatform.isMobile = true;
    renderLayout();
    expect(screen.getByTestId('bottom-nav').parentElement).not.toHaveClass('pb-2');
  });

  it('floats the pill off-mobile and docks the bar edge to edge on mobile', () => {
    mockPlatform.isMobile = false;
    const { unmount } = renderLayout();
    expect(screen.getByTestId('bottom-nav')).toHaveAttribute('data-docked', 'false');
    expect(screen.getByTestId('bottom-nav').parentElement).toHaveClass('px-4');
    unmount();

    mockPlatform.isMobile = true;
    renderLayout();
    expect(screen.getByTestId('bottom-nav')).toHaveAttribute('data-docked', 'true');
    expect(screen.getByTestId('bottom-nav').parentElement).not.toHaveClass('px-4');
  });

  // The docked bar has to sink by exactly the body's bottom padding. Repeating that value
  // here instead of reading mobile.html's --app-safe-bottom is what left the bar 4px above
  // the screen edge, with its top rule still showing once it slid away.
  it('sinks the docked footer by the safe-area floor the body declares', () => {
    mockPlatform.isMobile = true;
    renderLayout();

    const footer = screen.getByTestId('bottom-nav').parentElement!.parentElement!;
    expect(footer.style.bottom).toBe('calc(-1 * var(--app-safe-bottom, max(16px, env(safe-area-inset-bottom))))');
  });
});

describe('TabLayout — docked bar hides while scrolling down on mobile', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  // Any element inside the layout stands in for a pane's scroll region: the
  // container listens in the capture phase, so the target's depth is irrelevant.
  const scrollRegion = () => screen.getByTestId('bottom-nav');
  const bar = () => screen.getByTestId('bottom-nav').parentElement!;
  const scrollTo = (top: number) => {
    Object.defineProperty(scrollRegion(), 'scrollTop', { value: top, configurable: true });
    fireEvent.scroll(scrollRegion());
  };

  it('slides the bar away on a downward scroll and brings it back once scrolling stops', () => {
    mockPlatform.isMobile = true;
    renderLayout();
    scrollTo(0);
    scrollTo(40);
    expect(bar()).toHaveClass('translate-y-full');

    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(bar()).not.toHaveClass('translate-y-full');
  });

  it('brings the bar back as soon as the scroll reverses upward', () => {
    mockPlatform.isMobile = true;
    renderLayout();
    scrollTo(0);
    scrollTo(80);
    expect(bar()).toHaveClass('translate-y-full');
    scrollTo(60);
    expect(bar()).not.toHaveClass('translate-y-full');
  });

  // The bar's own state lives in the bar. While it sat in TabLayout, every hide, show and idle
  // reset re-rendered the home carousel and made Framer re-measure the action bar's layout nodes,
  // in the middle of the scroll that caused it.
  it('does not re-render the home carousel while the bar hides and returns', () => {
    mockPlatform.isMobile = true;
    mockLocation.pathname = '/';
    renderLayout();
    scrollTo(0);
    const before = homeSwipeRenders.count;

    scrollTo(40);
    expect(bar()).toHaveClass('translate-y-full');
    act(() => {
      jest.advanceTimersByTime(300);
    });
    expect(bar()).not.toHaveClass('translate-y-full');

    expect(homeSwipeRenders.count).toBe(before);
  });

  it('never hides the floating pill off-mobile', () => {
    mockPlatform.isMobile = false;
    renderLayout();
    scrollTo(0);
    scrollTo(80);
    expect(bar()).not.toHaveClass('translate-y-full');
  });
});

describe('TabLayout — Home band through the status bar', () => {
  afterEach(() => document.body.removeAttribute('data-home-band'));

  it('flags body while Home is the active tab on mobile, and clears it on Explore', () => {
    mockPlatform.isMobile = true;
    mockLocation.pathname = '/';
    const { unmount } = renderLayout();
    expect(document.body.hasAttribute('data-home-band')).toBe(true);
    unmount();
    expect(document.body.hasAttribute('data-home-band')).toBe(false);

    mockLocation.pathname = '/browser';
    renderLayout();
    expect(document.body.hasAttribute('data-home-band')).toBe(false);
  });

  it('follows the route on one mounted layout, across Home-group routes', () => {
    mockPlatform.isMobile = true;
    mockLocation.pathname = '/';
    const { rerender } = renderLayout();
    expect(document.body.hasAttribute('data-home-band')).toBe(true);

    mockLocation.pathname = '/browser';
    rerender(<TabLayout>{<div />}</TabLayout>);
    expect(document.body.hasAttribute('data-home-band')).toBe(false);

    mockLocation.pathname = '/send';
    rerender(<TabLayout>{<div />}</TabLayout>);
    expect(document.body.hasAttribute('data-home-band')).toBe(true);
  });

  it('clears the flag while a slide page covers Home, and sets it again when Home is back on screen', () => {
    mockPlatform.isMobile = true;
    mockLocation.pathname = '/';
    const { rerender } = render(
      <PageActiveContext.Provider value={false}>
        <TabLayout>{<div />}</TabLayout>
      </PageActiveContext.Provider>
    );
    expect(document.body.hasAttribute('data-home-band')).toBe(false);

    rerender(
      <PageActiveContext.Provider value={true}>
        <TabLayout>{<div />}</TabLayout>
      </PageActiveContext.Provider>
    );
    expect(document.body.hasAttribute('data-home-band')).toBe(true);
  });

  it('never flags body off-mobile', () => {
    mockPlatform.isMobile = false;
    mockLocation.pathname = '/';
    renderLayout();
    expect(document.body.hasAttribute('data-home-band')).toBe(false);
  });
});

describe('TabLayout — mount fade and tab panes', () => {
  const initialOf = () => screen.getByTestId('motion-div').getAttribute('data-initial');
  const paneOf = (id: string) => document.querySelector(`[data-tab-pane="${id}"]`);

  it('fades the layout in once on mount', () => {
    mockLocation.pathname = '/history';
    renderLayout();
    expect(initialOf()).toBe(JSON.stringify({ opacity: 0 }));
  });

  it('fades on the design system fade preset', () => {
    mockLocation.pathname = '/history';
    renderLayout();
    const wrapper = screen.getByTestId('motion-div');
    expect(wrapper.getAttribute('data-initial')).toBe(JSON.stringify(mockFadePreset.initial));
    expect(wrapper.getAttribute('data-animate')).toBe(JSON.stringify(mockFadePreset.animate));
    expect(wrapper.getAttribute('data-transition')).toBe(JSON.stringify(mockFadePreset.transition));
  });

  it('skips the fade when returning from a webview on mobile', () => {
    mockPlatform.isMobile = true;
    mockReturning.value = true;
    mockLocation.pathname = '/history';
    renderLayout();
    expect(initialOf()).toBe('false');
  });

  it('keeps one fade wrapper across a tab change instead of remounting it', () => {
    mockLocation.pathname = '/';
    const { rerender } = renderLayout();
    const wrapper = screen.getByTestId('motion-div');
    mockLocation.pathname = '/history';
    rerender(<TabLayout>{<div data-testid="child-content" />}</TabLayout>);
    expect(screen.getByTestId('motion-div')).toBe(wrapper);
  });

  it('keeps a visited tab mounted but hidden and inert while another tab is active', () => {
    mockLocation.pathname = '/';
    const { rerender } = renderLayout();
    const homeSwipe = screen.getByTestId('home-swipe');

    mockLocation.pathname = '/history';
    rerender(<TabLayout>{<div data-testid="child-content" />}</TabLayout>);
    expect(screen.getByTestId('home-swipe')).toBe(homeSwipe);
    const homePane = paneOf('home');
    expect(homePane).toContainElement(screen.getByTestId('action-bar'));
    expect(homePane).toHaveStyle({ visibility: 'hidden' });
    expect(homePane).toHaveAttribute('inert');
    expect(homePane).toHaveAttribute('aria-hidden', 'true');
    const activityPane = paneOf('activity');
    expect(activityPane).toContainElement(screen.getByTestId('child-content'));
    expect(activityPane).toHaveStyle({ visibility: 'visible' });
    expect(activityPane).not.toHaveAttribute('inert');

    mockLocation.pathname = '/';
    rerender(<TabLayout>{<div data-testid="child-content" />}</TabLayout>);
    expect(screen.getByTestId('home-swipe')).toBe(homeSwipe);
    expect(paneOf('home')).toHaveStyle({ visibility: 'visible' });
    expect(paneOf('activity')).toHaveStyle({ visibility: 'hidden' });
  });

  // Every route PageRouter wraps in TabLayout. A tab that lights up in the nav without a pane shows a
  // blank page, which is how Settings once shipped.
  it.each([
    ['/', 'home'],
    ['/send', 'home'],
    ['/receive', 'home'],
    ['/earn', 'home'],
    ['/swap', 'home'],
    ['/browser', 'explore'],
    ['/history', 'activity'],
    ['/history/program-1', 'activity'],
    ['/settings', 'settings']
  ])('renders %s in a visible, interactive %s pane', (pathname, tab) => {
    mockLocation.pathname = pathname;
    renderLayout(<div data-testid="routed-content" />);
    const pane = paneOf(tab);
    expect(pane?.querySelector('[data-testid="routed-content"], [data-testid="home-swipe"]')).not.toBeNull();
    expect(pane).toHaveStyle({ visibility: 'visible' });
    expect(pane).not.toHaveAttribute('inert');
  });

  it('tells each pane whether it is on screen, and no pane is on screen under a covered layer', () => {
    function Probe({ name }: { name: string }) {
      return <span data-testid={`probe-${name}`}>{usePageActive() ? 'on screen' : 'off screen'}</span>;
    }
    mockLocation.pathname = '/history';
    const { rerender } = renderLayout(<Probe name="activity" />);
    expect(screen.getByTestId('probe-activity')).toHaveTextContent('on screen');

    mockLocation.pathname = '/settings';
    rerender(<TabLayout>{<Probe name="settings" />}</TabLayout>);
    expect(screen.getByTestId('probe-activity')).toHaveTextContent('off screen');
    expect(screen.getByTestId('probe-settings')).toHaveTextContent('on screen');

    rerender(
      <PageActiveContext.Provider value={false}>
        <TabLayout>{<Probe name="settings" />}</TabLayout>
      </PageActiveContext.Provider>
    );
    expect(screen.getByTestId('probe-settings')).toHaveTextContent('off screen');
  });

  it('refreshes the active tab content on every render', () => {
    mockLocation.pathname = '/history';
    const { rerender } = renderLayout(<div data-testid="child-content">one</div>);
    rerender(
      <TabLayout>
        <div data-testid="child-content">two</div>
      </TabLayout>
    );
    expect(screen.getByTestId('child-content')).toHaveTextContent('two');
  });
});

describe('TabLayout — footer scaffolding', () => {
  it('keeps the action bar inside the home pane and one navbar across tab changes', () => {
    mockPlatform.isMobile = true;
    mockLocation.pathname = '/';
    const { rerender } = renderLayout();
    const navbar = screen.getByTestId('bottom-nav');
    const wrapper = screen.getByTestId('motion-div');
    expect(wrapper).toContainElement(screen.getByTestId('action-bar'));
    expect(wrapper).not.toContainElement(navbar);

    mockLocation.pathname = '/history';
    rerender(
      <TabLayout>
        <div data-testid="child-content" />
      </TabLayout>
    );
    expect(screen.getByTestId('bottom-nav')).toBe(navbar);
    expect(document.querySelector('[data-tab-pane="home"]')).toHaveStyle({ visibility: 'hidden' });
    expect(document.querySelector('[data-tab-pane="activity"]')).not.toContainElement(screen.getByTestId('action-bar'));
  });

  it('exposes the tabbar footer measurement hook for the dApp bubble host', () => {
    const { container } = renderLayout();
    expect(container.querySelector('[data-tabbar-footer="true"]')).toBeInTheDocument();
  });
});

describe('TabLayout — hides the bottom nav while the mobile keyboard is up', () => {
  it('flags body[data-hide-navbar] when the keyboard is visible and clears it on unmount', () => {
    mockKeyboardVisible.value = true;
    const { unmount } = renderLayout();

    // useHideNavbarWhileOpen(useKeyboardVisible()) drives the
    // body[data-hide-navbar] rule in main.css.
    expect(document.body.hasAttribute('data-hide-navbar')).toBe(true);

    unmount();
    expect(document.body.hasAttribute('data-hide-navbar')).toBe(false);
  });

  it('leaves the bottom nav visible when the keyboard is down', () => {
    mockKeyboardVisible.value = false;
    renderLayout();

    expect(document.body.hasAttribute('data-hide-navbar')).toBe(false);
  });
});
