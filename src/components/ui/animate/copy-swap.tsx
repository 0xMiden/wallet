import React from 'react';

import { motion } from 'framer-motion';

import { type CopySwapMotion } from 'lib/animation/copy';

/**
 * The two halves of a copy confirmation - the glyph that morphs to a check and the label that
 * rolls to "Copied" - are separate components that animate the same way. This is the shared
 * mechanism they both mount inside `AnimatePresence`, kept here rather than beside either one so
 * neither owns it. It is internal to `components/ui`: the barrel does not export it.
 */
interface SwapSlotProps {
  swap: CopySwapMotion;
  className?: string;
  'data-copy-state': CopyState;
  children: React.ReactNode;
}

export type CopyState = 'idle' | 'copied';

// The state the swap is settling on. The leaving slot is a stale element `AnimatePresence` keeps
// rendering with its old props, but it still reads context, so this is how it learns it is on
// its way out (framer's own `useIsPresent` would work too, but the wallet's many framer-motion
// test stubs do not provide it).
export const CurrentCopyState = React.createContext<CopyState>('idle');

/**
 * One side of a copy swap inside `AnimatePresence`. Marks itself `aria-hidden` (and
 * `data-present="false"`) while it animates out, so the outgoing glyph or label is never read and
 * tests can tell the settled side from the leaving one.
 */
// `forwardRef`: `AnimatePresence mode="popLayout"` hands its direct child a ref to measure the
// outgoing element before popping it out of layout.
export const SwapSlot = React.forwardRef<HTMLSpanElement, SwapSlotProps>(
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
