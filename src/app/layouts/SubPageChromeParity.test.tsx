/**
 * A sub-page wears the same chrome wherever it is pushed from.
 *
 * Earn's vault detail is a ROUTED page: `/earn/vaults/:id` renders `FullScreenPage` + the shared
 * pushed-page frame, outside `TabLayout` entirely, so it owns the whole screen — its own header,
 * its own pinned CTA, and nothing of the app's around them. Send's amount step and Swap's review
 * are `Navigator` cards INSIDE their pane, so the pane stayed mounted around them and the top
 * action bar went on sitting above the step, squeezing it into what was left. Two screens of the
 * same kind, two different frames (Brian, simulator).
 *
 * So this renders both — the routed page through `FullScreenPage`, the pushed step through the
 * real `TabLayout` and a pane that declares itself a sub-page — and compares what the user is left
 * looking at. A test of either one on its own cannot say they agree.
 *
 * The chrome is deliberately phrased as what SHOWS, not as what is mounted: `TabLayout` keeps the
 * bottom nav in the tree and fades it out through `body[data-hide-navbar]`, so "no bottom nav" and
 * "a bottom nav under a raised flag" are the same screen.
 */

import React from 'react';

import { render, screen } from '@testing-library/react';
import type { Transition } from 'framer-motion';

import { FlowLayout } from 'components/flow/FlowLayout';
import { SubPageLayout } from 'components/ui/SubPageLayout';

import FullScreenPage from './FullScreenPage';
import { useHomePaneSubPage } from './home-pane-subpage';
import TabLayout from './TabLayout';

const mockLocation = { pathname: '/send' };

jest.mock('lib/woozie', () => ({
  navigate: jest.fn(),
  useLocation: () => ({ pathname: mockLocation.pathname })
}));
jest.mock('lib/platform', () => ({
  isMobile: () => true,
  isDesktop: () => false,
  isExtension: () => false,
  isIOS: () => false
}));
jest.mock('app/env', () => ({ useAppEnv: () => ({ fullPage: false, sidePanel: false }) }));
jest.mock('app/hooks/useHasUnreadActivity', () => ({ useHasUnreadActivity: () => false }));
jest.mock('lib/mobile/useKeyboardVisible', () => ({ useKeyboardVisible: () => false }));
jest.mock('lib/mobile/webview-state', () => ({ isReturningFromWebview: () => false }));
jest.mock('lib/mobile/haptics', () => ({ hapticSelection: jest.fn(), hapticLight: jest.fn() }));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
jest.mock('app/layouts/HomeSwipeContainer', () => ({
  __esModule: true,
  default: () => <div data-testid="home-swipe" />
}));
jest.mock('components/NetworkModeRibbon', () => ({ NetworkModeRibbon: () => null }));
jest.mock('app/icons/v2', () => ({
  Icon: ({ name }: { name: string }) => <svg data-name={name} />,
  IconName: {
    Home: 'Home',
    Explore: 'Explore',
    Activity: 'Activity',
    Settings: 'Settings',
    Wallet: 'Wallet',
    Send: 'Send',
    Receive: 'Receive',
    Earn: 'Earn',
    Convert: 'Convert',
    ArrowLeft: 'arrow-left',
    ChevronLeft: 'chevron-left',
    Close: 'close'
  }
}));
jest.mock('lib/animation', () => ({
  springs: { standard: { type: 'spring' } },
  springToLinearEasing: () => null,
  useMotion: (transition: Transition) => transition,
  usePreset: () => ({ initial: false, animate: {}, transition: {} })
}));
jest.mock('components/ui', () => ({
  BottomNav: () => <div data-testid="bottom-nav" />,
  SegmentedActionBar: () => <div data-testid="action-bar" />
}));
jest.mock('framer-motion', () => ({
  useReducedMotion: () => true,
  useIsPresent: () => true,
  motion: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    div: React.forwardRef(
      ({ children, initial, animate, transition, onAnimationComplete, ...props }: any, ref: any) => (
        <div ref={ref} {...props}>
          {children}
        </div>
      )
    )
  }
}));

/** What the screen shows around a sub-page's own frame. */
const chrome = (root: HTMLElement) => ({
  actionBar: screen.queryByTestId('action-bar') !== null,
  // The nav is faded out by the body flag rather than unmounted, so presence alone is not the
  // question — whether it is drawn is.
  bottomNavShown: screen.queryByTestId('bottom-nav') !== null && !document.body.hasAttribute('data-hide-navbar'),
  // What the page brings instead: its own header row and its own pinned CTA.
  ownHeader: root.querySelector('header') !== null,
  pinnedFooter: root.querySelector('[data-navbar-cushion="true"]') !== null
});

/** Earn's vault detail: a routed page, outside TabLayout, in the shared pushed-page frame. */
const renderRoutedSubPage = () =>
  render(
    <FullScreenPage>
      <SubPageLayout title="Vault" onBack={jest.fn()} footer={<button type="button">Deposit</button>}>
        <p data-testid="content">vault</p>
      </SubPageLayout>
    </FullScreenPage>
  );

/** Send's amount step: a Navigator card inside the Send pane, which declares it a sub-page. */
const PushedStepPane: React.FC = () => {
  useHomePaneSubPage(true);
  return (
    <FlowLayout title="Enter amount" onBack={jest.fn()} footer={<button type="button">Confirm</button>}>
      <p data-testid="content">amount</p>
    </FlowLayout>
  );
};

const renderPushedStep = () =>
  render(
    <>
      <TabLayout>
        <div data-testid="tab-children" />
      </TabLayout>
      {/* The pane's own tree. HomeSwipeContainer is stubbed here, so the step stands in for what
          it would have mounted inside the Send pane. */}
      <PushedStepPane />
    </>
  );

afterEach(() => {
  document.body.removeAttribute('data-hide-navbar');
  document.body.removeAttribute('data-home-band');
});

it('gives a pushed pane step the same chrome as a routed sub-page', () => {
  const routed = renderRoutedSubPage();
  const routedChrome = chrome(routed.container);
  routed.unmount();

  const pushed = renderPushedStep();
  const pushedChrome = chrome(pushed.container);

  expect(pushedChrome).toEqual(routedChrome);
  // And that shared chrome is the takeover: the page's own header and CTA, nothing of the app's.
  expect(pushedChrome).toEqual({ actionBar: false, bottomNavShown: false, ownHeader: true, pinnedFooter: true });
});

it('leaves a pane ROOT its action bar and its tab bar', () => {
  // The other half of the rule: only a pushed step takes the screen. The pane root — Send's
  // recipient step, Earn's vault list — is a tab destination and keeps both bars.
  render(
    <TabLayout>
      <div data-testid="tab-children" />
    </TabLayout>
  );

  expect(screen.getByTestId('action-bar')).toBeInTheDocument();
  expect(screen.getByTestId('bottom-nav')).toBeInTheDocument();
  expect(document.body.hasAttribute('data-hide-navbar')).toBe(false);
});
