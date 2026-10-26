import { useEffect, useState, useSyncExternalStore } from 'react';

import { deriveGuardianPresentation, type GuardianPresentation } from 'lib/miden/front/guardian-presentation';
import {
  getGuardianLastSyncAt,
  isGuardianLastSyncFresh,
  isGuardianSyncOutage,
  isGuardianUnrepairable,
  subscribeGuardianSyncOutage
} from 'lib/miden/front/guardian-sync';
import { useWalletStore } from 'lib/store';

/**
 * The one wiring of `deriveGuardianPresentation` to the realm's inputs, so every
 * status surface agrees on the account, the stores, and when freshness expires.
 */
export function useGuardianPresentation(): GuardianPresentation {
  // Primitives rather than the account: every backend push replaces the account
  // object, and an unrelated field must not re-render the status.
  const pk = useWalletStore(s => s.currentAccount?.publicKey);
  const hotPublicKey = useWalletStore(s => s.currentAccount?.hotPublicKey);
  const guardianSyncStatus = useWalletStore(s => s.currentAccount?.guardianSyncStatus);

  const outage = useSyncExternalStore(subscribeGuardianSyncOutage, () => (pk ? isGuardianSyncOutage(pk) : false));
  const unrepairable = useSyncExternalStore(subscribeGuardianSyncOutage, () =>
    pk ? isGuardianUnrepairable(pk) : false
  );
  const lastSyncAt = useSyncExternalStore(subscribeGuardianSyncOutage, () =>
    pk ? getGuardianLastSyncAt(pk) : undefined
  );

  // Freshness decays with wall-clock time, which no subscription announces -
  // re-derive on a coarse tick so 'online' cannot outlive the stamp (F-149).
  const [, setClockTick] = useState(0);
  useEffect(() => {
    if (!pk) return;
    const timer = setInterval(() => setClockTick(tick => tick + 1), 15_000);
    return () => clearInterval(timer);
  }, [pk]);

  return deriveGuardianPresentation({
    account: { hotPublicKey, guardianSyncStatus },
    outage,
    unrepairable,
    lastSyncAt,
    lastSyncFresh: pk ? isGuardianLastSyncFresh(pk) : false
  });
}
