import React, { useCallback, useEffect, useMemo, useRef } from 'react';

import { hapticMedium } from 'lib/mobile/haptics';

export interface UseLongPressOptions {
  onLongPress: () => void;
  /** Hold duration before the press counts as long. */
  delayMs?: number;
  /** Pointer travel (px) past which the hold is treated as a scroll/drag and cancelled. */
  moveSlopPx?: number;
  disabled?: boolean;
}

export interface LongPressBind {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: React.PointerEvent<HTMLElement>) => void;
  onContextMenu: (event: React.MouseEvent<HTMLElement>) => void;
  onClickCapture: (event: React.MouseEvent<HTMLElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
}

/**
 * Marks a descendant whose presses must NOT arm the long press — an inline
 * button inside a long-pressable row. Holding it behaves as a plain press.
 */
export const LONG_PRESS_IGNORE_ATTRIBUTE = 'data-longpress-ignore';

const DEFAULT_DELAY_MS = 500;
const DEFAULT_SLOP_PX = 10;
// How long the one-shot click suppression stays armed after a fired hold if no
// click arrives at all (touch browsers often synthesize none).
const CLICK_SUPPRESS_FALLBACK_MS = 400;

/**
 * Press-and-hold for a row that also has ordinary taps and lives in a scroller.
 *
 * - Arms on a primary pointer (left mouse button only) and fires after `delayMs`.
 * - Cancels when the pointer travels past `moveSlopPx`, lifts, leaves, or when the
 *   page scrolls — so a vertical scroll that starts on the row never opens a menu.
 * - Presses that start inside `[data-longpress-ignore]` never arm, so an inline
 *   Claim button keeps its normal behaviour under a held finger.
 * - The click a browser may synthesize after a fired hold is swallowed once
 *   (`onClickCapture`), so the row's tap handler does not also run.
 * - Right-click (`contextmenu`) and the keyboard equivalents (`ContextMenu`,
 *   Shift+F10) fire immediately — the desktop/extension path. Android also
 *   raises `contextmenu` at the end of a touch hold; a hold that already fired
 *   ignores it, so the menu opens once.
 * - Fires `hapticMedium()` on the hold — the gesture commits a mode change, the
 *   menu items themselves keep their own tap haptics.
 */
export function useLongPress({
  onLongPress,
  delayMs = DEFAULT_DELAY_MS,
  moveSlopPx = DEFAULT_SLOP_PX,
  disabled = false
}: UseLongPressOptions): { bind: LongPressBind; cancel: () => void } {
  const onLongPressRef = useRef(onLongPress);
  onLongPressRef.current = onLongPress;

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startRef = useRef<{ x: number; y: number } | null>(null);
  const firedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const suppressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const detachWindowRef = useRef<(() => void) | null>(null);

  const cancel = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
    detachWindowRef.current?.();
    detachWindowRef.current = null;
  }, []);

  // `expectClick`: only a pointer hold can be followed by a browser-synthesized
  // click. A contextmenu or keyboard trigger has none, so arming the suppressor
  // there would swallow the user's next real tap (e.g. on the menu that just opened).
  const fire = useCallback(
    (expectClick: boolean) => {
      cancel();
      firedRef.current = true;
      if (expectClick) {
        suppressClickRef.current = true;
        if (suppressTimerRef.current !== null) clearTimeout(suppressTimerRef.current);
        suppressTimerRef.current = setTimeout(() => {
          suppressClickRef.current = false;
          suppressTimerRef.current = null;
        }, CLICK_SUPPRESS_FALLBACK_MS);
      }
      hapticMedium();
      onLongPressRef.current();
    },
    [cancel]
  );

  useEffect(
    () => () => {
      cancel();
      if (suppressTimerRef.current !== null) clearTimeout(suppressTimerRef.current);
    },
    [cancel]
  );

  const bind = useMemo<LongPressBind>(
    () => ({
      onPointerDown: event => {
        if (disabled || event.isPrimary === false) return;
        if (event.pointerType === 'mouse' && event.button !== 0) return;
        if (event.target instanceof Element && event.target.closest(`[${LONG_PRESS_IGNORE_ATTRIBUTE}]`)) return;
        cancel();
        firedRef.current = false;
        startRef.current = { x: event.clientX, y: event.clientY };
        // A scroll anywhere means the finger is moving the page, not holding the
        // row — even when the pointer itself reports no movement over the row.
        const onWindowScroll = () => cancel();
        window.addEventListener('scroll', onWindowScroll, { capture: true, passive: true });
        window.addEventListener('touchmove', onWindowScroll, { capture: true, passive: true });
        detachWindowRef.current = () => {
          window.removeEventListener('scroll', onWindowScroll, { capture: true });
          window.removeEventListener('touchmove', onWindowScroll, { capture: true });
        };
        timerRef.current = setTimeout(() => fire(true), delayMs);
      },
      onPointerMove: event => {
        const start = startRef.current;
        if (!start) return;
        if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > moveSlopPx) cancel();
      },
      onPointerUp: () => cancel(),
      onPointerCancel: () => cancel(),
      onPointerLeave: () => cancel(),
      onContextMenu: event => {
        if (disabled) return;
        event.preventDefault();
        if (firedRef.current) {
          // Android: the browser's own long-press contextmenu, for a hold we already handled.
          firedRef.current = false;
          return;
        }
        fire(false);
      },
      onClickCapture: event => {
        if (!suppressClickRef.current) return;
        // React bubbles portal events through the component tree, so a tap on a
        // menu rendered in a portal under this row arrives here too. Only a click
        // on the row's own DOM subtree is the synthesized one we mean to swallow.
        if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
        suppressClickRef.current = false;
        if (suppressTimerRef.current !== null) {
          clearTimeout(suppressTimerRef.current);
          suppressTimerRef.current = null;
        }
        event.preventDefault();
        event.stopPropagation();
      },
      onKeyDown: event => {
        if (disabled) return;
        const isMenuKey = event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
        if (!isMenuKey) return;
        event.preventDefault();
        fire(false);
      }
    }),
    [cancel, delayMs, disabled, fire, moveSlopPx]
  );

  return { bind, cancel };
}
