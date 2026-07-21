import React from 'react';

import { render, screen, fireEvent } from '@testing-library/react';

import { hapticSelection } from 'lib/mobile/haptics';
import { navigate } from 'lib/woozie';

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

// `springs` is animation config only; the value is irrelevant to behaviour.
jest.mock('lib/animation', () => ({
  springs: { standard: { type: 'spring' } }
}));

// Icons are SVG re-exports; render nothing but expose the enum keys the layout
// references so `IconName.X` lookups don't blow up.
jest.mock('app/icons/v2', () => ({
  Icon: () => null,
  IconName: {
    Home: 'Home',
    Explore: 'Explore',
    Activity: 'Activity',
    Wallet: 'Wallet',
    Send: 'Send',
    Receive: 'Receive',
    Earn: 'Earn',
    Convert: 'Convert'
  }
}));

// The home-group carousel is E2E territory; a marker div is enough to assert it
// mounts (vs. `children`) when the action bar is showing.
jest.mock('app/layouts/HomeSwipeContainer', () => ({
  __esModule: true,
  default: () => <div data-testid="home-swipe" />
}));

// framer-motion's `motion.div` — forward props onto a plain div and surface the
// `initial` prop (false = slide-in skipped, object = slide-in) for assertions.
jest.mock('framer-motion', () => ({
  motion: {
    div: React.forwardRef(({ children, initial, animate, transition, ...props }: any, ref: any) => (
      <div ref={ref} data-testid="motion-div" data-initial={JSON.stringify(initial)} {...props}>
        {children}
      </div>
    ))
  }
}));

// BottomNav / SegmentedActionBar — expose items, activeId and onChange as
// clickable buttons plus a synthetic "unknown id" button so the layout's
// route-lookup guard branches are all reachable.
jest.mock('components/ui', () => ({
  BottomNav: ({ items, activeId, onChange }: any) => (
    <div data-testid="bottom-nav" data-active={activeId}>
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
  SegmentedActionBar: ({ items, activeId, onChange, layoutId }: any) => (
    <div data-testid="action-bar" data-active={activeId} data-layout-id={layoutId}>
      {items.map((it: any) => (
        <button key={it.id} data-testid={`action-${it.id}`} onClick={() => onChange(it.id)}>
          {it.label}
        </button>
      ))}
      <button data-testid="action-unknown" onClick={() => onChange('__nope__')}>
        unknown
      </button>
    </div>
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

  it('maps an unrelated path (e.g. /settings) to the home tab', () => {
    mockLocation.pathname = '/settings';
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
    expect(screen.getByTestId('action-bar')).toHaveAttribute('data-layout-id', 'tab-layout-action-fill');
    expect(screen.getByTestId('home-swipe')).toBeInTheDocument();
    expect(screen.queryByTestId('child-content')).toBeNull();
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
  it('includes the Explore tab off-extension (3 tabs)', () => {
    mockPlatform.isExtension = false;
    renderLayout();
    expect(screen.getByTestId('nav-home')).toBeInTheDocument();
    expect(screen.getByTestId('nav-explore')).toBeInTheDocument();
    expect(screen.getByTestId('nav-activity')).toBeInTheDocument();
  });

  it('drops the Explore tab on the extension (2 tabs)', () => {
    mockPlatform.isExtension = true;
    renderLayout();
    expect(screen.getByTestId('nav-home')).toBeInTheDocument();
    expect(screen.queryByTestId('nav-explore')).toBeNull();
    expect(screen.getByTestId('nav-activity')).toBeInTheDocument();
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

describe('TabLayout — swap action availability (isSwapEnabled)', () => {
  it('shows the Swap action segment off-iOS', () => {
    mockPlatform.isIOS = false;
    mockLocation.pathname = '/';
    renderLayout();
    expect(screen.getByTestId('action-swap')).toBeInTheDocument();
  });

  it('hides the Swap action segment on iOS (App Store 3.1.5(iii))', () => {
    mockPlatform.isIOS = true;
    mockLocation.pathname = '/';
    renderLayout();
    expect(screen.queryByTestId('action-swap')).toBeNull();
    // The rest of the action bar is unaffected.
    expect(screen.getByTestId('action-overview')).toBeInTheDocument();
    expect(screen.getByTestId('action-send')).toBeInTheDocument();
    expect(screen.getByTestId('action-receive')).toBeInTheDocument();
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
    expect(getRoot(container)).toHaveStyle({ height: '600px', width: '360px' });
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
});

describe('TabLayout — slide-in animation (skipSlideIn)', () => {
  const initialOf = () => screen.getByTestId('motion-div').getAttribute('data-initial');

  it('slides the incoming page in by default (first render, non-home target)', () => {
    mockLocation.pathname = '/history';
    renderLayout();
    expect(initialOf()).toBe(JSON.stringify({ x: '8%', opacity: 0.5 }));
  });

  it('skips the slide-in on the extension', () => {
    mockPlatform.isExtension = true;
    mockLocation.pathname = '/history';
    renderLayout();
    expect(initialOf()).toBe('false');
  });

  it('skips the slide-in when returning from a webview on mobile', () => {
    mockPlatform.isMobile = true;
    mockReturning.value = true;
    mockLocation.pathname = '/history';
    renderLayout();
    expect(initialOf()).toBe('false');
  });

  it('still slides in on mobile when NOT returning from a webview', () => {
    mockPlatform.isMobile = true;
    mockReturning.value = false;
    mockLocation.pathname = '/history';
    renderLayout();
    expect(initialOf()).toBe(JSON.stringify({ x: '8%', opacity: 0.5 }));
  });

  it('skips the slide-in for intra-home-group navigations (prev + next both home-group)', () => {
    mockLocation.pathname = '/';
    const { rerender } = renderLayout();
    // After commit the effect stored '/' as the previous path; navigate within
    // the home group and the incoming page should not slide.
    mockLocation.pathname = '/send';
    rerender(<TabLayout>{<div data-testid="child-content" />}</TabLayout>);
    expect(initialOf()).toBe('false');
  });

  it('slides in when the previous path was outside the home group', () => {
    mockLocation.pathname = '/history';
    const { rerender } = renderLayout();
    mockLocation.pathname = '/send';
    rerender(<TabLayout>{<div data-testid="child-content" />}</TabLayout>);
    expect(initialOf()).toBe(JSON.stringify({ x: '8%', opacity: 0.5 }));
  });

  it('slides in when navigating from a home-group route out to a non-home route', () => {
    mockLocation.pathname = '/';
    const { rerender } = renderLayout();
    mockLocation.pathname = '/history';
    rerender(<TabLayout>{<div data-testid="child-content" />}</TabLayout>);
    expect(initialOf()).toBe(JSON.stringify({ x: '8%', opacity: 0.5 }));
  });
});

describe('TabLayout — footer scaffolding', () => {
  it('exposes the tabbar footer measurement hook for the dApp bubble host', () => {
    const { container } = renderLayout();
    expect(container.querySelector('[data-tabbar-footer="true"]')).toBeInTheDocument();
  });
});
