import React, { useRef, useState } from 'react';

import {
  arrow,
  autoUpdate,
  flip,
  FloatingArrow,
  offset,
  shift,
  useClick,
  useDismiss,
  useFloating,
  useInteractions,
  useRole
} from '@floating-ui/react';
import { AnimatePresence, motion } from 'framer-motion';

import { Icon, IconName } from 'app/icons/v2';
import { springs, useMotion } from 'lib/animation';
import { hapticLight } from 'lib/mobile/haptics';
import Portal from 'lib/ui/Portal';
import { cn } from 'lib/ui/util';

export interface InfoHintProps {
  /** The one sentence the bubble carries. Already translated. */
  children: React.ReactNode;
  /** Accessible name for the trigger, e.g. "More information about Rate". */
  label: string;
  /** Layout only (margins); the look is the component's own. */
  className?: string;
  'data-testid'?: string;
}

export interface InfoHintTriggerProps extends Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  'type' | 'children' | 'aria-label'
> {
  /** Accessible name. Required: the glyph alone has no text for assistive tech to read. */
  label: string;
  'data-testid'?: string;
}

/**
 * The (i) itself: a 24px `muted` circle with the info glyph. InfoHint opens its bubble from it; a
 * caller whose explanation needs a sheet renders it too and opens the sheet, so the two (i)s match.
 */
export const InfoHintTrigger = React.forwardRef<HTMLButtonElement, InfoHintTriggerProps>(function InfoHintTrigger(
  { label, className, ...props },
  ref
) {
  return (
    <button
      type="button"
      ref={ref}
      aria-label={label}
      className={cn(
        'relative inline-flex size-6 shrink-0 items-center justify-center rounded-full text-muted',
        // A 44px hit area centred on the 24px circle: the row keeps its height, the ring stays on the circle.
        'before:absolute before:left-1/2 before:top-1/2 before:size-11 before:-translate-x-1/2 before:-translate-y-1/2',
        'outline-none focus-visible:ring-2 focus-visible:ring-accent-primary',
        className
      )}
      {...props}
    >
      <Icon name={IconName.Information} size="xs" fill="currentColor" aria-hidden="true" />
    </button>
  );
});

/** The arrow's size. */
const ARROW_WIDTH = 12;
const ARROW_HEIGHT = 6;
/** The bubble's rounded-2xl radius: the arrow never sits on the curved corner. */
const ARROW_CORNER_CLEARANCE = 16;

/**
 * A small (i) button that pops one sentence of explanation beside it.
 *
 * For the note a row needs but should not wear: a three-line caption under a value pushes the
 * rows it sits between apart and makes the card read as prose. The sentence itself is unchanged —
 * it just waits until it is asked for.
 *
 * Tap (or Enter/Space) opens it, a tap outside or Escape closes it, and the trigger is the
 * bubble's `aria-describedby` target, so a screen reader reads the note with the control it
 * belongs to instead of as loose text. The bubble follows its trigger while the page scrolls and
 * flips to the other side when it would run off the screen.
 */
export const InfoHint: React.FC<InfoHintProps> = ({ children, label, className, 'data-testid': dataTestId }) => {
  const [open, setOpen] = useState(false);
  const arrowRef = useRef<SVGSVGElement>(null);
  const transition = useMotion(springs.tabSwitch);

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: setOpen,
    placement: 'top',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(ARROW_HEIGHT + 4),
      flip(),
      shift({ padding: 12 }),
      arrow({ element: arrowRef, padding: ARROW_CORNER_CLEARANCE })
    ]
  });

  const { getReferenceProps, getFloatingProps } = useInteractions([
    useClick(context),
    // Tap outside (the only way most people close it on a phone) and Escape: the defaults.
    useDismiss(context),
    useRole(context, { role: 'tooltip' })
  ]);

  return (
    <>
      <InfoHintTrigger
        ref={refs.setReference}
        label={label}
        data-testid={dataTestId}
        className={className}
        {...getReferenceProps({ onClick: () => hapticLight() })}
      />

      <Portal>
        <AnimatePresence>
          {open && (
            <div ref={refs.setFloating} style={{ ...floatingStyles, zIndex: 50 }} {...getFloatingProps()}>
              <motion.div
                className="max-w-64 rounded-2xl border border-hairline bg-page px-3 py-2 text-caption text-ink shadow-raised"
                initial={{ opacity: 0, scale: 0.94 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.94 }}
                transition={transition}
              >
                {children}
                <FloatingArrow
                  ref={arrowRef}
                  context={context}
                  width={ARROW_WIDTH}
                  height={ARROW_HEIGHT}
                  className="fill-page [&>path:first-of-type]:stroke-hairline"
                />
              </motion.div>
            </div>
          )}
        </AnimatePresence>
      </Portal>
    </>
  );
};
