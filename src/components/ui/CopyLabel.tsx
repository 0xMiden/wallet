import React from 'react';

import { AnimatePresence, useReducedMotion } from 'framer-motion';

import { copyMotion } from 'lib/animation/copy';
import { cn } from 'lib/ui/util';

import { CopyState, CurrentCopyState, SwapSlot } from './animate/copy-swap';

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
