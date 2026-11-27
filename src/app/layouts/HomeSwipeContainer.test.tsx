import React from 'react';

import { act, render } from '@testing-library/react';

import { holdNavbarHidden, useHideNavbarWhileOpen } from 'lib/mobile/useHideNavbarWhileOpen';
import { _resetInteractionPriorityForTest, isInteracting } from 'lib/ui/interaction-priority';

import HomePanes from './HomeSwipeContainer';
import { PageActiveContext, TabActiveContext, usePageActive } from './page-active';

const mockNavigate = jest.fn();
let mockPathname = '/';
const mockSwapEnabled = { value: true };
const mockReduceMotion = { value: false };
const mockHapticSelection = jest.fn();
const mockBoostRefreshRate = jest.fn();
const mockUseHideNavbarWhileOpen = useHideNavbarWhileOpen;
const mockSwapReview = { open: false };
const mockReceiveRenders = { count: 0 };

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
function MockPage({ renders, ...props }: React.ComponentProps<'div'> & { renders?: { count: number } }) {
  if (renders) renders.count += 1;
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
  Receive: () => <MockPage data-testid="page-receive" renders={mockReceiveRenders} />
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
  SwapFlow: () => {
    mockUseHideNavbarWhileOpen(mockSwapReview.open);
    return (
      <MockPage data-testid="page-swap">
        <input data-testid="swap-amount-input" />
      </MockPage>
    );
  }
}));

/** What the component hands the compositor; jsdom has no Web Animations. */
interface FakeAnimation {
  el: Element;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
  startTime: number | null;
  cancel: jest.Mock;
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
}
let mockAnimations: FakeAnimation[] = [];
const animate = function (this: Element, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
  const animation: FakeAnimation = {
    el: this,
    keyframes,
    options,
    startTime: null,
    cancel: jest.fn(() => animation.oncancel?.()),
    onfinish: null,
    oncancel: null
  };
  mockAnimations.push(animation);
  return animation;
};

// What a pane is drawn at mid-switch: a test sets it, and getComputedStyle reports it.
const mockDrawn = new Map<Element, { opacity: string; transform: string }>();
const realGetComputedStyle = window.getComputedStyle.bind(window);

beforeAll(() => {
  // jsdom has none; the panes measure nothing, so this only keeps an older pager mountable.
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  });
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, writable: true, value: animate });
  Object.defineProperty(document, 'timeline', { configurable: true, value: { currentTime: 1000 } });
  Object.defineProperty(globalThis, 'DOMMatrixReadOnly', {
    configurable: true,
    writable: true,
    value: class {
      m41: number;
      constructor(transform: string) {
        const match = /translateX\((-?[\d.]+)px\)/.exec(transform);
        this.m41 = match ? Number(match[1]) : 0;
      }
    }
  });
  jest.spyOn(window, 'getComputedStyle').mockImplementation((el: Element, pseudo?: string | null) => {
    const real = realGetComputedStyle(el, pseudo);
    const drawn = mockDrawn.get(el);
    if (!drawn) return real;
    return new Proxy(real, {
      get: (target, key) => (key in drawn ? drawn[key as keyof typeof drawn] : Reflect.get(target, key))
    });
  });
});

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  _resetInteractionPriorityForTest();
  mockPathname = '/';
  mockSwapEnabled.value = true;
  mockSwapReview.open = false;
  mockReduceMotion.value = false;
  mockAnimations = [];
  mockDrawn.clear();
  document.body.removeAttribute('data-hide-navbar');
});

const IDS = ['overview', 'send', 'receive', 'earn', 'swap'];

function panes(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-home-page]'));
}
const pane = (id: string) => panes().find(el => el.getAttribute('data-home-page') === id)!;
/** Panes that draw anything: hidden ones are `visibility: hidden`. */
const shown = () =>
  panes()
    .filter(el => el.style.visibility !== 'hidden')
    .map(el => el.getAttribute('data-home-page'));
const notInert = () =>
  panes()
    .filter(el => !el.hasAttribute('inert'))
    .map(el => el.getAttribute('data-home-page'));
const animationsOn = (id: string) => mockAnimations.filter(a => a.el === pane(id));
const lastOn = (id: string) => {
  const last = animationsOn(id).at(-1);
  if (!last) throw new Error(`expected an animation on ${id}`);
  return last;
};

function mount(ui: React.ReactElement = <HomePanes />) {
  return render(ui);
}

function route(rerender: (ui: React.ReactElement) => void, path: string, ui: React.ReactElement = <HomePanes />) {
  mockPathname = path;
  act(() => {
    rerender(ui);
  });
}

function finish(animation: FakeAnimation) {
  act(() => {
    animation.onfinish?.();
  });
}

/** Finishes every animation still running, as the compositor would. */
function finishAll() {
  for (const animation of [...mockAnimations]) {
    if (!animation.cancel.mock.calls.length) finish(animation);
  }
}

function draw(id: string, opacity: number, x = 0) {
  mockDrawn.set(pane(id), { opacity: String(opacity), transform: x ? `translateX(${x}px)` : 'none' });
}

/** The TabPane trap: an inherited `hidden` from the tab must never be overridden by a pane. */
function expectNoVisibleOverride() {
  for (const el of panes()) expect(el.style.visibility).not.toBe('visible');
}

// The switch's tunables, pinned here as well as in pager.test.ts.
const EXIT_MS = 90;
const ENTER_MS = 170;
const ENTER_EASING = 'cubic-bezier(0.05, 0.7, 0.1, 1)';
const HOLD_MS = 360;
const ENTER_TOTAL = EXIT_MS + ENTER_MS;

describe('HomePanes', () => {
  describe('no swipe', () => {
    it('has no horizontal scroller, scroll snap or pager marker', () => {
      mount();
      expect(document.querySelector('[data-home-pager]')).toBeNull();
      const root = panes()[0]?.parentElement;
      if (!root) throw new Error('expected the panes root');
      for (const el of [root, ...panes()]) {
        expect(['auto', 'scroll']).not.toContain(el.style.overflowX);
        expect(el.style.scrollSnapType).toBe('');
      }
      expect(root).toHaveAttribute('data-home-panes');
    });

    it('never navigates or buzzes on a touch, scroll or wheel on any pane', () => {
      const { rerender } = mount();
      for (const el of panes()) {
        for (const type of ['touchstart', 'touchmove', 'touchend', 'scroll', 'scrollend', 'wheel']) {
          act(() => {
            el.dispatchEvent(new Event(type, { bubbles: true }));
          });
        }
      }
      act(() => {
        jest.advanceTimersByTime(1000);
      });
      route(rerender, '/send');
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(mockHapticSelection).not.toHaveBeenCalled();
    });
  });

  describe('the switch', () => {
    it('fades the old pane out, then fades the new one in from its tab side', () => {
      const { rerender } = mount();
      route(rerender, '/send');

      const exit = lastOn('overview');
      expect(exit.keyframes).toEqual([
        { opacity: 1, transform: 'none' },
        { opacity: 0, transform: 'none' }
      ]);
      expect(exit.options).toMatchObject({ duration: EXIT_MS, easing: 'linear' });

      const enter = lastOn('send');
      expect(enter.options.duration).toBe(ENTER_TOTAL);
      expect(enter.keyframes[0]).toEqual({ opacity: 0, transform: 'translateX(12px)' });
      expect(enter.keyframes[1]).toMatchObject({
        opacity: 0,
        transform: 'translateX(12px)',
        easing: ENTER_EASING
      });
      expect(enter.keyframes[1]?.offset).toBeCloseTo(90 / ENTER_TOTAL, 5);
      expect(enter.keyframes[2]).toEqual({ opacity: 1, transform: 'none' });
      expect(enter.startTime).toBe(exit.startTime);
      expect(enter.startTime).toBe(1000);
      expect(mockAnimations).toHaveLength(2);
    });

    it('nudges from the left going back', () => {
      mockPathname = '/swap';
      const { rerender } = mount();
      route(rerender, '/earn');
      expect(lastOn('earn').keyframes[0]).toEqual({ opacity: 0, transform: 'translateX(-12px)' });
    });

    it('takes as long for Overview to Swap as for a neighbour, on two panes only', () => {
      const { rerender } = mount();
      route(rerender, '/swap');
      expect(lastOn('swap').options.duration).toBe(ENTER_TOTAL);
      expect(new Set(mockAnimations.map(a => a.el)).size).toBe(2);
    });
  });

  describe('pane states', () => {
    it('shows only the route pane at rest, and never forces a pane visible', () => {
      mount();
      expect(shown()).toEqual(['overview']);
      expect(notInert()).toEqual(['overview']);
      expectNoVisibleOverride();
    });

    it('makes the leaving pane inert at once and keeps input off the entering pane until it lands', () => {
      const { rerender } = mount();
      route(rerender, '/send');
      expect(pane('overview')).toHaveAttribute('inert');
      expect(notInert()).toEqual(['send']);
      expect(pane('send').style.pointerEvents).toBe('none');
      expect(shown()).toEqual(['overview', 'send']);
      expectNoVisibleOverride();

      finish(lastOn('overview'));
      expect(pane('overview').style.visibility).toBe('hidden');
      expect(pane('overview').style.opacity).toBe('');
      expect(pane('overview').style.transform).toBe('');

      finish(lastOn('send'));
      expect(pane('send').style.pointerEvents).toBe('');
      expect(pane('send').style.opacity).toBe('');
      expect(shown()).toEqual(['send']);
      expectNoVisibleOverride();
    });
  });

  describe('retargeting', () => {
    it('fades the lead out from where it is drawn when a third tab is tapped', () => {
      const { rerender } = mount();
      route(rerender, '/send');
      finish(lastOn('overview'));
      draw('send', 0.73, 3);

      route(rerender, '/receive');

      const exit = lastOn('send');
      expect(exit.keyframes).toEqual([
        { opacity: 0.73, transform: 'translateX(3px)' },
        { opacity: 0, transform: 'translateX(3px)' }
      ]);
      expect(exit.options.duration).toBeCloseTo(90 * 0.73, 5);
      const enter = lastOn('receive');
      expect(enter.options.duration).toBeCloseTo(90 * 0.73 + 170, 5);
      expect(enter.keyframes[1]?.offset).toBeCloseTo((90 * 0.73) / (90 * 0.73 + 170), 5);
      expect(enter.keyframes[0]).toEqual({ opacity: 0, transform: 'translateX(12px)' });
      expect(shown()).toEqual(['send', 'receive']);
    });

    it('raises the source from its drawn opacity, without a nudge, when tapped back while still the lead', () => {
      const { rerender } = mount();
      route(rerender, '/send');
      draw('overview', 0.56);
      draw('send', 0);

      route(rerender, '/');

      const rise = lastOn('overview');
      expect(rise.options.duration).toBeCloseTo(170 * (1 - 0.56), 5);
      expect(rise.keyframes).toEqual([
        { opacity: 0.56, transform: 'none', easing: ENTER_EASING },
        { opacity: 1, transform: 'none' }
      ]);
      expect(pane('send').style.visibility).toBe('hidden');
      expect(shown()).toEqual(['overview']);
    });

    it('fades back through, nudged from the left, once the new pane has taken over', () => {
      const { rerender } = mount();
      route(rerender, '/send');
      finish(lastOn('overview'));
      draw('send', 0.6, 2);

      route(rerender, '/');

      expect(lastOn('send').options.duration).toBeCloseTo(54, 5);
      expect(lastOn('overview').keyframes[0]).toEqual({ opacity: 0, transform: 'translateX(-12px)' });
    });

    it('never draws more than two panes across a double retarget', () => {
      const { rerender } = mount();
      route(rerender, '/send');
      draw('overview', 0.4);
      route(rerender, '/receive');
      expect(shown().length).toBeLessThanOrEqual(2);
      draw('overview', 0.1);
      draw('receive', 0);
      route(rerender, '/earn');
      expect(shown().length).toBeLessThanOrEqual(2);
      expectNoVisibleOverride();
    });
  });

  describe('instant swaps', () => {
    it('places the first pane without an animation or a hold', () => {
      mockPathname = '/receive';
      mount();
      expect(shown()).toEqual(['receive']);
      expect(mockAnimations).toHaveLength(0);
      expect(isInteracting()).toBe(false);
      expect(mockBoostRefreshRate).not.toHaveBeenCalled();
    });

    it('swaps at once under reduced motion', () => {
      mockReduceMotion.value = true;
      const { rerender } = mount();
      route(rerender, '/swap');
      expect(mockAnimations).toHaveLength(0);
      expect(shown()).toEqual(['swap']);
      expect(isInteracting()).toBe(false);
      expect(mockBoostRefreshRate).not.toHaveBeenCalled();
    });

    it('places the remaining panes when the pages list changes', () => {
      mockPathname = '/earn';
      const { rerender } = mount();
      mockSwapEnabled.value = false;
      route(rerender, '/earn');
      expect(panes().map(el => el.getAttribute('data-home-page'))).toEqual(IDS.slice(0, 4));
      expect(shown()).toEqual(['earn']);
      expect(mockAnimations).toHaveLength(0);
    });

    it('switches without WAAPI by swapping at once and leaving nothing inline', () => {
      const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')!;
      Reflect.deleteProperty(Element.prototype, 'animate');
      try {
        const { rerender } = mount();
        route(rerender, '/send');
        expect(shown()).toEqual(['send']);
        for (const el of panes()) {
          expect(el.style.opacity).toBe('');
          expect(el.style.transform).toBe('');
          expect(el.style.pointerEvents).toBe('');
        }
      } finally {
        Object.defineProperty(Element.prototype, 'animate', descriptor);
      }
    });
  });

  describe('placement', () => {
    it('matches nested routes by prefix', () => {
      mockPathname = '/send/amount';
      mount();
      expect(shown()).toEqual(['send']);
    });

    it('falls back to Overview for an unknown path, never treating "/" as a prefix', () => {
      mockPathname = '/xyz';
      mount();
      expect(shown()).toEqual(['overview']);
      expect(mockNavigate).not.toHaveBeenCalled();
    });
  });

  describe('while another tab is showing', () => {
    const tab = (on: boolean) => (
      <TabActiveContext.Provider value={on}>
        <HomePanes />
      </TabActiveContext.Provider>
    );

    it('holds its pane instead of switching to Overview', () => {
      mockPathname = '/send';
      const { rerender } = mount(tab(true));
      route(rerender, '/history', tab(false));
      expect(mockAnimations).toHaveLength(0);
      expect(shown()).toEqual(['send']);
    });

    it('shows the pane again without a switch when the route comes back to it', () => {
      mockPathname = '/send';
      const { rerender } = mount(tab(true));
      route(rerender, '/history', tab(false));
      route(rerender, '/send', tab(true));
      expect(mockAnimations).toHaveLength(0);
      expect(shown()).toEqual(['send']);
    });

    it('swaps straight to Overview when Home is chosen from another tab', () => {
      mockPathname = '/receive';
      const { rerender } = mount(tab(true));
      route(rerender, '/history', tab(false));
      route(rerender, '/', tab(true));
      expect(mockAnimations).toHaveLength(0);
      expect(shown()).toEqual(['overview']);
      expect(isInteracting()).toBe(false);
    });

    it('lets a switch in flight finish when another tab is chosen', () => {
      const { rerender } = mount(tab(true));
      route(rerender, '/earn', tab(true));
      route(rerender, '/history', tab(false));
      for (const animation of mockAnimations) expect(animation.cancel).not.toHaveBeenCalled();
    });

    // Only the tab's return swaps (#1194). A slide page closing back onto another Home pane flips
    // PageActiveContext and the route in one commit while the tab stays shown, and that reveal switches.
    it('switches when a slide page closes back onto another Home pane', () => {
      const layer = (active: boolean) => (
        <TabActiveContext.Provider value={true}>
          <PageActiveContext.Provider value={active}>
            <HomePanes />
          </PageActiveContext.Provider>
        </TabActiveContext.Provider>
      );
      mockPathname = '/receive';
      const { rerender } = mount(layer(true));
      act(() => {
        rerender(layer(false));
      });
      route(rerender, '/', layer(true));
      expect(animationsOn('overview')).toHaveLength(1);
    });
  });

  describe('which Home page is active', () => {
    const pageActive = (getByTestId: (id: string) => HTMLElement, id: string) =>
      getByTestId(`page-${id}`).getAttribute('data-page-active');

    it('gives only the route page an active page', () => {
      const { getByTestId, rerender } = mount();
      expect(pageActive(getByTestId, 'explore')).toBe('true');
      route(rerender, '/earn');
      expect(pageActive(getByTestId, 'earn')).toBe('true');
      for (const id of ['explore', 'send', 'receive', 'swap']) expect(pageActive(getByTestId, id)).toBe('false');
    });

    it('leaves every page inactive while another tab is showing', () => {
      mockPathname = '/history';
      const { getByTestId } = mount(
        <PageActiveContext.Provider value={false}>
          <HomePanes />
        </PageActiveContext.Provider>
      );
      for (const id of ['explore', 'send', 'receive', 'earn', 'swap'])
        expect(pageActive(getByTestId, id)).toBe('false');
    });

    it('re-renders only the panes whose flags a route change flips', () => {
      const { getByTestId, rerender } = mount();
      const before = mockReceiveRenders.count;
      route(rerender, '/send');
      finishAll();
      expect(getByTestId('page-send')).toHaveAttribute('data-page-active', 'true');
      expect(mockReceiveRenders.count).toBe(before);
      route(rerender, '/receive');
      expect(mockReceiveRenders.count).toBe(before + 1);
    });

    it('passes isLoading={false} to the SendFlow', () => {
      const { getByTestId } = mount();
      expect(getByTestId('page-send')).toHaveAttribute('data-loading', 'false');
    });
  });

  describe('focus and navbar holds', () => {
    it('releases a Swap review hold when its pane is switched away', () => {
      mockPathname = '/swap';
      mockSwapReview.open = true;
      const { rerender } = mount();
      expect(document.body).toHaveAttribute('data-hide-navbar');
      route(rerender, '/receive');
      expect(document.body).not.toHaveAttribute('data-hide-navbar');
      route(rerender, '/swap');
      expect(document.body).toHaveAttribute('data-hide-navbar');
    });

    it('releases keyboard focus when a retained pane is switched away', () => {
      mockPathname = '/send';
      const { getByTestId, rerender } = mount();
      const input = getByTestId('send-amount-input');
      let releaseNavbar: (() => void) | undefined;
      input.addEventListener('focus', () => {
        releaseNavbar = holdNavbarHidden();
      });
      input.addEventListener('blur', () => {
        releaseNavbar?.();
      });
      input.focus();
      expect(document.body).toHaveAttribute('data-hide-navbar');
      route(rerender, '/receive');
      expect(input).not.toHaveFocus();
      expect(document.body).not.toHaveAttribute('data-hide-navbar');
    });
  });

  describe('background work and refresh rate', () => {
    it('holds background work for the switch, and boosts the display for as long', () => {
      const { rerender } = mount();
      route(rerender, '/send');
      expect(isInteracting()).toBe(true);
      expect(mockBoostRefreshRate).toHaveBeenCalledTimes(1);
      expect(mockBoostRefreshRate).toHaveBeenCalledWith(HOLD_MS);
      finishAll();
      act(() => {
        jest.advanceTimersByTime(HOLD_MS - 1);
      });
      expect(isInteracting()).toBe(true);
      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(isInteracting()).toBe(false);
    });

    it('begins the next hold before ending the last on a retarget', () => {
      const { rerender } = mount();
      route(rerender, '/send');
      act(() => {
        jest.advanceTimersByTime(300);
      });
      draw('overview', 0);
      draw('send', 0.9);
      route(rerender, '/receive');
      act(() => {
        jest.advanceTimersByTime(100);
      });
      expect(isInteracting()).toBe(true);
      expect(mockBoostRefreshRate).toHaveBeenCalledTimes(2);
      act(() => {
        jest.advanceTimersByTime(HOLD_MS);
      });
      expect(isInteracting()).toBe(false);
    });

    it('ends the hold, clears its timer and cancels every animation on unmount mid-switch', () => {
      const { rerender, unmount } = mount();
      route(rerender, '/send');
      const running = [...mockAnimations];
      unmount();
      expect(isInteracting()).toBe(false);
      for (const animation of running) expect(animation.cancel).toHaveBeenCalled();
      act(() => {
        jest.advanceTimersByTime(HOLD_MS * 2);
      });
      expect(isInteracting()).toBe(false);
    });
  });
});
