import { useEffect } from 'react';

import { popOverlay, pushOverlay } from './screen-key';

/**
 * Publishes `overlayId` onto the screen-key overlay stack for as long as
 * `open` is true, and removes it again on close or unmount. Gated on
 * `MIDEN_E2E_TEST` so it's a complete no-op in production.
 *
 * Shared by every overlay primitive (`Drawer`, `CustomModal`, the
 * alert/confirm dialogs) so the guard + push/pop lifecycle is written and
 * unit-tested exactly once instead of duplicated per call site.
 */
export function useOverlayScreenKey(open: boolean, overlayId: string): void {
  useEffect(() => {
    if (process.env.MIDEN_E2E_TEST !== 'true') return;
    if (!open) return;
    pushOverlay(overlayId);
    return () => popOverlay(overlayId);
  }, [open, overlayId]);
}
