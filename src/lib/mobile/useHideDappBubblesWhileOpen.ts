import { useEffect } from 'react';

import { isMobile } from 'lib/platform';

/**
 * While `open` is true on mobile, mark the body so parked dApp trays move
 * out of the way via main.css. A reference counter keeps concurrent modals
 * honest: if a second modal opens before the first closes, the body flag
 * stays set until both are gone.
 */
let openCount = 0;

function applyHidden() {
  document.body.setAttribute('data-drawer-open', '');
}

function applyVisible() {
  document.body.removeAttribute('data-drawer-open');
}

export function useHideDappBubblesWhileOpen(open: boolean): void {
  useEffect(() => {
    if (!isMobile() || !open) return;

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
