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

import { type DappSession, createDappSession } from 'lib/dapp-browser';
import { isDesktop } from 'lib/platform';
import { useWalletStore } from 'lib/store';

import { DappActive } from './DappActive';
import { DappLauncher } from './DappLauncher';

const RECENT_URLS_LIMIT = 10;

export const BrowserScreen: FC = () => {
  const setActiveDappSession = useWalletStore(s => s.setActiveDappSession);
  const [session, setSession] = useState<DappSession | null>(null);
  const [recentUrls, setRecentUrls] = useState<string[]>([]);

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
      setRecentUrls(prev => {
        const filtered = prev.filter(u => u !== url);
        return [url, ...filtered].slice(0, RECENT_URLS_LIMIT);
      });
    },
    [setActiveDappSession]
  );

  const handleClose = useCallback(() => {
    setSession(null);
    setActiveDappSession(null);
  }, [setActiveDappSession]);

  if (session) {
    return <DappActive session={session} onClose={handleClose} />;
  }

  return <DappLauncher onOpen={handleOpen} recentUrls={recentUrls} />;
};
