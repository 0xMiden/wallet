/**
 * Top-level browser tab screen.
 *
 * After PR-3's `<DappBrowserProvider>` hoist, this component is a thin
 * consumer that:
 *  - Reads the active session and mode from `useDappBrowser()`
 *  - Renders `<DappLauncher>` when there's no foreground dApp (mode is
 *    `'launcher'`, OR mode is `'parked'` so the bubble shows over the
 *    launcher)
 *  - Renders `<DappActive>` when a dApp is foregrounded (mode `'active'`)
 *  - Tells the provider to open a new session when the user taps a tile
 *    or submits a URL
 *
 * The provider lives in `<TabLayout>` and survives tab navigation.
 *
 * The platform check is preserved from the legacy `Browser.tsx`: on
 * desktop (Tauri) we still hand off to the existing dapp-browser bridge
 * that opens a separate window.
 */

import React, { type FC, useCallback } from 'react';

import { LayoutGroup } from 'framer-motion';

import { useDappBrowser } from 'app/providers/DappBrowserProvider';
import { createDappSession, getDappDisplayName, recordRecentDapp } from 'lib/dapp-browser';
import { isDesktop } from 'lib/platform';

import { DappActive } from './DappActive';
import { DappLauncher } from './DappLauncher';

export const BrowserScreen: FC = () => {
  const { mode, open } = useDappBrowser();

  const handleOpen = useCallback(
    async (url: string) => {
      // Desktop (Tauri) keeps using the separate-window flow.
      if (isDesktop()) {
        try {
          const { openDappWindow } = await import('lib/desktop/dapp-browser');
          await openDappWindow(url);
        } catch (error) {
          console.error('[BrowserScreen] Error opening desktop dApp window:', error);
        }
        return;
      }

      // Mobile: build a session and hand it to the provider.
      const session = createDappSession(url);
      open(session);

      // Derive a readable display name from the URL hostname rather
      // than storing the raw origin/title. Previously the stored
      // `name` was the full `https://…` URL, which made the DappTile
      // fall back to 'H' as its avatar letter. The shared helper lives
      // in lib/dapp-browser so the bubble, switcher card, and capsule
      // all derive the same name from the same source of truth.
      const displayName = getDappDisplayName(session);

      recordRecentDapp({
        url,
        name: displayName,
        origin: session.origin,
        favicon: session.favicon
      }).catch(() => {});
    },
    [open]
  );

  // The shared LayoutGroup id ties the tile's `layoutId={`dapp-tile-${url}`}`
  // (and child favicon/name layoutIds) to the matching ones on `<CapsuleBar>`,
  // so opening a dApp from the launcher morphs the tile into the capsule.
  return (
    <LayoutGroup id="dapp-browser">
      {mode === 'active' ? <DappActive /> : <DappLauncher onOpen={handleOpen} />}
    </LayoutGroup>
  );
};
