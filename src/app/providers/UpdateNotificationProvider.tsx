import React, { FC, PropsWithChildren, useCallback, useEffect, useRef, useState } from 'react';

import { useForegroundDappActive } from 'app/providers/DappBrowserProvider';
import { UpdateNotificationCard } from 'components/UpdateNotificationCard';
import { isUpdateNotificationsEnabled } from 'lib/feature-flags';
import { useMidenContext } from 'lib/miden/front';
import { useWalletStore } from 'lib/store';
import { createUpdateNotificationRuntime, type UpdateNotificationRuntime } from 'lib/update/runtime';
import type { UpdateNotice, UpdateRefreshReason } from 'lib/update/types';
import { useLocation } from 'lib/woozie';

// These routes can be reached while a wallet is technically ready, but they
// belong to onboarding or destructive recovery rather than the normal shell.
// `/help-improve-wallet` is the last onboarding screen: the wallet is already
// Ready there, and the update card would cover its buttons.
const EXCLUDED_PATHS = new Set([
  '/finish-side-panel',
  '/forgot-password',
  '/forgot-password-info',
  '/help-improve-wallet',
  '/reset-required',
  '/reset-wallet'
]);

export interface UpdateNotificationProviderProps extends PropsWithChildren {
  runtime?: UpdateNotificationRuntime;
}

const dismissalKey = (notice: UpdateNotice) => `${notice.platform}@${notice.availableVersion}`;

export const UpdateNotificationProvider: FC<UpdateNotificationProviderProps> = ({ children, runtime }) => {
  const { ready, locked, hydrated } = useMidenContext();
  const { pathname } = useLocation();
  const needsHotKeyRotation = useWalletStore(s => Boolean(s.currentAccount?.requiresHotKeyRotation));
  const [notice, setNotice] = useState<UpdateNotice | null>(null);
  // A dismissal has to win over a check that is already past its own dismissal
  // read, which would otherwise re-render the card the user just closed.
  const dismissedVersions = useRef(new Set<string>());
  // Route changes may remount the effect, but one shell must keep one cache and
  // one platform adapter for its entire lifetime.
  const runtimePromise = useRef<Promise<UpdateNotificationRuntime>>();
  const enabled = isUpdateNotificationsEnabled();
  const normalSurface = ready && !locked && hydrated && !needsHotKeyRotation && !EXCLUDED_PATHS.has(pathname);
  // A foregrounded dApp owns the screen through a native window above this one.
  // The card waits for the dApp to be parked or closed instead of hiding it.
  const dappForeground = useForegroundDappActive();
  const showCard = normalSurface && notice !== null && !dappForeground;

  const getRuntime = useCallback(() => {
    if (runtime) return Promise.resolve(runtime);
    // A failed construction must not be remembered, or this shell never checks
    // again; the next normal surface builds a fresh runtime.
    runtimePromise.current ??= createUpdateNotificationRuntime().catch(error => {
      runtimePromise.current = undefined;
      throw error;
    });
    return runtimePromise.current;
  }, [runtime]);

  useEffect(() => {
    if (!enabled || !normalSurface) {
      setNotice(null);
      return;
    }

    // Platform checks outlive route transitions, especially native network
    // calls. A stale result must not paint over onboarding or a rotation gate.
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    // Two foregrounds can overlap, and their platform calls can settle in either
    // order; only the newest refresh may write what the user sees.
    let latestRefresh = 0;

    const refresh = async (reason: UpdateRefreshReason | 'initial') => {
      const id = ++latestRefresh;
      const activeRuntime = await getRuntime();
      const result = await activeRuntime.controller.check(reason === 'platform' ? { force: true } : undefined);
      if (cancelled || id !== latestRefresh) return;
      // `unknown` is the platform failing to answer, not the absence of an
      // update: a card it already confirmed stays until an answer arrives.
      if (result.status === 'unknown') return;
      if (result.status === 'none') {
        setNotice(null);
        return;
      }
      const dismissed = await activeRuntime.dismissals.isDismissed(
        result.notice.platform,
        result.notice.availableVersion
      );
      if (cancelled || id !== latestRefresh) return;
      const hidden = dismissed || dismissedVersions.current.has(dismissalKey(result.notice));
      setNotice(hidden ? null : result.notice);
    };

    void (async () => {
      try {
        const activeRuntime = await getRuntime();
        if (cancelled) return;
        // Subscribe before the first check: a service-worker update message that
        // arrives while it runs would otherwise reach no listener.
        const cleanup = await activeRuntime.subscribe(reason => void refresh(reason).catch(() => undefined));
        if (cancelled) cleanup();
        else unsubscribe = cleanup;
        await refresh('initial');
      } catch (error) {
        // Storage, platform or construction failure: the notice stays as it is
        // and the next normal surface entry retries. Every other failure in this
        // feature is indistinguishable from "no update", so the one that threw
        // says so once.
        console.warn('[UpdateNotification] update check could not run:', error);
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [enabled, getRuntime, normalSurface]);

  const dismiss = useCallback(() => {
    if (!notice) return;
    const dismissed = notice;
    // Hide immediately for this session even if optional persistence fails, and
    // before any in-flight check can read storage that has not been written yet.
    dismissedVersions.current.add(dismissalKey(dismissed));
    setNotice(null);
    void getRuntime().then(activeRuntime =>
      activeRuntime.dismissals.dismiss(dismissed.platform, dismissed.availableVersion).catch(() => undefined)
    );
  }, [getRuntime, notice]);

  return (
    <>
      {children}
      {showCard && notice && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(6rem+env(safe-area-inset-bottom))] z-[65] mx-auto w-full max-w-[430px] px-4">
          <UpdateNotificationCard notice={notice} onDismiss={dismiss} />
        </div>
      )}
    </>
  );
};
