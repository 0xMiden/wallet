import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { AnimatePresence, motion } from 'framer-motion';

import { useTabBarMotion } from 'lib/animation';
import { useOverlayScreenKey } from 'lib/e2e/useOverlayScreenKey';
import { useMobileBackHandler } from 'lib/mobile/useMobileBackHandler';
import Portal from 'lib/ui/Portal';
import { cn } from 'lib/ui/util';

/** Which edge of the anchor the panel lines up with: its start (left) or its end (right). */
export type PopoverAlign = 'start' | 'end';

export interface PopoverProps {
  open: boolean;
  /** Escape, a tap outside, the mobile back gesture, and anything the content itself decides. */
  onClose: () => void;
  /** The control the panel hangs from — normally the `IconButton` that opened it. */
  anchorRef: React.RefObject<HTMLElement | null>;
  align?: PopoverAlign;
  /** Panel width in px. A popover is a menu, not a page: it stays a fixed, readable width. */
  width?: number;
  /** Accessible name: a focus-trapped panel is a dialog and has to be named. */
  'aria-label': string;
  /** Names this popover's overlay segment for the E2E screen key. */
  screenKey?: string;
  children: React.ReactNode;
  /** Layout only (margins); the surface, radius and shadow are the popover's own. */
  className?: string;
  'data-testid'?: string;
}

/** 16px page margin: the panel never sits closer to an edge than the page's own content does. */
const VIEWPORT_MARGIN = 16;
/** 8px under the anchor, the same gap the header's rule leaves under itself. */
const ANCHOR_GAP = 8;
const DEFAULT_WIDTH = 288;

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

interface PanelPosition {
  top: number;
  left: number;
  maxHeight: number;
}

function measure(anchor: HTMLElement | null, width: number, align: PopoverAlign): PanelPosition | null {
  if (!anchor) return null;
  const rect = anchor.getBoundingClientRect();
  const viewportWidth = window.innerWidth || width + VIEWPORT_MARGIN * 2;
  const viewportHeight = window.innerHeight || 0;
  const top = rect.bottom + ANCHOR_GAP;
  const aligned = align === 'end' ? rect.right - width : rect.left;
  return {
    top,
    left: Math.max(VIEWPORT_MARGIN, Math.min(aligned, viewportWidth - width - VIEWPORT_MARGIN)),
    // Rather than flipping above the anchor: a header's button is at the top of the screen, so
    // there is never more room up there, and a panel that scrolls keeps every choice reachable.
    maxHeight: Math.max(0, viewportHeight - top - VIEWPORT_MARGIN)
  };
}

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
 * Positioning is measured from the anchor on open and re-measured on scroll and resize; the panel
 * is clamped to the 16px page margin and, if it would run off the bottom, scrolls rather than
 * flipping above a control that is usually already at the top of the screen.
 */
export const Popover: React.FC<PopoverProps> = ({
  open,
  onClose,
  anchorRef,
  align = 'end',
  width = DEFAULT_WIDTH,
  'aria-label': ariaLabel,
  screenKey,
  children,
  className,
  'data-testid': dataTestId
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<PanelPosition | null>(null);
  const motionTokens = useTabBarMotion();

  useOverlayScreenKey(open, screenKey ? `popover:${screenKey}` : 'popover');
  useMobileBackHandler(
    () => {
      if (!open) return false;
      onClose();
      return true;
    },
    [open, onClose],
    { overlay: true }
  );

  const reposition = useCallback(() => {
    setPosition(measure(anchorRef.current, width, align));
  }, [anchorRef, width, align]);

  // Layout, not passive: the panel is positioned from a measurement, so a frame painted at the
  // default offset before the effect ran would show it in the wrong place and then jump.
  useLayoutEffect(() => {
    if (!open) return;
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    // `capture`, so a scroll inside the page's own scroller (which does not bubble) moves the
    // panel too, not only a scroll of the window.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  // Escape on the document, not on the panel: a click that lands on the backdrop leaves focus
  // outside the panel, and Escape has to keep working from there.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  // Focus into the panel on open, and back onto the anchor when it closes — the anchor is still
  // mounted (it is what opened this), so the user never loses their place in the header.
  useEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const first = panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panelRef.current)?.focus();
    return () => anchor?.focus();
  }, [open, anchorRef]);

  const trapTab = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Tab') return;
    const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    // Nothing to move to: keep focus in the panel rather than letting Tab escape to the page
    // behind it, which the user cannot see past the panel anyway.
    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panelRef.current)) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  return (
    <Portal>
      <AnimatePresence>
        {open && (
          <>
            {/* Hit target only: a popover explains itself by where it hangs, so dimming the page
                behind it would be louder than the menu it is opening. */}
            <div
              data-testid={dataTestId ? `${dataTestId}-backdrop` : undefined}
              aria-hidden="true"
              className="fixed inset-0 z-50"
              onPointerDown={onClose}
            />
            <motion.div
              key="panel"
              ref={panelRef}
              role="dialog"
              aria-modal="true"
              aria-label={ariaLabel}
              data-testid={dataTestId}
              tabIndex={-1}
              onKeyDown={trapTab}
              style={{
                width,
                top: position?.top ?? 0,
                left: position?.left ?? 0,
                maxHeight: position?.maxHeight,
                transformOrigin: align === 'end' ? 'top right' : 'top left'
              }}
              initial={{ opacity: 0, scale: 0.94, y: -6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: -4 }}
              transition={motionTokens.highlight}
              className={cn(
                'fixed z-50 overflow-y-auto overscroll-contain rounded-2xl bg-page outline-none',
                'border border-hairline shadow-raised no-scrollbar',
                className
              )}
            >
              {children}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </Portal>
  );
};

export default Popover;
