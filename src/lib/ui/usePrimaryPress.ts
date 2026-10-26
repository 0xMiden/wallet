import { type PointerEvent, useCallback, useMemo, useState } from 'react';

/** The first finger, the pen tip or the mouse: a second finger or a pen's barrel button is not. */
const fromPrimaryPointer = (event: PointerEvent) => event.isPrimary !== false;

/**
 * A manual press state, for a dip that framer's `whileTap` cannot drive (the pressed element is not
 * the one that moves, or a sibling must not start it). Like framer's tap, a press starts on the
 * primary pointer's main button and ends when that pointer lifts, cancels or leaves, whatever button
 * it releases with, so a right click or a second finger never starts or ends one. `release` lets the
 * host end a press itself: on blur, or when its page goes off screen.
 */
export function usePrimaryPress() {
  const [pressed, setPressed] = useState(false);
  const release = useCallback(() => setPressed(false), []);
  const handlers = useMemo(() => {
    const end = (event: PointerEvent) => {
      if (fromPrimaryPointer(event)) setPressed(false);
    };
    return {
      onPointerDown: (event: PointerEvent) => {
        if (event.button > 0 || !fromPrimaryPointer(event)) return;
        setPressed(true);
      },
      onPointerUp: end,
      onPointerCancel: end,
      onPointerLeave: end
    };
  }, []);
  return { pressed, release, handlers };
}
