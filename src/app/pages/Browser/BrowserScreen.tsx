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
 *
 * The extension has no embedded browser and no provider: it shows the same
 * launcher and opens every pick in a new browser tab.
 */

import React, { type FC, useCallback, useLayoutEffect, useRef } from 'react';

import { openUrlInNewTab } from 'app/env';
import { PageActiveContext, usePageActive } from 'app/layouts/page-active';
import { useDappBrowser } from 'app/providers/DappBrowserProvider';
import { createDappSession, getDappDisplayName, parseOrigin, recordRecentDapp } from 'lib/dapp-browser';
import { isDesktop, isExtension } from 'lib/platform';

import { DappActive } from './DappActive';
import { DappLauncher } from './DappLauncher';
import { isSearchUrl } from './DappLauncher/search-url';

/**
 * Recents is a list of dApps the user chose, so a web search this app produced is not one - the
 * other writer, DappActionsSheet's My-dApps toggle, holds the same rule. A page just opened has no
 * title yet, so the shared helper names it by the URL's hostname: a readable name, not the raw
 * `https://…` origin, and the one the bubble, switcher card and capsule derive too.
 */
function recordOpenedDapp(url: string): Promise<void> {
  if (isSearchUrl(url)) return Promise.resolve();
  return recordRecentDapp({ url, name: getDappDisplayName({ url }), origin: parseOrigin(url) }).catch(() => {});
}

const EmbeddedBrowserScreen: FC = () => {
  const { mode, open, reportLauncherCommit } = useDappBrowser();
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
      open(createDappSession(url));
      void recordOpenedDapp(url);
    },
    [open]
  );

  const launcherVisible = mode !== 'active';
  const launcher = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = launcher.current;
    if (!element) return;
    element.inert = !launcherVisible || !onScreen;
    if ((!launcherVisible || !onScreen) && element.contains(document.activeElement)) {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }
  }, [launcherVisible, onScreen]);
  useLayoutEffect(() => {
    reportLauncherCommit?.(launcherVisible && onScreen);
    return () => reportLauncherCommit?.(false);
  });

  return (
    <>
      <div
        ref={launcher}
        hidden={!launcherVisible}
        aria-hidden={!launcherVisible || !onScreen}
        className={launcherVisible ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
      >
        <PageActiveContext.Provider value={launcherVisible && onScreen}>
          <DappLauncher onOpen={handleOpen} />
        </PageActiveContext.Provider>
      </div>
      {mode === 'active' && onScreen && <DappActive />}
    </>
  );
};

const ExtensionBrowserScreen: FC = () => {
  const handleOpen = useCallback(async (url: string) => {
    // Recorded before the tab opens: the new tab takes focus, which closes the popup and ends this script.
    await recordOpenedDapp(url);
    try {
      await openUrlInNewTab(url);
    } catch (error) {
      console.error('[BrowserScreen] Error opening a dApp tab:', error);
    }
  }, []);

  return <DappLauncher onOpen={handleOpen} />;
};

export const BrowserScreen: FC = () => (isExtension() ? <ExtensionBrowserScreen /> : <EmbeddedBrowserScreen />);
