import { useEffect } from 'react';

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
 * Full-screen routes (Send, Receive, generating-transaction) already render
 * outside `TabLayout`, so there is no footer to match and this is a no-op
 * there. It matters when a success / progress surface is shown over a tab
 * page, which still mounts the footer behind it.
 */
let openCount = 0;

function applyHidden() {
  document.body.setAttribute('data-hide-navbar', '');
}

function applyVisible() {
  document.body.removeAttribute('data-hide-navbar');
}

export function useHideNavbarWhileOpen(open = true): void {
  useEffect(() => {
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
