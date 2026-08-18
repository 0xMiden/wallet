import React, { createContext, useContext, useState, useCallback, ReactNode, useMemo, useEffect } from 'react';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

import { setCardPart } from 'lib/e2e/screen-key';
import { isMobile } from 'lib/platform';

export type AnimationDirection = 'forward' | 'backward' | 'up' | 'down';
export type AnimationIn = 'push' | 'present';
export type AnimationOut = 'pop' | 'dismiss';
export type Route = {
  name: string;
  animationIn: AnimationIn;
  animationOut: AnimationOut;
};

type NavigatorContextType = {
  navigate: (route: Route) => void;
  navigateTo: (routeName: Route['name']) => void;
  goBack: () => void;
  routes: Route[];
  cardStack: Route[];
  direction: AnimationDirection;
  activeRoute?: Route;
  activeIndex: number;
};

const NavigatorContext = createContext<NavigatorContextType | undefined>(undefined);

export const useNavigator = () => {
  const context = useContext(NavigatorContext);
  if (!context) {
    throw new Error('useNavigator must be used within a NavigatorProvider');
  }
  return context;
};

export const NavigatorProvider: React.FC<{ children: ReactNode; routes: Route[]; initialRouteName?: string }> = ({
  children,
  routes,
  initialRouteName
}) => {
  const [cardStack, setCardStack] = useState<Route[]>(() => {
    if (initialRouteName) {
      const initial = routes.find(r => r.name === initialRouteName);
      if (initial) return [initial];
    }
    return [];
  });
  const [navigationDirection, setNavigationDirection] = useState<AnimationDirection>('forward');

  const navigate = useCallback(
    (route: Route) => {
      if (cardStack.length === 0) {
        setCardStack([route]);
        return;
      }

      const currentRoute = cardStack[cardStack.length - 1];

      if (currentRoute?.animationIn === 'push' && route.animationIn === 'present') {
        setNavigationDirection('up');
      } else {
        setNavigationDirection('forward');
      }

      setTimeout(() => setCardStack([...cardStack, route]), 0);
    },
    [cardStack]
  );

  const navigateTo = useCallback(
    (routeName: Route['name']) => {
      const route = routes.find(r => r.name === routeName);
      if (route) {
        navigate(route);
      }
    },
    [navigate, routes]
  );

  const goBack = useCallback(() => {
    setNavigationDirection('backward');

    if (cardStack.length > 1) {
      const currentRoute = cardStack[cardStack.length - 1];
      const previousRoute = cardStack[cardStack.length - 2];
      if (currentRoute?.animationIn === 'present' && previousRoute?.animationIn === 'push') {
        setNavigationDirection('down');
      }
      setCardStack(cardStack.slice(0, -1));
    }
  }, [cardStack]);

  const activeRoute = useMemo(() => (cardStack.length > 0 ? cardStack[cardStack.length - 1] : undefined), [cardStack]);
  const activeIndex = useMemo(
    () => (activeRoute ? routes.findIndex(r => r.name === activeRoute.name) : 0),
    [activeRoute, routes]
  );

  // E2E-only. Publishes the active card into the screen-key signal so E2E
  // harnesses can screenshot on every screen change; clears on unmount so
  // leaving a Navigator-backed flow drops the card part. Gated on
  // MIDEN_E2E_TEST so it tree-shakes out of production.
  useEffect(() => {
    if (process.env.MIDEN_E2E_TEST !== 'true') return;
    setCardPart(activeRoute?.name ?? null);
    return () => setCardPart(null);
  }, [activeRoute]);

  return (
    <NavigatorContext.Provider
      value={{
        navigate,
        navigateTo,
        goBack,
        routes,
        cardStack,
        direction: navigationDirection,
        activeRoute,
        activeIndex
      }}
    >
      {children}
    </NavigatorContext.Provider>
  );
};

export type NavigatorProps = {
  animationDuration?: number;
  renderRoute: (route: Route, index: number) => React.ReactNode;
  animationConfig?: {
    pushInitialPosition: AnimationConfig;
    focusPosition: AnimationConfig;
    pushExitPosition: AnimationConfig;
    pushHiddenPosition: AnimationConfig;
    pushModalBackgroundPosition: AnimationConfig;
    presentInitialPosition: AnimationConfig;
    presentExitPosition: AnimationConfig;
  };
};

type AnimationConfig = {
  x: string;
  y: string;
  opacity: number;
  scale: number;
  backgroundColor: string;
  transition?: {
    delay?: number;
    duration?: number;
  };
};

const PushInitialPosition: AnimationConfig = {
  x: '8%',
  opacity: 1,
  backgroundColor: 'var(--color-app-bg)',
  y: '0vw',
  scale: 1
};

const FocusPosition: AnimationConfig = {
  x: '0vw',
  y: '0vw',
  opacity: 1,
  scale: 1,
  backgroundColor: 'var(--color-app-bg)'
};

const PushExitPosition: AnimationConfig = {
  x: '0vw',
  y: '0vw',
  opacity: 1,
  scale: 1,
  backgroundColor: 'var(--color-app-bg)'
};

const PushHiddenPosition: AnimationConfig = {
  x: '0vw',
  y: '0vw',
  opacity: 1,
  scale: 1,
  backgroundColor: 'var(--color-app-bg)'
};

const PushModalBackgroundPosition: AnimationConfig = {
  x: '0vw',
  y: '0vw',
  opacity: 1,
  scale: 1,
  backgroundColor: 'var(--color-app-bg)'
};

const PresentInitialPosition: AnimationConfig = {
  x: '0vw',
  y: '25vw',
  opacity: 0,
  scale: 1,
  backgroundColor: 'var(--color-app-bg)'
};

const PresentExitPosition: AnimationConfig = {
  x: '0vw',
  y: '25vw',
  opacity: 0,
  scale: 1,
  backgroundColor: 'var(--color-app-bg)'
};

export const DefaultAnimationConfig = {
  pushInitialPosition: PushInitialPosition,
  focusPosition: FocusPosition,
  pushExitPosition: PushExitPosition,
  pushHiddenPosition: PushHiddenPosition,
  pushModalBackgroundPosition: PushModalBackgroundPosition,
  presentInitialPosition: PresentInitialPosition,
  presentExitPosition: PresentExitPosition
};

// prefers-reduced-motion: movement is dropped, opacity fades are kept.
export const ReducedMotionAnimationConfig = {
  ...DefaultAnimationConfig,
  pushInitialPosition: { ...PushInitialPosition, x: '0vw' },
  presentInitialPosition: { ...PresentInitialPosition, y: '0vw' },
  presentExitPosition: { ...PresentExitPosition, y: '0vw' }
};

export const Navigator: React.FC<NavigatorProps> = ({
  renderRoute,
  animationDuration = 0.15,
  animationConfig = DefaultAnimationConfig
}) => {
  const { direction, activeRoute, activeIndex } = useNavigator();
  const reduceMotion = useReducedMotion();

  // Only animate on mobile (disable for Chrome extension)
  const effectiveDuration = isMobile() ? animationDuration : 0;
  const effectiveConfig = reduceMotion ? ReducedMotionAnimationConfig : animationConfig;

  const animationVariants = useMemo(() => {
    return {
      initialPosition: (config: { in: AnimationIn; out: AnimationOut; direction: AnimationDirection }) => {
        if (config.in === 'push') {
          if (config.direction === 'down') {
            return effectiveConfig.pushModalBackgroundPosition;
          }

          return config.direction === 'forward'
            ? effectiveConfig.pushInitialPosition
            : effectiveConfig.pushHiddenPosition;
        } else {
          return effectiveConfig.presentInitialPosition;
        }
      },
      focusPosition: effectiveConfig.focusPosition,
      exitPosition: (config: { in: AnimationIn; out: AnimationOut; direction: AnimationDirection }) => {
        if (config.out === 'pop') {
          if (config.direction === 'up') {
            return effectiveConfig.pushModalBackgroundPosition;
          }
          return config.direction === 'forward' ? effectiveConfig.pushHiddenPosition : effectiveConfig.pushExitPosition;
        } else {
          return effectiveConfig.presentExitPosition;
        }
      }
    };
  }, [effectiveConfig]);

  return (
    <AnimatePresence mode="wait" initial={false}>
      {activeRoute ? (
        <motion.div
          className="flex-1 flex flex-col min-h-0"
          key={activeRoute?.name}
          custom={{
            direction: direction,
            in: activeRoute.animationIn,
            out: activeRoute.animationOut
          }}
          initial="initialPosition"
          animate="focusPosition"
          exit="exitPosition"
          transition={{
            duration: effectiveDuration,
            when: 'beforeChildren',
            ease: 'easeOut'
          }}
          layoutRoot
          variants={animationVariants}
        >
          {renderRoute(activeRoute, activeIndex)}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
};
