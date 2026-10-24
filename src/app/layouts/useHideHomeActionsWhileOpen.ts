import { useLayoutEffect } from 'react';

import { usePageActive } from './page-active';

let openCount = 0;

/** Nested home flows own their header once they leave the entry step. Retained inactive pages release it. */
export function useHideHomeActionsWhileOpen(open: boolean): void {
  const active = usePageActive();
  useLayoutEffect(() => {
    if (!open || !active) return;
    openCount += 1;
    document.body.setAttribute('data-hide-home-actions', '');
    return () => {
      openCount -= 1;
      if (openCount === 0) document.body.removeAttribute('data-hide-home-actions');
    };
  }, [open, active]);
}
