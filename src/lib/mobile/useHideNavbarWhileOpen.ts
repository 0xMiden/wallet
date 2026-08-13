import { useLayoutEffect } from 'react';

/**
 * While `open` is true, hide the bottom tab navbar — the React `BottomNav`
 * rendered by `TabLayout` and tagged `data-tabbar-footer`. Reverses on
 * close / unmount.
 *
 * A single reference counter keeps concurrent callers honest: if a second
 * surface opens before the first closes, the navbar stays hidden until both
 * are gone. Pairs with the `body[data-hide-navbar] [data-tabbar-footer]`
 * rule in `main.css`.
 *
 * Full-screen routes also call this through `FullScreenPage`. Even though
 * their `TabLayout` has already unmounted, the body flag repaints the iOS
 * bottom safe-area strip where an overflowing footer shadow can otherwise
 * survive the route change.
 *
 * NOTE (#481): `data-hide-navbar` is ALSO read by `useNavbarHidden()` to lock
 * the home carousel's horizontal swipe while a focused sub-surface is up, so
 * raising this flag has a functional side effect beyond hiding the navbar. A new
 * home-carousel pane with an internal multi-step flow must raise this flag (or
 * keep the keyboard up) on its nested steps, or a horizontal swipe there can
 * drag an adjacent pane over the active step again.
 */
let openCount = 0;

function applyHidden() {
  document.body.setAttribute('data-hide-navbar', '');
}

function applyVisible() {
  document.body.removeAttribute('data-hide-navbar');
}

export function useHideNavbarWhileOpen(open = true): void {
  useLayoutEffect(() => {
    if (!open) return;

    openCount += 1;
    if (openCount === 1) {
      applyHidden();
    }

    return () => {
      openCount = Math.max(0, openCount - 1);
      if (openCount === 0) {
        applyVisible();
      }
    };
  }, [open]);
}
