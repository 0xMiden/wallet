import { useEffect } from 'react';

import { isExtension } from 'lib/platform';
import { WalletMessageType, WalletStatus } from 'lib/shared/types';
import { getIntercom, useWalletStore } from 'lib/store';
import { WalletType } from 'screens/onboarding/types';

import { syncPsmAccounts } from './psm-manager';

const SYNC_INTERVAL_MS = 3_000;

function triggerSync(intercom: ReturnType<typeof getIntercom>) {
  intercom
    .request({ type: WalletMessageType.SyncRequest })
    .then(() => {
      // PSM sync runs in the frontend where the wallet is unlocked and signWord is available
      const psmAccountKeys = useWalletStore
        .getState()
        .accounts.filter(acc => acc.type === WalletType.Psm)
        .map(acc => acc.publicKey);
      if (psmAccountKeys.length > 0) {
        syncPsmAccounts().catch(() => {});
      }
    })
    .catch(() => {});
}

/**
 * On extension only: sends SyncRequest to the service worker every 3s.
 *
 * The service worker runs syncState() on its warm WASM client and broadcasts
 * SyncCompleted with notes + balances data. The frontend reads from Zustand only.
 * After each chain sync, PSM accounts are synced in the frontend context.
 */
export function useSyncTrigger() {
  const status = useWalletStore(s => s.status);

  useEffect(() => {
    if (!isExtension()) return;
    if (status !== WalletStatus.Ready) return;

    const intercom = getIntercom();

    const timer = setInterval(() => {
      triggerSync(intercom);
    }, SYNC_INTERVAL_MS);

    // Fire immediately
    triggerSync(intercom);

    return () => clearInterval(timer);
  }, [status]);
}
