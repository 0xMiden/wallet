/**
 * Highlight — Animate UI's highlight effect primitive, copied in from the shadcn registry item
 * `primitives-effects-highlight` (https://animate-ui.com/r/primitives-effects-highlight.json,
 * docs https://animate-ui.com/docs/primitives/effects/highlight) on 2026-09-19. One highlight
 * shared by every item of a set moves to the active item — the tab bars use it for their sliding
 * pill.
 *
 * The registry file ships without a header; Animate UI's license (reproduced below, as it requires)
 * is https://github.com/imskyleen/animate-ui/blob/main/LICENSE.md.
 *
 * Local changes, so it fits this repo:
 * - `motion/react` → `framer-motion`, `@/lib/utils` → `lib/ui/util`; no `'use client'`.
 * - React 18: `ref` arrives through `forwardRef`, not as a prop.
 * - The polymorphic `as` is a closed set of intrinsic tags, and the types carry no `any` or casts.
 * - The transition goes through `resolveTransition`, so the highlight moves instantly under reduced
 *   motion.
 * - `asChild` in `children` mode rendered the child inside itself; it now renders the child's own
 *   children.
 * - Items no longer get `aria-selected`: whether it applies depends on the item's role (a tab takes
 *   `aria-selected`, a navigation link `aria-current`), so the caller sets it.
 * - A controlled `value` is derived during render rather than mirrored into state by a passive
 *   effect, so it applies in the same commit as the items that read it. Two deltas from upstream
 *   follow: `defaultValue` is now seed-only for the uncontrolled path (the deleted effect also
 *   re-applied it when it changed), and `onValueChange` is called outside the state updater.
 * - Parent mode installs its bounds setter in a layout effect: installed in a passive effect it
 *   arrived after the items had measured on mount, so the first active item got no highlight.
 *
 * ---------------------------------------------------------------------------------------------
 * MIT + Commons Clause License Condition
 *
 * Copyright (c) 2025 Elliot Sutton
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, and distribute the Software **as part of an application,
 * website, or product**, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * Commons Clause Restriction
 *
 * You may use this Software, including for any commercial purpose, **so long as you do not sell or
 * redistribute the components themselves in their original form—whether alone or in a bundle.**
 *
 * No Warranty
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 * ---------------------------------------------------------------------------------------------
 */

import * as React from 'react';

import { AnimatePresence, motion, useReducedMotion, type Transition } from 'framer-motion';

import { resolveTransition } from 'lib/animation';
import { cn } from 'lib/ui/util';

type HighlightMode = 'children' | 'parent';

/** The tags a Highlight container or item can render as. */
export type HighlightTag = 'div' | 'span' | 'ul' | 'li' | 'nav';

type Bounds = {
  top: number;
  left: number;
  width: number;
  height: number;
};

const DEFAULT_BOUNDS_OFFSET: Bounds = {
  top: 0,
  left: 0,
  width: 0,
  height: 0
};

const DEFAULT_TRANSITION: Transition = { type: 'spring', stiffness: 350, damping: 35 };

type HighlightContextType = {
  mode: HighlightMode;
  activeValue: string | null;
  setActiveValue: (value: string | null) => void;
  setBounds: (bounds: DOMRect) => void;
  clearBounds: () => void;
  id: string;
  hover: boolean;
  click: boolean;
  className?: string;
  style?: React.CSSProperties;
  activeClassName?: string;
  setActiveClassName: (className: string) => void;
  transition?: Transition;
  disabled?: boolean;
  enabled?: boolean;
  exitDelay?: number;
  forceUpdateBounds?: boolean;
};

const HighlightContext = React.createContext<HighlightContextType | undefined>(undefined);

function useHighlight(): HighlightContextType {
  const context = React.useContext(HighlightContext);
  if (!context) {
    throw new Error('useHighlight must be used within a HighlightProvider');
  }
  return context;
}

type BaseHighlightProps = {
  as?: HighlightTag;
  mode?: HighlightMode;
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string | null) => void;
  className?: string;
  style?: React.CSSProperties;
  transition?: Transition;
  hover?: boolean;
  click?: boolean;
  disabled?: boolean;
  enabled?: boolean;
  exitDelay?: number;
};

type ParentModeHighlightProps = {
  boundsOffset?: Partial<Bounds>;
  containerClassName?: string;
  forceUpdateBounds?: boolean;
};

type ControlledParentModeHighlightProps = BaseHighlightProps &
  ParentModeHighlightProps & {
    mode: 'parent';
    controlledItems: true;
    children: React.ReactNode;
  };

type ControlledChildrenModeHighlightProps = BaseHighlightProps & {
  mode?: 'children' | undefined;
  controlledItems: true;
  children: React.ReactNode;
};

type UncontrolledParentModeHighlightProps = BaseHighlightProps &
  ParentModeHighlightProps & {
    mode: 'parent';
    controlledItems?: false;
    itemsClassName?: string;
    children: React.ReactElement | React.ReactElement[];
  };

type UncontrolledChildrenModeHighlightProps = BaseHighlightProps & {
  mode?: 'children';
  controlledItems?: false;
  itemsClassName?: string;
  children: React.ReactElement | React.ReactElement[];
};

type HighlightProps =
  | ControlledParentModeHighlightProps
  | ControlledChildrenModeHighlightProps
  | UncontrolledParentModeHighlightProps
  | UncontrolledChildrenModeHighlightProps;

const Highlight = React.forwardRef<HTMLElement, HighlightProps>(function Highlight(props, ref) {
  const {
    as: Component = 'div',
    children,
    value,
    defaultValue,
    onValueChange,
    className,
    style,
    transition: transitionProp = DEFAULT_TRANSITION,
    hover = false,
    click = true,
    enabled = true,
    controlledItems,
    disabled = false,
    exitDelay = 200,
    mode = 'children'
  } = props;

  const reduceMotion = useReducedMotion();
  const transition = resolveTransition(reduceMotion, transitionProp);

  const localRef = React.useRef<HTMLElement | null>(null);
  React.useImperativeHandle<HTMLElement | null, HTMLElement | null>(ref, () => localRef.current);
  const setLocalRef = React.useCallback((node: HTMLElement | null) => {
    localRef.current = node;
  }, []);

  const parentProps: ParentModeHighlightProps = 'boundsOffset' in props || 'containerClassName' in props ? props : {};
  const forceUpdateBounds = 'forceUpdateBounds' in props ? props.forceUpdateBounds : undefined;
  const itemsClassName = 'itemsClassName' in props ? props.itemsClassName : undefined;

  const boundsOffset = parentProps.boundsOffset ?? DEFAULT_BOUNDS_OFFSET;
  const boundsOffsetTop = boundsOffset.top ?? 0;
  const boundsOffsetLeft = boundsOffset.left ?? 0;
  const boundsOffsetWidth = boundsOffset.width ?? 0;
  const boundsOffsetHeight = boundsOffset.height ?? 0;

  const boundsOffsetRef = React.useRef({
    top: boundsOffsetTop,
    left: boundsOffsetLeft,
    width: boundsOffsetWidth,
    height: boundsOffsetHeight
  });

  React.useEffect(() => {
    boundsOffsetRef.current = {
      top: boundsOffsetTop,
      left: boundsOffsetLeft,
      width: boundsOffsetWidth,
      height: boundsOffsetHeight
    };
  }, [boundsOffsetTop, boundsOffsetLeft, boundsOffsetWidth, boundsOffsetHeight]);

  // Derived during render, not mirrored into state by an effect. Mirroring made a controlled
  // `value` land one commit late, so the highlight was still parented to the item the owner had
  // already deselected, and in a bar whose items resize, that is a commit where the projected
  // box is the wrong size.
  const [uncontrolled, setUncontrolled] = React.useState<string | null>(defaultValue ?? null);
  const activeValue = value !== undefined ? value : uncontrolled;
  const [boundsState, setBoundsState] = React.useState<Bounds | null>(null);
  const [activeClassNameState, setActiveClassNameState] = React.useState<string>('');

  // Compared against the DERIVED value, so a controlled owner that declines a change cannot leave
  // an uncontrolled shadow behind and swallow the next selection. `onValueChange` is called here
  // rather than inside a state updater, which must be pure.
  const safeSetActiveValue = (id: string | null) => {
    if (activeValue === id) return;
    onValueChange?.(id);
    if (value === undefined) setUncontrolled(id);
  };

  const safeSetBoundsRef = React.useRef<((bounds: DOMRect) => void) | undefined>(undefined);

  // A layout effect, so the setter exists before any item's passive effect measures on mount.
  React.useLayoutEffect(() => {
    safeSetBoundsRef.current = (bounds: DOMRect) => {
      if (!localRef.current) return;

      const containerRect = localRef.current.getBoundingClientRect();
      const offset = boundsOffsetRef.current;
      const newBounds: Bounds = {
        top: bounds.top - containerRect.top + offset.top,
        left: bounds.left - containerRect.left + offset.left,
        width: bounds.width + offset.width,
        height: bounds.height + offset.height
      };

      setBoundsState(prev => {
        if (
          prev &&
          prev.top === newBounds.top &&
          prev.left === newBounds.left &&
          prev.width === newBounds.width &&
          prev.height === newBounds.height
        ) {
          return prev;
        }
        return newBounds;
      });
    };
  });

  const safeSetBounds = (bounds: DOMRect) => {
    safeSetBoundsRef.current?.(bounds);
  };

  const clearBounds = React.useCallback(() => {
    setBoundsState(prev => (prev === null ? prev : null));
  }, []);

  const id = React.useId();

  React.useEffect(() => {
    if (mode !== 'parent') return;
    const container = localRef.current;
    if (!container) return;

    const onScroll = () => {
      if (!activeValue) return;
      const activeEl = container.querySelector<HTMLElement>(`[data-value="${activeValue}"][data-highlight="true"]`);
      if (activeEl) safeSetBoundsRef.current?.(activeEl.getBoundingClientRect());
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [mode, activeValue]);

  const render = (content: React.ReactNode) => {
    if (mode === 'parent') {
      return (
        <Component
          ref={setLocalRef}
          data-slot="motion-highlight-container"
          style={{ position: 'relative', zIndex: 1 }}
          className={parentProps.containerClassName}
        >
          <AnimatePresence initial={false} mode="wait">
            {boundsState && (
              <motion.div
                data-slot="motion-highlight"
                animate={{
                  top: boundsState.top,
                  left: boundsState.left,
                  width: boundsState.width,
                  height: boundsState.height,
                  opacity: 1
                }}
                initial={{
                  top: boundsState.top,
                  left: boundsState.left,
                  width: boundsState.width,
                  height: boundsState.height,
                  opacity: 0
                }}
                exit={{
                  opacity: 0,
                  transition: {
                    ...transition,
                    delay: (transition.delay ?? 0) + exitDelay / 1000
                  }
                }}
                transition={transition}
                style={{ position: 'absolute', zIndex: 0, ...style }}
                className={cn(className, activeClassNameState)}
              />
            )}
          </AnimatePresence>
          {content}
        </Component>
      );
    }

    return content;
  };

  return (
    <HighlightContext.Provider
      value={{
        mode,
        activeValue,
        setActiveValue: safeSetActiveValue,
        id,
        hover,
        click,
        className,
        style,
        transition,
        disabled,
        enabled,
        exitDelay,
        setBounds: safeSetBounds,
        clearBounds,
        activeClassName: activeClassNameState,
        setActiveClassName: setActiveClassNameState,
        forceUpdateBounds
      }}
    >
      {enabled
        ? controlledItems
          ? render(children)
          : render(
              React.Children.map(children, (child, index) => (
                <HighlightItem key={index} className={itemsClassName}>
                  {child}
                </HighlightItem>
              ))
            )
        : children}
    </HighlightContext.Provider>
  );
});

function getNonOverridingDataAttributes(
  element: React.ReactElement<ExtendedChildProps>,
  dataAttributes: Record<string, unknown>
): Record<string, unknown> {
  const elementProps: Record<string, unknown> = { ...element.props };
  return Object.keys(dataAttributes).reduce<Record<string, unknown>>((acc, key) => {
    if (elementProps[key] === undefined) {
      acc[key] = dataAttributes[key];
    }
    return acc;
  }, {});
}

type ExtendedChildProps = React.HTMLAttributes<HTMLElement> & {
  id?: string;
  ref?: React.Ref<HTMLElement>;
  'data-active'?: string;
  'data-value'?: string;
  'data-disabled'?: boolean;
  'data-highlight'?: boolean;
  'data-slot'?: string;
};

type HighlightItemProps = Omit<React.HTMLAttributes<HTMLElement>, 'children'> & {
  as?: HighlightTag;
  children: React.ReactElement;
  id?: string;
  value?: string;
  className?: string;
  style?: React.CSSProperties;
  transition?: Transition;
  activeClassName?: string;
  disabled?: boolean;
  exitDelay?: number;
  asChild?: boolean;
  forceUpdateBounds?: boolean;
};

const HighlightItem = React.forwardRef<HTMLElement, HighlightItemProps>(function HighlightItem(
  {
    as,
    children,
    id,
    value,
    className,
    style,
    transition,
    disabled = false,
    activeClassName,
    exitDelay,
    asChild = false,
    forceUpdateBounds,
    ...props
  },
  ref
) {
  const itemId = React.useId();
  const {
    activeValue,
    setActiveValue,
    mode,
    setBounds,
    clearBounds,
    hover,
    click,
    enabled,
    className: contextClassName,
    style: contextStyle,
    transition: contextTransition,
    id: contextId,
    disabled: contextDisabled,
    exitDelay: contextExitDelay,
    forceUpdateBounds: contextForceUpdateBounds,
    setActiveClassName
  } = useHighlight();

  const element = React.isValidElement<ExtendedChildProps>(children) ? children : null;
  const Component: HighlightTag = as ?? 'div';
  const childValue = id ?? value ?? element?.props['data-value'] ?? element?.props.id ?? itemId;
  const isActive = activeValue === childValue;
  const isDisabled = disabled === undefined ? contextDisabled : disabled;
  const itemTransition = transition ?? contextTransition;

  const localRef = React.useRef<HTMLElement | null>(null);
  React.useImperativeHandle<HTMLElement | null, HTMLElement | null>(ref, () => localRef.current);

  const refCallback = React.useCallback((node: HTMLElement | null) => {
    localRef.current = node;
  }, []);

  React.useEffect(() => {
    if (mode !== 'parent') return;
    let rafId: number;
    let previousBounds: DOMRect | null = null;
    const shouldUpdateBounds = forceUpdateBounds === true || (contextForceUpdateBounds && forceUpdateBounds !== false);

    const updateBounds = () => {
      if (!localRef.current) return;

      const bounds = localRef.current.getBoundingClientRect();

      if (shouldUpdateBounds) {
        if (
          previousBounds &&
          previousBounds.top === bounds.top &&
          previousBounds.left === bounds.left &&
          previousBounds.width === bounds.width &&
          previousBounds.height === bounds.height
        ) {
          rafId = requestAnimationFrame(updateBounds);
          return;
        }
        previousBounds = bounds;
        rafId = requestAnimationFrame(updateBounds);
      }

      setBounds(bounds);
    };

    if (isActive) {
      updateBounds();
      setActiveClassName(activeClassName ?? '');
    } else if (!activeValue) clearBounds();

    if (shouldUpdateBounds) return () => cancelAnimationFrame(rafId);
    return undefined;
  }, [
    mode,
    isActive,
    activeValue,
    setBounds,
    clearBounds,
    activeClassName,
    setActiveClassName,
    forceUpdateBounds,
    contextForceUpdateBounds
  ]);

  if (!element) return children;

  const dataAttributes = {
    'data-active': isActive ? 'true' : 'false',
    'data-disabled': isDisabled,
    'data-value': childValue,
    'data-highlight': true
  };

  const commonHandlers = hover
    ? {
        onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
          setActiveValue(childValue);
          element.props.onMouseEnter?.(e);
        },
        onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
          setActiveValue(null);
          element.props.onMouseLeave?.(e);
        }
      }
    : click
      ? {
          onClick: (e: React.MouseEvent<HTMLElement>) => {
            setActiveValue(childValue);
            element.props.onClick?.(e);
          }
        }
      : {};

  const highlight = (
    <AnimatePresence initial={false} mode="wait">
      {isActive && !isDisabled && (
        <motion.div
          layoutId={`transition-background-${contextId}`}
          data-slot="motion-highlight"
          style={{
            position: 'absolute',
            zIndex: 0,
            ...contextStyle,
            ...style
          }}
          className={cn(contextClassName, activeClassName)}
          transition={itemTransition}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{
            opacity: 0,
            transition: {
              ...itemTransition,
              delay: (itemTransition?.delay ?? 0) + (exitDelay ?? contextExitDelay ?? 0) / 1000
            }
          }}
          {...dataAttributes}
        />
      )}
    </AnimatePresence>
  );

  if (asChild) {
    if (mode === 'children') {
      return React.cloneElement(
        element,
        {
          key: childValue,
          ref: refCallback,
          className: cn('relative', element.props.className),
          ...getNonOverridingDataAttributes(element, {
            ...dataAttributes,
            'data-slot': 'motion-highlight-item-container'
          }),
          ...commonHandlers,
          ...props
        },
        <>
          {highlight}

          <Component
            data-slot="motion-highlight-item"
            style={{ position: 'relative', zIndex: 1 }}
            className={className}
            {...dataAttributes}
          >
            {element.props.children}
          </Component>
        </>
      );
    }

    return React.cloneElement(element, {
      ref: refCallback,
      ...getNonOverridingDataAttributes(element, {
        ...dataAttributes,
        'data-slot': 'motion-highlight-item'
      }),
      ...commonHandlers
    });
  }

  if (!enabled) return children;

  const item = React.cloneElement(element, {
    style: { position: 'relative', zIndex: 1 },
    className: element.props.className,
    ...getNonOverridingDataAttributes(element, {
      ...dataAttributes,
      'data-slot': 'motion-highlight-item'
    })
  });

  return (
    <Component
      key={childValue}
      ref={refCallback}
      data-slot="motion-highlight-item-container"
      className={cn(mode === 'children' && 'relative', className)}
      {...dataAttributes}
      {...props}
      {...commonHandlers}
    >
      {mode === 'children' && highlight}

      {item}
    </Component>
  );
});

export { Highlight, HighlightItem, useHighlight, type HighlightProps, type HighlightItemProps };
