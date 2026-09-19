import React from 'react';

import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';

import { Icon, IconName, IconSize } from 'app/icons/v2';
import { copyMotion, type CopySwapMotion } from 'lib/animation/copy';
import { cn } from 'lib/ui/util';

interface SwapSlotProps {
  swap: CopySwapMotion;
  className?: string;
  'data-copy-state': CopyState;
  children: React.ReactNode;
}

type CopyState = 'idle' | 'copied';

// The state the swap is settling on. The leaving slot is a stale element `AnimatePresence` keeps
// rendering with its old props, but it still reads context, so this is how it learns it is on
// its way out (framer's own `useIsPresent` would work too, but the wallet's many framer-motion
// test stubs do not provide it).
const CurrentCopyState = React.createContext<CopyState>('idle');

/**
 * One side of a copy swap inside `AnimatePresence`. Marks itself `aria-hidden` (and
 * `data-present="false"`) while it animates out, so the outgoing glyph or label is never read and
 * tests can tell the settled side from the leaving one.
 */
// `forwardRef`: `AnimatePresence mode="popLayout"` hands its direct child a ref to measure the
// outgoing element before popping it out of layout.
const SwapSlot = React.forwardRef<HTMLSpanElement, SwapSlotProps>(
  ({ swap, className, 'data-copy-state': state, children }, ref) => {
    const isPresent = React.useContext(CurrentCopyState) === state;
    return (
      <motion.span
        ref={ref}
        initial={swap.initial}
        animate={swap.animate}
        exit={swap.exit}
        transition={swap.transition}
        aria-hidden={isPresent ? undefined : true}
        data-copy-state={state}
        data-present={isPresent ? 'true' : 'false'}
        className={className}
      >
        {children}
      </motion.span>
    );
  }
);
SwapSlot.displayName = 'SwapSlot';

export interface AnimatedCopyIconProps {
  /** Whether the copy just succeeded: the glyph shows a check instead of the copy mark. */
  copied: boolean;
  size?: IconSize;
  /** Classes for the glyph box. Colour comes from `currentColor`, so this is usually layout only. */
  className?: string;
  /** Extra classes for the check alone, e.g. `text-positive-ink` to colour the confirmation. */
  checkClassName?: string;
}

const ICON_BOX: Record<IconSize, string> = {
  xs: 'w-4 h-4',
  sm: 'w-5 h-5',
  md: 'w-6 h-6',
  lg: 'w-8 h-8',
  xl: 'w-12 h-12',
  xxl: 'w-16 h-16',
  '3xl': 'w-40 h-40',
  '4xl': 'w-49 h-49',
  '5xl': 'w-64 h-64'
};

const Glyph: React.FC<{ copied: boolean; checkClassName?: string }> = ({ copied, checkClassName }) =>
  copied ? (
    // The check is a filled path in a `fill="none"` svg: it needs `currentColor` to paint.
    <Icon name={IconName.Checkmark} fill="currentColor" className={cn('w-full! h-full!', checkClassName)} />
  ) : (
    <Icon name={IconName.CopyNew} className="w-full! h-full!" />
  );

/**
 * The copy glyph that morphs into a check after a copy and back once the feedback window ends
 * (`copyMotion.icon`: scale, a small turn and a blur crossfade on the `tabSwitch` spring). The
 * outgoing glyph pops out of layout (`mode="popLayout"`), so the two overlap in one box instead of
 * pushing the label beside them. Decorative: the copy control announces the state itself.
 */
export const AnimatedCopyIcon: React.FC<AnimatedCopyIconProps> = ({
  copied,
  size = 'xs',
  className,
  checkClassName
}) => {
  const reduceMotion = useReducedMotion();
  const state: CopyState = copied ? 'copied' : 'idle';
  const box = cn('relative inline-flex shrink-0 items-center justify-center', ICON_BOX[size], className);

  if (reduceMotion) {
    return (
      <span aria-hidden="true" data-copy-icon data-reduced-motion="true" className={box}>
        <span data-copy-state={state} data-present="true" className="flex h-full w-full items-center justify-center">
          <Glyph copied={copied} checkClassName={checkClassName} />
        </span>
      </span>
    );
  }

  return (
    <span aria-hidden="true" data-copy-icon className={box}>
      <CurrentCopyState.Provider value={state}>
        <AnimatePresence mode="popLayout" initial={false}>
          <SwapSlot
            key={state}
            swap={copyMotion.icon}
            data-copy-state={state}
            className="flex h-full w-full items-center justify-center"
          >
            <Glyph copied={copied} checkClassName={checkClassName} />
          </SwapSlot>
        </AnimatePresence>
      </CurrentCopyState.Provider>
    </span>
  );
};

export interface CopyLabelProps {
  copied: boolean;
  /** The label before a copy, e.g. "Copy" or the value itself. */
  children: React.ReactNode;
  /** The label the slot rolls to after a copy, e.g. "Copied". */
  copiedLabel: React.ReactNode;
  className?: string;
}

/**
 * A label that rolls to `copiedLabel` after a copy and back once the feedback window ends
 * (`copyMotion.label`): the old label rises out of the slot as the new one rises in from below,
 * clipped vertically so it reads as one line turning over. Long labels still truncate.
 */
export const CopyLabel: React.FC<CopyLabelProps> = ({ copied, children, copiedLabel, className }) => {
  const reduceMotion = useReducedMotion();
  const state: CopyState = copied ? 'copied' : 'idle';
  const slot = 'block min-w-0 truncate';

  return (
    <span data-copy-label className={cn('relative inline-flex min-w-0 overflow-y-clip', className)}>
      {reduceMotion ? (
        <span data-copy-state={state} data-present="true" className={slot}>
          {copied ? copiedLabel : children}
        </span>
      ) : (
        <CurrentCopyState.Provider value={state}>
          <AnimatePresence mode="popLayout" initial={false}>
            <SwapSlot key={state} swap={copyMotion.label} data-copy-state={state} className={slot}>
              {copied ? copiedLabel : children}
            </SwapSlot>
          </AnimatePresence>
        </CurrentCopyState.Provider>
      )}
    </span>
  );
};
