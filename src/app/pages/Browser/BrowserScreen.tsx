/**
 * Top-level browser tab screen.
 *
 * State machine:
 *   no active session -> <DappLauncher/>
 *   active session    -> <DappActive session={...}/>
 *
 * In PR-1 there's exactly one active session at a time. PR-3 hoists the
 * session ownership to a `DappBrowserProvider` mounted at app root, so
 * sessions survive tab navigation. For PR-1 the session lives in this
 * component's local state, which is sufficient because the user must be
 * on `/browser` to interact with a dApp at all.
 *
 * The platform check is preserved from the legacy `Browser.tsx`: on desktop
 * (Tauri) we still hand off to the existing dapp-browser bridge that opens
 * a separate window. PR-1 only changes mobile behavior.
 */

import React, { type FC, useCallback, useState } from 'react';

import { LayoutGroup } from 'framer-motion';

import { type DappSession, createDappSession, recordRecentDapp } from 'lib/dapp-browser';
import { isDesktop } from 'lib/platform';
import { useWalletStore } from 'lib/store';

import { DappActive } from './DappActive';
import { DappLauncher } from './DappLauncher';

export const BrowserScreen: FC = () => {
  const setActiveDappSession = useWalletStore(s => s.setActiveDappSession);
  const [session, setSession] = useState<DappSession | null>(null);

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

      // Mobile: create a session and let <DappActive> open the native webview.
      const next = createDappSession(url);
      setSession(next);
      setActiveDappSession(next.id);

      // Record into recents storage so the launcher's MyDappsGrid shows it
      // next time. The session's title gets updated by useDappWebView once
      // browserPageLoaded fires; for the recents entry we save a best-effort
      // initial name based on the origin.
      recordRecentDapp({
        url,
        name: next.title || next.origin.replace(/^https?:\/\//, ''),
        origin: next.origin,
        favicon: next.favicon
      }).catch(() => {});
    },
    [setActiveDappSession]
  );

  const handleClose = useCallback(() => {
    setSession(null);
    setActiveDappSession(null);
  }, [setActiveDappSession]);

  // The shared LayoutGroup id ties the tile's `layoutId={`dapp-tile-${url}`}`
  // (and child favicon/name layoutIds) to the matching ones on `<CapsuleBar>`,
  // so opening a dApp from the launcher morphs the tile into the capsule.
  return (
    <LayoutGroup id="dapp-browser">
      {session ? <DappActive session={session} onClose={handleClose} /> : <DappLauncher onOpen={handleOpen} />}
    </LayoutGroup>
  );
};
