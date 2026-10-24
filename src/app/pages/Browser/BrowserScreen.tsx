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

import React, { type FC, useCallback, useEffect, useLayoutEffect, useRef } from 'react';

import { useReducedMotion } from 'framer-motion';

import { openUrlInNewTab } from 'app/env';
import { PageActiveContext, usePageActive } from 'app/layouts/page-active';
import { useDappBrowser } from 'app/providers/DappBrowserProvider';
import { createDappSession } from 'lib/dapp-browser';
import type { ExploreFilter } from 'lib/dapp-browser/explore-catalog';
import { isDesktop, isExtension } from 'lib/platform';

import { DappActive } from './DappActive';
import { DappLauncher } from './DappLauncher';
import { startMorphCompanions } from './morph-companions';
import { recordOpenedDapp } from './record-opened-dapp';

export interface BrowserScreenProps {
  requestedFilter?: ExploreFilter;
  entryIntent?: number;
  onChooseFilter?: (filter: ExploreFilter) => void;
}

const EmbeddedBrowserScreen: FC<BrowserScreenProps> = props => {
  const { mode, open, reportLauncherCommit, policyPending, presentation, motion, session } = useDappBrowser();
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

  const launcherVisible = mode !== 'active' || policyPending || presentation === 'fullscreen';
  // While the foreground page moves between the slot and its card (#1817), the launcher it uncovers is drawn behind
  // it, inert until a collapse commits; an expand hides it again once it settles.
  const launcherBehind = !launcherVisible && motion !== null && motion.id === session?.id;
  const launcher = useRef<HTMLDivElement>(null);
  const capsule = useRef<HTMLElement>(null);
  const reduceMotion = useReducedMotion() === true;
  const motionRef = useRef(motion);
  motionRef.current = motion;
  const stopCompanions = useRef<(() => void) | null>(null);
  // Every started or retargeted event restarts the capsule and launcher from where they are, before the frame paints;
  // the motion's end (or a settled collapse) returns them to their own styles. A held page moves with the finger, so
  // they wait for its release.
  const companionKey =
    launcherBehind && motion.started && !motion.acknowledging ? `${motion.morphId}:${motion.eventSeq}` : null;
  useLayoutEffect(() => {
    const current = motionRef.current;
    if (companionKey === null || !current) {
      stopCompanions.current?.();
      stopCompanions.current = null;
      return;
    }
    if (current.tracking) return;
    stopCompanions.current = startMorphCompanions(
      { capsule: capsule.current, launcher: launcher.current },
      current,
      reduceMotion
    );
  }, [companionKey, reduceMotion]);
  useEffect(() => () => stopCompanions.current?.(), []);
  useLayoutEffect(() => {
    const element = launcher.current;
    if (!element) return;
    element.inert = !launcherVisible || !onScreen;
    if ((!launcherVisible || !onScreen) && element.contains(document.activeElement)) {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }
  }, [launcherVisible, onScreen]);
  useLayoutEffect(() => {
    reportLauncherCommit?.(mode !== 'active' && onScreen);
    return () => reportLauncherCommit?.(false);
  });

  return (
    <>
      <div
        ref={launcher}
        hidden={!launcherVisible && !launcherBehind}
        aria-hidden={!launcherVisible || !onScreen}
        className={
          launcherVisible
            ? 'flex min-h-0 flex-1 flex-col'
            : launcherBehind
              ? 'absolute inset-0 flex flex-col'
              : 'hidden'
        }
        // A collapse uncovers the launcher only as the page shrinks; until its first event it stays clear.
        style={launcherBehind && motion.target === 'collapsed' && !motion.started ? { opacity: 0 } : undefined}
      >
        <PageActiveContext.Provider value={launcherVisible && onScreen}>
          <DappLauncher {...props} onOpen={handleOpen} />
        </PageActiveContext.Provider>
      </div>
      {mode === 'active' && onScreen && <DappActive capsuleRef={capsule} />}
    </>
  );
};

const ExtensionBrowserScreen: FC<BrowserScreenProps> = props => {
  const handleOpen = useCallback(async (url: string) => {
    // Recorded before the tab opens: the new tab takes focus, which closes the popup and ends this script.
    await recordOpenedDapp(url);
    try {
      await openUrlInNewTab(url);
    } catch (error) {
      console.error('[BrowserScreen] Error opening a dApp tab:', error);
    }
  }, []);

  return <DappLauncher {...props} onOpen={handleOpen} />;
};

export const BrowserScreen: FC<BrowserScreenProps> = props =>
  isExtension() ? <ExtensionBrowserScreen {...props} /> : <EmbeddedBrowserScreen {...props} />;
