/**
 * Top-level browser tab screen.
 *
 * After PR-3's `<DappBrowserProvider>` hoist, this component is a thin
 * consumer that:
 *  - Reads the active session and mode from `useDappBrowser()`
 *  - Renders `<DappLauncher>` when there's no foreground dApp (mode is
 *    `'launcher'`, OR mode is `'parked'` so the bubble shows over the
 *    launcher)
 *  - Renders `<DappActive>` when a dApp is foregrounded (mode `'active'`) and the page is on screen
 *  - Tells the provider to open a new session when the user taps an app
 *    or submits a URL
 *
 * The provider lives in `<TabLayout>` and survives tab navigation.
 *
 * The platform check is preserved from the legacy `Browser.tsx`: on
 * desktop (Tauri) we still hand off to the existing dapp-browser bridge
 * that opens a separate window.
 */

import React, { type FC, useCallback } from 'react';

import { usePageActive } from 'app/layouts/page-active';
import { useDappBrowser } from 'app/providers/DappBrowserProvider';
import { createDappSession, getDappDisplayName, recordRecentDapp } from 'lib/dapp-browser';
import { isDesktop } from 'lib/platform';

import { DappActive } from './DappActive';
import { DappLauncher } from './DappLauncher';
import { isSearchUrl } from './DappLauncher/search-url';

export const BrowserScreen: FC = () => {
  const { mode, open } = useDappBrowser();
  // A tab pane or page layer stays mounted off screen, but the dApp surface must not: its unmount clears the slot
  // rect, which is what parks the foreground dApp and hides its native window.
  const onScreen = usePageActive();

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

      // The session was just created, so its title is still its origin and
      // the shared helper returns the URL's hostname: a readable name, not
      // the raw `https://…` origin. The bubble, switcher card and capsule
      // derive their names from the same helper.
      const displayName = getDappDisplayName(session);

      // Recents is a list of dApps the user chose, so a web search this app produced is not one -
      // the other writer, DappActionsSheet's My-dApps toggle, holds the same rule.
      if (isSearchUrl(url)) return;

      recordRecentDapp({
        url,
        name: displayName,
        origin: session.origin,
        favicon: session.favicon ?? undefined
      }).catch(() => {});
    },
    [open]
  );

  if (mode === 'active') return onScreen ? <DappActive /> : null;
  return <DappLauncher onOpen={handleOpen} />;
};
