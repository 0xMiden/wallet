import { useCallback, useEffect, useRef, useState } from 'react';

import type { ArcadeAccountScope, WeeklyClaimService, WeeklyClaimSnapshot } from './weekly-claim';

const unread: WeeklyClaimSnapshot = { status: { kind: 'unavailable' }, balance: null };

/** Key the owning component by account/network to isolate in-flight results when the user switches. */
export function useWeeklyClaim(scope: ArcadeAccountScope, service: WeeklyClaimService) {
  const [snapshot, setSnapshot] = useState(unread);
  const [busy, setBusy] = useState(true);
  const lock = useRef(false);
  const mounted = useRef(false);
  const uncertain = useRef(false);
  const { accountId, networkId } = scope;

  const refresh = useCallback(async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    try {
      const result = await service.read({ accountId, networkId });
      if (mounted.current) {
        // An unavailable read cannot clear an uncertain submission and enable a new write.
        setSnapshot(
          uncertain.current && result.status.kind === 'unavailable'
            ? { status: { kind: 'pending' }, balance: null }
            : result
        );
        if (result.status.kind !== 'unavailable') uncertain.current = result.status.kind === 'pending';
      }
    } catch {
      if (mounted.current)
        setSnapshot({ status: { kind: uncertain.current ? 'pending' : 'unavailable' }, balance: null });
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [accountId, networkId, service]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  const claim = async () => {
    if (lock.current || (snapshot.status.kind !== 'eligible' && snapshot.status.kind !== 'failed')) return;
    lock.current = true;
    uncertain.current = true;
    setBusy(true);
    setSnapshot(previous => ({ ...previous, status: { kind: 'pending' } }));
    try {
      const result = await service.submit({ accountId, networkId });
      if (mounted.current) {
        if (result.status.kind === 'unavailable' || result.status.kind === 'eligible') {
          setSnapshot({ status: { kind: 'pending' }, balance: null });
        } else {
          uncertain.current = result.status.kind === 'pending';
          setSnapshot(result);
        }
      }
    } catch {
      // Lost responses may have minted. Reconcile; do not offer another submit.
      if (mounted.current) setSnapshot({ status: { kind: 'pending' }, balance: null });
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return { snapshot, busy, claim, refresh };
}
