import React from 'react';

import { act, render } from '@testing-library/react';

import { _resetInteractionPriorityForTest } from 'lib/ui/interaction-priority';

import HomeSwipeContainer from './HomeSwipeContainer';
import { usePageActive } from './page-active';

const mockNavigate = jest.fn();
let mockPathname = '/';
const mockSwapEnabled = { value: true };
const mockReduceMotion = { value: false };
const mockHapticSelection = jest.fn();
const mockBoostRefreshRate = jest.fn();

jest.mock('framer-motion', () => ({
  ...jest.requireActual('framer-motion'),
  useReducedMotion: () => mockReduceMotion.value
}));

jest.mock('lib/woozie', () => ({
  navigate: (...args: unknown[]) => mockNavigate(...args),
  useLocation: () => ({ pathname: mockPathname })
}));

jest.mock('lib/mobile/haptics', () => ({
  hapticSelection: (...args: unknown[]) => mockHapticSelection(...args)
}));

jest.mock('lib/mobile/high-refresh-rate', () => ({
  boostRefreshRate: (...args: unknown[]) => mockBoostRefreshRate(...args)
}));

jest.mock('lib/feature-flags', () => ({
  isSwapEnabled: () => mockSwapEnabled.value
}));

// Child pages pull in the full wallet stack; each marker reports the page-active value it renders under.
function MockPage(props: React.ComponentProps<'div'>) {
  return <div {...props} data-page-active={String(usePageActive())} />;
}
jest.mock('app/pages/Explore', () => ({
  __esModule: true,
  default: () => <MockPage data-testid="page-explore" />
}));
jest.mock('app/pages/Earn', () => ({
  __esModule: true,
  default: () => <MockPage data-testid="page-earn" />
}));
jest.mock('app/pages/Receive', () => ({
  __esModule: true,
  Receive: () => <MockPage data-testid="page-receive" />
}));
jest.mock('screens/send-flow/SendManager', () => ({
  __esModule: true,
  SendFlow: ({ isLoading }: { isLoading?: boolean }) => (
    <MockPage data-testid="page-send" data-loading={String(isLoading)}>
      <input data-testid="send-amount-input" />
    </MockPage>
  )
}));
jest.mock('screens/swap-flow/SwapManager', () => ({
  __esModule: true,
  SwapFlow: () => (
    <MockPage data-testid="page-swap">
      <input data-testid="swap-amount-input" />
    </MockPage>
  )
}));

let mockRoCallback: ((entries: unknown[]) => void) | null = null;
class MockResizeObserver {
  constructor(cb: (entries: unknown[]) => void) {
    mockRoCallback = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

const W = 300;
let mockWidth = 0;

beforeAll(() => {
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, writable: true, value: MockResizeObserver });
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  _resetInteractionPriorityForTest();
  mockPathname = '/';
  mockSwapEnabled.value = true;
  mockReduceMotion.value = false;
  mockRoCallback = null;
  mockWidth = 0;
  document.body.removeAttribute('data-hide-navbar');
});

/** The scroller is the page wrappers' grandparent: scroller, then track, then one wrapper per page. */
function scrollerOf(page: HTMLElement): HTMLElement {
  const scroller = page.closest('[data-home-page]')?.parentElement?.parentElement;
  if (!scroller) throw new Error('expected the pager scroller');
  return scroller;
}

/** jsdom has no layout or scrolling, so the scroller gets a width, a writable position and a scrollTo. */
function mount(ui: React.ReactElement = <HomeSwipeContainer />) {
  const view = render(ui);
  const scroller = scrollerOf(view.getByTestId('page-explore'));
  Object.defineProperty(scroller, 'scrollLeft', { configurable: true, writable: true, value: 0 });
  Object.defineProperty(scroller, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ width: mockWidth, height: 600, top: 0, left: 0, right: mockWidth, bottom: 600, x: 0, y: 0 })
  });
  Object.defineProperty(scroller, 'scrollTo', {
    configurable: true,
    value: (options: ScrollToOptions) => {
      if (typeof options.left === 'number') scroller.scrollLeft = options.left;
    }
  });
  return { ...view, scroller };
}

function measure(width: number) {
  mockWidth = width;
  act(() => {
    mockRoCallback?.([{ contentRect: { width } }]);
  });
}

function fire(target: EventTarget, type: string): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

/** A user scroll that comes to rest at `left`, reported the way an engine with `scrollend` does. */
function settleAt(scroller: HTMLElement, left: number) {
  scroller.scrollLeft = left;
  fire(scroller, 'scroll');
  fire(scroller, 'scrollend');
}

describe('HomeSwipeContainer', () => {
  // #1811: framer drag measured the track mid-release and added the animated offset to the drag, so a
  // second swipe from Earn toward Receive committed to Swap. The committed pane must be the one the
  // scroller settled on.
  it('commits the pane the scroller settled on, in the direction of the swipe (#1811)', () => {
    const { scroller, rerender } = mount();
    measure(W);
    mockPathname = '/swap';
    act(() => {
      rerender(<HomeSwipeContainer />);
    });
    scroller.scrollLeft = 4 * W;

    settleAt(scroller, 3 * W);
    expect(mockNavigate).toHaveBeenLastCalledWith('/earn');

    mockPathname = '/earn';
    act(() => {
      rerender(<HomeSwipeContainer />);
    });
    settleAt(scroller, 2 * W);

    expect(mockNavigate.mock.calls).toEqual([['/earn'], ['/receive']]);
    expect(mockNavigate).not.toHaveBeenCalledWith('/swap');
  });
});
