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
 * The one wiring of `deriveGuardianPresentation` to the realm's inputs. Every
 * surface that says anything about the current account's guardian — the
 * settings pill, the connectivity banner's guardian slot, the needs-URL
 * banner's gate — consumes this hook, so they cannot disagree about which
 * account, which stores, or when freshness expires.
 */
export function useGuardianPresentation(): GuardianPresentation {
  const account = useWalletStore(s => s.currentAccount);
  const pk = account?.publicKey;

  const outage = useSyncExternalStore(subscribeGuardianSyncOutage, () => (pk ? isGuardianSyncOutage(pk) : false));
  const unrepairable = useSyncExternalStore(subscribeGuardianSyncOutage, () =>
    pk ? isGuardianUnrepairable(pk) : false
  );
  const lastSyncAt = useSyncExternalStore(subscribeGuardianSyncOutage, () =>
    pk ? getGuardianLastSyncAt(pk) : undefined
  );

  // Freshness decays with wall-clock time, which no subscription announces —
  // re-derive on a coarse tick so 'online' cannot outlive the stamp (F-149).
  const [, setClockTick] = useState(0);
  useEffect(() => {
    if (!pk) return;
    const timer = setInterval(() => setClockTick(tick => tick + 1), 15_000);
    return () => clearInterval(timer);
  }, [pk]);

  return deriveGuardianPresentation({
    account: { hotPublicKey: account?.hotPublicKey, guardianSyncStatus: account?.guardianSyncStatus },
    outage,
    unrepairable,
    lastSyncAt,
    lastSyncFresh: pk ? isGuardianLastSyncFresh(pk) : false
  });
}
