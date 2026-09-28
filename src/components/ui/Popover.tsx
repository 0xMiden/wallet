import React, { useEffect, useRef } from 'react';

import {
  autoUpdate,
  FloatingFocusManager,
  offset,
  shift,
  size,
  useDismiss,
  useFloating,
  useInteractions,
  useRole
} from '@floating-ui/react';
import { AnimatePresence, motion } from 'framer-motion';

import { usePageActive } from 'app/layouts/page-active';
import { useTabBarMotion } from 'lib/animation';
import { useOverlayScreenKey } from 'lib/e2e/useOverlayScreenKey';
import { useCloseOnBack } from 'lib/mobile/useCloseOnBack';
import Portal from 'lib/ui/Portal';
import { cn } from 'lib/ui/util';
import { useLocation } from 'lib/woozie';

/** Which edge of the anchor the panel lines up with. Only its end (right) edge has a caller. */
export type PopoverAlign = 'end';

export interface PopoverProps {
  open: boolean;
  /** Escape, a tap outside, the mobile back gesture, and anything the content itself decides. */
  onClose: () => void;
  /** The control the panel hangs from — normally the `IconButton` that opened it. */
  anchorRef: React.RefObject<HTMLElement | null>;
  align?: PopoverAlign;
  /** Accessible name: a focus-trapped panel is a dialog and has to be named. */
  'aria-label': string;
  /** Names this popover's overlay segment for the E2E screen key. */
  screenKey?: string;
  children: React.ReactNode;
  'data-testid'?: string;
}

/** 16px page margin: the panel never sits closer to an edge than the page's own content does. */
const VIEWPORT_MARGIN = 16;
/** 8px under the anchor, the same gap the header's rule leaves under itself. */
const ANCHOR_GAP = 8;

/**
 * The wallet's anchored popover: a panel hanging off the control that opened it, for a short menu
 * of choices that would be too much chrome as a sheet — the Activity tab's view switcher is the
 * first one.
 *
 * It is a dialog, not a tooltip: focus moves into the panel on open, Tab cycles inside it, and
 * Escape, a tap outside or the mobile back gesture closes it and hands focus back to the anchor.
 * It rides the tab bar's own spring (`useTabBarMotion`), so it opens with the same physics as the
 * nav highlight and the segmented control's bubble, and settles instantly under reduced motion.
 *
 * Placement, dismissal and the focus trap are floating-ui's, as in `InfoHint`. The panel keeps to
 * the 16px page margin and, if it would run off the bottom, scrolls rather than flipping above a
 * control that is usually already at the top of the screen.
 */
export const Popover: React.FC<PopoverProps> = ({
  open,
  onClose,
  anchorRef,
  align = 'end',
  'aria-label': ariaLabel,
  screenKey,
  children,
  'data-testid': dataTestId
}) => {
  const motionTokens = useTabBarMotion();

  const { refs, floatingStyles, context } = useFloating({
    open,
    onOpenChange: next => {
      if (!next) onClose();
    },
    elements: { reference: anchorRef.current },
    placement: `bottom-${align}`,
    strategy: 'fixed',
    // top/left rather than a translate, so framer-motion owns the panel's transform.
    transform: false,
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(ANCHOR_GAP),
      shift({ padding: VIEWPORT_MARGIN }),
      size({
        padding: VIEWPORT_MARGIN,
        apply: ({ availableHeight, elements }) => {
          elements.floating.style.maxHeight = `${Math.max(0, availableHeight)}px`;
        }
      })
    ]
  });

  const { getFloatingProps } = useInteractions([
    useDismiss(context, { outsidePress: true, escapeKey: true }),
    useRole(context, { role: 'dialog' })
  ]);

  // Portaled, so leaving the page does not unmount it: a tab switch keeps the page mounted but inactive and
  // fires no outside press. Close on a route or hash change and when the page goes off screen, as
  // NetworkModeSheet does. Only a change closes it, so a popover that mounts open stays open.
  const { pathname, hash } = useLocation();
  const pageActive = usePageActive();
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const openRef = useRef(open);
  openRef.current = open;
  const lastWhere = useRef({ pathname, hash, pageActive });
  useEffect(() => {
    const last = lastWhere.current;
    lastWhere.current = { pathname, hash, pageActive };
    const moved = last.pathname !== pathname || last.hash !== hash || last.pageActive !== pageActive;
    if (moved && openRef.current) onCloseRef.current();
  }, [pathname, hash, pageActive]);

  useOverlayScreenKey(open, screenKey ? `popover:${screenKey}` : 'popover');
  useCloseOnBack(open, onClose);

  return (
    <Portal>
      {/* Outside AnimatePresence and disabled once closed, so the page stops being hidden and
          focus returns to the anchor as the panel starts its exit, not after it. */}
      <FloatingFocusManager context={context} disabled={!open}>
        <AnimatePresence>
          {open && (
            <motion.div
              key="panel"
              ref={refs.setFloating}
              aria-modal="true"
              aria-label={ariaLabel}
              data-testid={dataTestId}
              style={{ ...floatingStyles, transformOrigin: 'top right' }}
              initial={{ opacity: 0, scale: 0.94, y: -6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: -4 }}
              transition={motionTokens.highlight}
              className={cn(
                'z-50 w-72 overflow-y-auto overscroll-contain rounded-2xl bg-page outline-none',
                'border border-hairline shadow-raised no-scrollbar'
              )}
              {...getFloatingProps()}
            >
              {children}
            </motion.div>
          )}
        </AnimatePresence>
      </FloatingFocusManager>
    </Portal>
  );
};

export default Popover;
