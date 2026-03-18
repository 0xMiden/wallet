import { useEffect } from 'react';

import { isExtension } from 'lib/platform';
import { WalletMessageType, WalletStatus } from 'lib/shared/types';
import { getIntercom, useWalletStore } from 'lib/store';

const SYNC_INTERVAL_MS = 3_000;

/**
 * On extension only: sends SyncRequest to the service worker every 3s.
 *
 * The service worker runs syncState() on its warm WASM client and broadcasts
 * SyncCompleted with notes + balances data. The frontend reads from Zustand only.
 */
export function useSyncTrigger() {
  const status = useWalletStore(s => s.status);

  useEffect(() => {
    if (!isExtension()) return;
    if (status !== WalletStatus.Ready) return;

    const intercom = getIntercom();

    const timer = setInterval(() => {
      intercom.request({ type: WalletMessageType.SyncRequest }).catch(() => {});
    }, SYNC_INTERVAL_MS);

    // Fire immediately
    intercom.request({ type: WalletMessageType.SyncRequest }).catch(() => {});

    return () => clearInterval(timer);
  }, [status]);
}
