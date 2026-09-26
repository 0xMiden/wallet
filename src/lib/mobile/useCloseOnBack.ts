import { useRef } from 'react';

import { useMobileBackHandler } from './useMobileBackHandler';

/**
 * Mobile back closes a sheet or popover that closes itself, before anything underneath handles the
 * press. It registers in the overlay tier, so a page handler that re-registers while it is open
 * cannot take the press; while closed it passes the press on. `close` is read at press time, so a
 * new callback identity does not register again. A sheet its host closes does not use this: the
 * host's page handler closes it.
 */
export function useCloseOnBack(open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useMobileBackHandler(
    () => {
      if (!open) return false;
      closeRef.current();
      return true;
    },
    [open],
    { overlay: true }
  );
}
