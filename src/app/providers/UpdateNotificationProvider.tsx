import React, { FC, PropsWithChildren, useCallback, useEffect, useRef, useState } from 'react';

import { useHideForegroundDappWhileOpen } from 'app/providers/DappBrowserProvider';
import { UpdateNotificationCard } from 'components/UpdateNotificationCard';
import { isUpdateNotificationsEnabled } from 'lib/feature-flags';
import { useMidenContext } from 'lib/miden/front';
import { useWalletStore } from 'lib/store';
import { createUpdateNotificationRuntime, type UpdateNotificationRuntime } from 'lib/update/runtime';
import type { UpdateNotice } from 'lib/update/types';
import { useLocation } from 'lib/woozie';

// These routes can be reached while a wallet is technically ready, but they
// belong to onboarding or destructive recovery rather than the normal shell.
const EXCLUDED_PATHS = new Set([
  '/finish-side-panel',
  '/forgot-password',
  '/forgot-password-info',
  '/reset-required',
  '/reset-wallet'
]);

export interface UpdateNotificationProviderProps extends PropsWithChildren {
  runtime?: UpdateNotificationRuntime;
}

export const UpdateNotificationProvider: FC<UpdateNotificationProviderProps> = ({ children, runtime }) => {
  const { ready, locked, hydrated } = useMidenContext();
  const { pathname } = useLocation();
  const needsHotKeyRotation = useWalletStore(s => Boolean(s.currentAccount?.requiresHotKeyRotation));
  const [notice, setNotice] = useState<UpdateNotice | null>(null);
  // Route changes may remount the effect, but one shell must keep one cache and
  // one platform adapter for its entire lifetime.
  const runtimePromise = useRef<Promise<UpdateNotificationRuntime>>();
  const enabled = isUpdateNotificationsEnabled();
  const normalSurface = ready && !locked && hydrated && !needsHotKeyRotation && !EXCLUDED_PATHS.has(pathname);
  useHideForegroundDappWhileOpen(normalSurface && notice !== null);

  const getRuntime = useCallback(() => {
    if (runtime) return Promise.resolve(runtime);
    runtimePromise.current ??= createUpdateNotificationRuntime();
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

    const refresh = async (force = false) => {
      const activeRuntime = await getRuntime();
      if (force) activeRuntime.controller.invalidate();
      const candidate = await activeRuntime.controller.check(force ? { force: true } : undefined);
      if (cancelled) return;
      if (!candidate || (await activeRuntime.dismissals.isDismissed(candidate.platform, candidate.availableVersion))) {
        setNotice(null);
        return;
      }
      if (!cancelled) setNotice(candidate);
    };

    void getRuntime().then(async activeRuntime => {
      if (cancelled) return;
      await refresh();
      if (cancelled) return;
      const cleanup = await activeRuntime.subscribe(() => void refresh(true));
      if (cancelled) cleanup();
      else unsubscribe = cleanup;
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [enabled, getRuntime, normalSurface]);

  const dismiss = useCallback(() => {
    if (!notice) return;
    const dismissed = notice;
    // Hide immediately for this session even if optional persistence fails.
    setNotice(null);
    void getRuntime().then(activeRuntime =>
      activeRuntime.dismissals.dismiss(dismissed.platform, dismissed.availableVersion).catch(() => undefined)
    );
  }, [getRuntime, notice]);

  return (
    <>
      {children}
      {normalSurface && notice && (
        <div className="pointer-events-none fixed inset-x-0 bottom-[calc(6rem+env(safe-area-inset-bottom))] z-[65] mx-auto w-full max-w-[430px] px-4">
          <UpdateNotificationCard notice={notice} onDismiss={dismiss} />
        </div>
      )}
    </>
  );
};
