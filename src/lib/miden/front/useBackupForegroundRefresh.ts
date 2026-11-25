import { useEffect } from 'react';

import { selectIsReady, useWalletStore } from 'lib/store';

/** Two foreground events closer than this are one: an iOS resume raises `visibilitychange` twice. */
const FOREGROUND_COALESCE_MS = 500;

/**
 * Ask the backend for an encrypted-backup refresh when the wallet comes to the
 * foreground (architecture doc 7.3): one conditional `GET /v1/storage`, then
 * each changed feature. On every platform the document's `visibilitychange`
 * is the foreground signal: a mobile resume raises it with the native
 * `appStateChange`, a desktop window raises it when it is shown again, and the
 * extension popup raises it when it is focused again while open. A popup that
 * opens anew turns Ready instead, which the store refreshes as `unlock`.
 *
 * The refresh is a no-op in the backend while the backup is off, so this hook
 * needs no gate of its own beyond Ready. Nothing here throws.
 */
export function useBackupForegroundRefresh(): void {
  const ready = useWalletStore(selectIsReady);
  const refreshBackup = useWalletStore(s => s.refreshBackup);

  useEffect(() => {
    if (!ready) return;
    let lastForegroundAt = 0;
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      const now = Date.now();
      if (now - lastForegroundAt < FOREGROUND_COALESCE_MS) return;
      lastForegroundAt = now;
      refreshBackup('foreground').catch(error =>
        console.warn('[useBackupForegroundRefresh] the backup refresh failed:', error)
      );
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [ready, refreshBackup]);
}
