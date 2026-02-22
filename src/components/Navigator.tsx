import React, { createContext, useContext, useState, useCallback, ReactNode, useMemo, useEffect } from 'react';

import { AnimatePresence, motion } from 'framer-motion';

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
  const [cardStack, setCardStack] = useState<Route[]>([]);
  const [navigationDirection, setNavigationDirection] = useState<AnimationDirection>('forward');

  const navigate = useCallback(
    (route: Route) => {
      if (cardStack.length === 0) {
        setCardStack([route]);
        return;
      }

      const currentRoute = cardStack[cardStack.length - 1];

      if (currentRoute.animationIn === 'push' && route.animationIn === 'present') {
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
      if (currentRoute.animationIn === 'present' && previousRoute.animationIn === 'push') {
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
  initialRouteName: string;
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
  backgroundColor: '#ffffff',
  y: '0vw',
  scale: 1
};

const FocusPosition: AnimationConfig = {
  x: '0vw',
  y: '0vw',
  opacity: 1,
  scale: 1,
  backgroundColor: '#ffffff'
};

const PushExitPosition: AnimationConfig = {
  x: '0vw',
  y: '0vw',
  opacity: 1,
  scale: 1,
  backgroundColor: '#ffffff'
};

const PushHiddenPosition: AnimationConfig = {
  x: '0vw',
  y: '0vw',
  opacity: 1,
  scale: 1,
  backgroundColor: '#ffffff'
};

const PushModalBackgroundPosition: AnimationConfig = {
  x: '0vw',
  y: '0vw',
  opacity: 0.0,
  scale: 0.95,
  backgroundColor: '#ffffff'
};

const PresentInitialPosition: AnimationConfig = {
  x: '0vw',
  y: '25vw',
  opacity: 0,
  scale: 1,
  backgroundColor: '#ffffff'
};

const PresentExitPosition: AnimationConfig = {
  x: '0vw',
  y: '25vw',
  opacity: 0,
  scale: 1,
  backgroundColor: '#ffffff'
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

export const Navigator: React.FC<NavigatorProps> = ({
  renderRoute,
  initialRouteName,
  animationDuration = 0.15,
  animationConfig = DefaultAnimationConfig
}) => {
  const { direction, cardStack, routes, activeRoute, activeIndex, navigateTo } = useNavigator();

  // Only animate on mobile (disable for Chrome extension)
  const effectiveDuration = isMobile() ? animationDuration : 0;

  useEffect(() => {
    // const initialRoute = routes.find(r => r.name === initialRouteName);
    if (initialRouteName && cardStack.length === 0) {
      navigateTo(initialRouteName);
    }
  }, [initialRouteName, cardStack, routes, navigateTo]);

  const animationVariants = useMemo(() => {
    return {
      initialPosition: (config: { in: AnimationIn; out: AnimationOut; direction: AnimationDirection }) => {
        if (config.in === 'push') {
          if (config.direction === 'down') {
            return animationConfig.pushModalBackgroundPosition;
          }

          return config.direction === 'forward'
            ? animationConfig.pushInitialPosition
            : animationConfig.pushHiddenPosition;
        } else {
          return animationConfig.presentInitialPosition;
        }
      },
      focusPosition: animationConfig.focusPosition,
      exitPosition: (config: { in: AnimationIn; out: AnimationOut; direction: AnimationDirection }) => {
        if (config.out === 'pop') {
          if (config.direction === 'up') {
            return animationConfig.pushModalBackgroundPosition;
          }
          return config.direction === 'forward' ? animationConfig.pushHiddenPosition : animationConfig.pushExitPosition;
        } else {
          return animationConfig.presentExitPosition;
        }
      }
    };
  }, [animationConfig]);

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
