import { useEffect } from 'react';

import { isExtension } from 'lib/platform';
import { WalletMessageType, WalletStatus } from 'lib/shared/types';
import { getIntercom, useWalletStore } from 'lib/store';

const SYNC_INTERVAL_MS = 3_000;

/**
 * On extension only: sends SyncRequest to the service worker every 3s.
 * Replaces AutoSync's setInterval for the extension platform.
 * The service worker runs doSync() asynchronously and returns SyncResponse immediately.
 *
 * Note: the frontend WASM client warmup sync is done inside useClaimableNotes'
 * fetcher (not here) to guarantee it completes before the first getConsumableNotes() call.
 */
export function useSyncTrigger() {
  const status = useWalletStore(s => s.status);

  useEffect(() => {
    if (!isExtension()) return;
    if (status !== WalletStatus.Ready) return;

    const intercom = getIntercom();

    const timer = setInterval(() => {
      intercom.request({ type: WalletMessageType.SyncRequest }).catch(() => {
        // Service worker may be restarting — next tick will retry
      });
    }, SYNC_INTERVAL_MS);

    // Fire one immediately
    intercom.request({ type: WalletMessageType.SyncRequest }).catch(() => {});

    return () => clearInterval(timer);
  }, [status]);
}
