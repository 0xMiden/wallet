import React from 'react';

import { act, render, renderHook, screen } from '@testing-library/react';

import { pageStepOffset, pageStepTransition } from 'lib/animation';

import {
  DefaultAnimationConfig,
  Navigator,
  NavigatorProvider,
  ReducedMotionAnimationConfig,
  Route,
  useNavigator
} from './Navigator';

// ── framer-motion ─────────────────────────────────────────────────
// `AnimatePresence` renders its children; `motion.div` becomes a plain
// div that also captures the props it was called with so the animation
// `variants` functions can be invoked directly and asserted. Movement is
// otherwise never driven by jsdom, so capturing is the only way to reach
// the variant/branch logic. `useReducedMotion` is a switch the tests flip.
const mockMotionCapture: { props: any; presence: any } = { props: null, presence: null };
let mockReduceMotion = false;
let mockIsMobile = false;

jest.mock('framer-motion', () => {
  const ReactLib = require('react');
  return {
    AnimatePresence: ({ children, ...presence }: { children?: React.ReactNode }) => {
      mockMotionCapture.presence = presence;
      return ReactLib.createElement(ReactLib.Fragment, null, children);
    },
    motion: {
      div: ReactLib.forwardRef((props: any, ref: any) => {
        mockMotionCapture.props = props;
        return ReactLib.createElement('div', { ref, 'data-testid': 'motion-div' }, props.children);
      })
    },
    useReducedMotion: () => mockReduceMotion
  };
});

// isMobile toggles the effective animation duration (0 on extension).
jest.mock('lib/platform', () => ({
  isMobile: () => mockIsMobile
}));

// Push routes animate with push/pop; present routes with present/dismiss.
const routeHome: Route = { name: 'home', animationIn: 'push', animationOut: 'pop' };
const routeSettings: Route = { name: 'settings', animationIn: 'push', animationOut: 'pop' };
const routeModal: Route = { name: 'modal', animationIn: 'present', animationOut: 'dismiss' };
const routes: Route[] = [routeHome, routeSettings, routeModal];

const providerWrapper =
  (initialRouteName?: string) =>
  ({ children }: { children: React.ReactNode }) => (
    <NavigatorProvider routes={routes} initialRouteName={initialRouteName}>
      {children}
    </NavigatorProvider>
  );

const setupHook = (initialRouteName?: string) =>
  renderHook(() => useNavigator(), { wrapper: providerWrapper(initialRouteName) });

beforeEach(() => {
  mockMotionCapture.props = null;
  mockMotionCapture.presence = null;
  mockReduceMotion = false;
  mockIsMobile = false;
});

describe('useNavigator', () => {
  it('throws when used outside of a NavigatorProvider', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const Consumer = () => {
      useNavigator();
      return null;
    };
    expect(() => render(<Consumer />)).toThrow('useNavigator must be used within a NavigatorProvider');
    spy.mockRestore();
  });

  it('provides context when rendered inside a NavigatorProvider', () => {
    const { result } = setupHook('home');
    expect(typeof result.current.navigate).toBe('function');
    expect(typeof result.current.navigateTo).toBe('function');
    expect(typeof result.current.goBack).toBe('function');
    expect(result.current.routes).toBe(routes);
  });
});

describe('NavigatorProvider — initial state', () => {
  it('starts with the initial route when initialRouteName matches', () => {
    const { result } = setupHook('settings');
    expect(result.current.cardStack).toEqual([routeSettings]);
    expect(result.current.activeRoute).toBe(routeSettings);
    expect(result.current.activeIndex).toBe(1);
    expect(result.current.direction).toBe('forward');
  });

  it('starts empty when initialRouteName does not match any route', () => {
    const { result } = setupHook('does-not-exist');
    expect(result.current.cardStack).toEqual([]);
    expect(result.current.activeRoute).toBeUndefined();
    // activeRoute is undefined -> activeIndex falls back to 0
    expect(result.current.activeIndex).toBe(0);
  });

  it('starts with a whole stack from initialRouteNames, so back pops to the earlier route', () => {
    const { result } = renderHook(() => useNavigator(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <NavigatorProvider routes={routes} initialRouteNames={['home', 'settings']}>
          {children}
        </NavigatorProvider>
      )
    });
    expect(result.current.cardStack).toEqual([routeHome, routeSettings]);
    expect(result.current.activeRoute).toBe(routeSettings);

    act(() => result.current.goBack());

    expect(result.current.cardStack).toEqual([routeHome]);
  });

  it('starts empty when no initialRouteName is provided', () => {
    const { result } = setupHook();
    expect(result.current.cardStack).toEqual([]);
    expect(result.current.activeRoute).toBeUndefined();
    expect(result.current.activeIndex).toBe(0);
  });
});

describe('NavigatorProvider — navigation', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('navigate on an empty stack sets the stack synchronously', () => {
    const { result } = setupHook();
    act(() => {
      result.current.navigate(routeHome);
    });
    // length === 0 branch: no setTimeout, direction untouched
    expect(result.current.cardStack).toEqual([routeHome]);
    expect(result.current.activeRoute).toBe(routeHome);
    expect(result.current.direction).toBe('forward');
  });

  it('navigate push -> push uses forward direction', () => {
    const { result } = setupHook('home');
    act(() => {
      result.current.navigate(routeSettings);
    });
    expect(result.current.direction).toBe('forward');
    act(() => {
      jest.runAllTimers();
    });
    expect(result.current.cardStack).toEqual([routeHome, routeSettings]);
    expect(result.current.activeRoute).toBe(routeSettings);
    expect(result.current.activeIndex).toBe(1);
  });

  it('navigate push -> present uses up direction', () => {
    const { result } = setupHook('home');
    act(() => {
      result.current.navigate(routeModal);
    });
    expect(result.current.direction).toBe('up');
    act(() => {
      jest.runAllTimers();
    });
    expect(result.current.cardStack).toEqual([routeHome, routeModal]);
    expect(result.current.activeRoute).toBe(routeModal);
    expect(result.current.activeIndex).toBe(2);
  });

  it('navigateTo navigates when the route name is found', () => {
    const { result } = setupHook('home');
    act(() => {
      result.current.navigateTo('settings');
    });
    act(() => {
      jest.runAllTimers();
    });
    expect(result.current.cardStack).toEqual([routeHome, routeSettings]);
  });

  it('navigateTo is a no-op when the route name is unknown', () => {
    const { result } = setupHook('home');
    act(() => {
      result.current.navigateTo('nope');
    });
    act(() => {
      jest.runAllTimers();
    });
    expect(result.current.cardStack).toEqual([routeHome]);
  });

  it('goBack does not pop when only one route is on the stack', () => {
    const { result } = setupHook('home');
    act(() => {
      result.current.goBack();
    });
    // length <= 1: direction flips to backward but the stack is preserved
    expect(result.current.direction).toBe('backward');
    expect(result.current.cardStack).toEqual([routeHome]);
  });

  it('goBack pops with backward direction for push -> push', () => {
    const { result } = setupHook('home');
    act(() => {
      result.current.navigate(routeSettings);
    });
    act(() => {
      jest.runAllTimers();
    });
    act(() => {
      result.current.goBack();
    });
    expect(result.current.direction).toBe('backward');
    expect(result.current.cardStack).toEqual([routeHome]);
  });

  it('goBack pops with down direction when dismissing a present over a push', () => {
    const { result } = setupHook('home');
    act(() => {
      result.current.navigate(routeModal);
    });
    act(() => {
      jest.runAllTimers();
    });
    act(() => {
      result.current.goBack();
    });
    // current is present, previous is push -> down
    expect(result.current.direction).toBe('down');
    expect(result.current.cardStack).toEqual([routeHome]);
  });
});

describe('Navigator component', () => {
  const renderRoute = (route: Route, index: number) => (
    <div data-testid="route-content">
      {route.name}:{index}
    </div>
  );

  const renderNavigator = (
    props: Partial<React.ComponentProps<typeof Navigator>> = {},
    initialRouteName: string | undefined = 'home'
  ) =>
    render(
      <NavigatorProvider routes={routes} initialRouteName={initialRouteName}>
        <Navigator renderRoute={renderRoute} {...props} />
      </NavigatorProvider>
    );

  it('renders the active route via renderRoute', () => {
    renderNavigator();
    expect(screen.getByTestId('route-content')).toHaveTextContent('home:0');
    expect(screen.getByTestId('motion-div')).toBeInTheDocument();
    expect(mockMotionCapture.props.className).toBe('flex-1 flex flex-col min-h-0');
    expect(mockMotionCapture.props.custom).toEqual({ direction: 'forward', in: 'push', out: 'pop' });
  });

  it('renders nothing when there is no active route', () => {
    // No initialRouteName -> empty stack -> activeRoute undefined -> null.
    const { container } = render(
      <NavigatorProvider routes={routes}>
        <Navigator renderRoute={renderRoute} />
      </NavigatorProvider>
    );
    expect(container.querySelector('[data-testid="route-content"]')).toBeNull();
    expect(container.querySelector('[data-testid="motion-div"]')).toBeNull();
    // motion.div was never rendered so no props were captured
    expect(mockMotionCapture.props).toBeNull();
  });

  it('disables animation duration on the extension (isMobile === false)', () => {
    mockIsMobile = false;
    renderNavigator({ animationDuration: 0.5 });
    expect(mockMotionCapture.props.transition.duration).toBe(0);
  });

  it('uses the provided animationDuration on mobile', () => {
    mockIsMobile = true;
    renderNavigator({ animationDuration: 0.5 });
    expect(mockMotionCapture.props.transition.duration).toBe(0.5);
  });

  it('defaults animationDuration to 0.15 on mobile', () => {
    mockIsMobile = true;
    renderNavigator();
    expect(mockMotionCapture.props.transition.duration).toBe(0.15);
  });

  it('swaps one step at a time: the leaving step goes before the next one mounts', () => {
    renderNavigator();
    expect(mockMotionCapture.presence).toEqual({ mode: 'wait', initial: false });
  });

  it('runs a step swap on the page step transition on mobile', () => {
    mockIsMobile = true;
    renderNavigator();
    expect(mockMotionCapture.props.transition).toEqual({ ...pageStepTransition, when: 'beforeChildren' });
  });

  it('keeps the page step curve when a caller sets the duration', () => {
    mockIsMobile = true;
    renderNavigator({ animationDuration: 0.5 });
    expect(mockMotionCapture.props.transition).toEqual({
      ...pageStepTransition,
      duration: 0.5,
      when: 'beforeChildren'
    });
  });

  it.each([true, false])('makes the swap instant under reduced motion (mobile: %s)', mobile => {
    mockIsMobile = mobile;
    mockReduceMotion = true;
    renderNavigator({ animationDuration: 0.5 });
    expect(mockMotionCapture.props.transition).toEqual({ duration: 0.001, when: 'beforeChildren' });
  });

  it('nudges a pushed step in by pageStepOffset, from the right forward and the left back', () => {
    expect(DefaultAnimationConfig.pushInitialPosition.x).toBe(pageStepOffset);
    expect(DefaultAnimationConfig.pushBackInitialPosition.x).toBe(`-${pageStepOffset}`);
  });

  describe('animation variants (default config)', () => {
    beforeEach(() => {
      mockReduceMotion = false;
      renderNavigator();
    });

    it('exposes the focus position', () => {
      expect(mockMotionCapture.props.variants.focusPosition).toEqual(DefaultAnimationConfig.focusPosition);
    });

    it('initialPosition for a push route covers every direction branch', () => {
      const { initialPosition } = mockMotionCapture.props.variants;
      expect(initialPosition({ in: 'push', out: 'pop', direction: 'down' })).toEqual(
        DefaultAnimationConfig.pushModalBackgroundPosition
      );
      expect(initialPosition({ in: 'push', out: 'pop', direction: 'forward' })).toEqual(
        DefaultAnimationConfig.pushInitialPosition
      );
      // Back mirrors forward: the previous step slides in from the left.
      expect(initialPosition({ in: 'push', out: 'pop', direction: 'backward' })).toEqual(
        DefaultAnimationConfig.pushBackInitialPosition
      );
      expect(DefaultAnimationConfig.pushBackInitialPosition.x).toBe('-8%');
    });

    it('initialPosition for a present route uses the present initial position', () => {
      const { initialPosition } = mockMotionCapture.props.variants;
      expect(initialPosition({ in: 'present', out: 'dismiss', direction: 'up' })).toEqual(
        DefaultAnimationConfig.presentInitialPosition
      );
    });

    it('exitPosition for a pop route covers every direction branch', () => {
      const { exitPosition } = mockMotionCapture.props.variants;
      expect(exitPosition({ in: 'push', out: 'pop', direction: 'up' })).toEqual(
        DefaultAnimationConfig.pushModalBackgroundPosition
      );
      expect(exitPosition({ in: 'push', out: 'pop', direction: 'forward' })).toEqual(
        DefaultAnimationConfig.pushHiddenPosition
      );
      expect(exitPosition({ in: 'push', out: 'pop', direction: 'backward' })).toEqual(
        DefaultAnimationConfig.pushExitPosition
      );
    });

    it('exitPosition for a dismiss route uses the present exit position', () => {
      const { exitPosition } = mockMotionCapture.props.variants;
      expect(exitPosition({ in: 'present', out: 'dismiss', direction: 'backward' })).toEqual(
        DefaultAnimationConfig.presentExitPosition
      );
    });
  });

  it('uses the reduced-motion config when useReducedMotion is true', () => {
    mockReduceMotion = true;
    renderNavigator();
    const { initialPosition } = mockMotionCapture.props.variants;
    // Reduced motion drops the x/y movement but keeps opacity fades.
    expect(initialPosition({ in: 'push', out: 'pop', direction: 'forward' })).toEqual(
      ReducedMotionAnimationConfig.pushInitialPosition
    );
    expect(ReducedMotionAnimationConfig.pushInitialPosition.x).toBe('0vw');
    expect(initialPosition({ in: 'present', out: 'dismiss', direction: 'up' })).toEqual(
      ReducedMotionAnimationConfig.presentInitialPosition
    );
    expect(ReducedMotionAnimationConfig.presentInitialPosition.y).toBe('0vw');
    expect(initialPosition({ in: 'push', out: 'pop', direction: 'backward' })).toEqual(
      ReducedMotionAnimationConfig.pushBackInitialPosition
    );
    expect(ReducedMotionAnimationConfig.pushBackInitialPosition.x).toBe('0vw');
  });

  it('uses a caller-supplied animationConfig when reduced motion is off', () => {
    mockReduceMotion = false;
    const customConfig = {
      ...DefaultAnimationConfig,
      focusPosition: { ...DefaultAnimationConfig.focusPosition, x: '42vw' }
    };
    renderNavigator({ animationConfig: customConfig });
    expect(mockMotionCapture.props.variants.focusPosition).toEqual(customConfig.focusPosition);
    expect(mockMotionCapture.props.variants.focusPosition.x).toBe('42vw');
  });
});
