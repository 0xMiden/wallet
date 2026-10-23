import { useCallback, useEffect, useRef, useState } from 'react';

import type { ArcadeAccountScope, WeeklyClaimReview, WeeklyClaimService, WeeklyClaimSnapshot } from './weekly-claim';

function canonicalWeek(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const date = new Date(value);
  if (
    !Number.isFinite(date.getTime()) ||
    date.getUTCDay() !== 1 ||
    date.getUTCHours() !== 0 ||
    date.getUTCMinutes() !== 0 ||
    date.getUTCSeconds() !== 0 ||
    date.getUTCMilliseconds() !== 0
  )
    return undefined;
  return date.toISOString();
}

const unread: WeeklyClaimSnapshot = { status: { kind: 'unavailable' }, balance: null };
const cannotResolveSubmission = (result: WeeklyClaimSnapshot) =>
  result.status.kind === 'unavailable' || result.status.kind === 'checking' || result.status.kind === 'eligible';

/** Key the owning component by account/network to isolate in-flight results when the user switches. */
export function useWeeklyClaim(scope: ArcadeAccountScope, service: WeeklyClaimService, active = true) {
  const [snapshot, setSnapshot] = useState(unread);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [review, setReview] = useState<WeeklyClaimReview | null>(null);
  const reviewRef = useRef<WeeklyClaimReview | null>(null);
  const reviewOperation = useRef<string>();
  const pendingRecoveries = useRef(new Set<string>());
  const lock = useRef(false);
  const mounted = useRef(false);
  const uncertain = useRef(false);
  const uncertainWeek = useRef<string>();
  const { accountId, networkId } = scope;

  const cancelReview = useCallback(() => {
    reviewRef.current = null;
    reviewOperation.current = undefined;
    setReview(null);
    setError(null);
  }, []);

  const refresh = useCallback(async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    cancelReview();
    try {
      const result = await service.read({ accountId, networkId });
      if (mounted.current) {
        for (const recovery of [...(result.recoveries ?? []), ...(result.receipts ?? [])])
          pendingRecoveries.current.delete(recovery.operationId);
        // Only an authoritative terminal verdict can release an uncertain submit. Eligibility
        // alone cannot prove that a previously funded request will never arrive.
        const week = canonicalWeek(result.allocationWeekStart);
        const newerWeek = week !== undefined && uncertainWeek.current !== undefined && week > uncertainWeek.current;
        if (uncertain.current && cannotResolveSubmission(result) && !newerWeek) {
          setSnapshot({
            status: { kind: 'pending' },
            balance: null,
            ...(result.recoveries ? { recoveries: result.recoveries } : {}),
            ...(result.receipts ? { receipts: result.receipts } : {})
          });
        } else {
          uncertain.current = result.status.kind === 'pending';
          if (week !== undefined) uncertainWeek.current = week;
          setSnapshot(previous =>
            result.status.kind === 'unavailable' && previous.pendingOperations
              ? { ...result, pendingOperations: true }
              : result
          );
        }
      }
    } catch {
      if (mounted.current)
        setSnapshot(previous => ({
          status: { kind: uncertain.current ? 'pending' : 'unavailable' },
          balance: null,
          ...(previous.pendingOperations ? { pendingOperations: true } : {})
        }));
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [accountId, networkId, service, cancelReview]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    // History pagination is a read, not evidence of an in-flight submission. Keep advancing
    // it without requiring repeated taps, and stop polling when a review is open.
    if (
      !active ||
      busy ||
      review ||
      (!snapshot.pendingOperations && !['checking', 'pending'].includes(snapshot.status.kind))
    )
      return;
    const timer = setTimeout(() => void refresh(), snapshot.status.kind === 'checking' ? 250 : 5000);
    return () => clearTimeout(timer);
  }, [active, busy, review, snapshot, refresh]);

  const prepareReview = async (operationId?: string) => {
    const recoveryAvailable =
      operationId !== undefined &&
      [...(snapshot.recoveries ?? []), ...(snapshot.receipts ?? [])].some(item => item.operationId === operationId) &&
      !pendingRecoveries.current.has(operationId);
    if (lock.current || reviewRef.current !== null) return;
    if (
      operationId !== undefined
        ? !recoveryAvailable
        : uncertain.current || !['eligible', 'failed', 'reclaimable', 'receivable'].includes(snapshot.status.kind)
    )
      return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const quote = operationId
        ? await service.prepare({ accountId, networkId }, operationId)
        : await service.prepare({ accountId, networkId });
      if (operationId && quote.mode !== 'reclaim' && quote.mode !== 'receive')
        throw new Error('Recovery quote unavailable');
      if (mounted.current) {
        reviewRef.current = quote;
        reviewOperation.current = operationId;
        setReview(quote);
      }
    } catch {
      // Preparation cannot submit funds: a failed read/quote does not create uncertainty.
      if (mounted.current) setError('arcadeClaimPreparationFailed');
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const claim = () => prepareReview();
  const recover = (operationId: string) => prepareReview(operationId);

  const confirmReview = async () => {
    const quote = reviewRef.current;
    if (lock.current || quote === null) return;
    const operationId = reviewOperation.current;
    cancelReview();
    const expiry = Date.parse(quote.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) {
      setError('arcadeClaimReviewExpired');
      return;
    }
    if (operationId !== undefined && (quote.mode === 'reclaim' || quote.mode === 'receive')) {
      const inventory = quote.mode === 'receive' ? 'receipts' : 'recoveries';
      lock.current = true;
      pendingRecoveries.current.add(operationId);
      setBusy(true);
      setSnapshot(previous => ({
        ...previous,
        [inventory]: previous[inventory]?.filter(item => item.operationId !== operationId)
      }));
      try {
        const result = await service.submit({ accountId, networkId }, quote.quoteId);
        if (
          mounted.current &&
          result.status.kind === 'failed' &&
          canonicalWeek(result.allocationWeekStart) === canonicalWeek(quote.allocationWeekStart)
        ) {
          pendingRecoveries.current.delete(operationId);
          setError('arcadeClaimPreparationFailed');
          setSnapshot(previous => ({
            ...previous,
            [inventory]: [
              ...(previous[inventory] ?? []).filter(item => item.operationId !== operationId),
              { operationId, allocationWeekStart: quote.allocationWeekStart }
            ]
          }));
        } else if (mounted.current && result.status.kind !== 'unavailable') {
          for (const item of [...(result.recoveries ?? []), ...(result.receipts ?? [])])
            pendingRecoveries.current.delete(item.operationId);
          const week = canonicalWeek(result.allocationWeekStart);
          const newerWeek = week !== undefined && uncertainWeek.current !== undefined && week > uncertainWeek.current;
          if (uncertain.current && cannotResolveSubmission(result) && !newerWeek) {
            setSnapshot(previous => ({
              ...previous,
              recoveries: result.recoveries?.filter(item => !pendingRecoveries.current.has(item.operationId)),
              receipts: result.receipts?.filter(item => !pendingRecoveries.current.has(item.operationId))
            }));
          } else {
            uncertain.current = result.status.kind === 'pending';
            if (week !== undefined) uncertainWeek.current = week;
            setSnapshot({
              ...result,
              recoveries: result.recoveries?.filter(item => !pendingRecoveries.current.has(item.operationId)),
              receipts: result.receipts?.filter(item => !pendingRecoveries.current.has(item.operationId))
            });
          }
        }
      } catch {
        // This uncertainty concerns only the older request's nullifier; a new week's claim remains independent.
      } finally {
        lock.current = false;
        if (mounted.current) setBusy(false);
      }
      return;
    }
    lock.current = true;
    uncertain.current = true;
    uncertainWeek.current = canonicalWeek(quote.allocationWeekStart);
    setBusy(true);
    setSnapshot(previous => ({ ...previous, status: { kind: 'pending' } }));
    try {
      const result = await service.submit({ accountId, networkId }, quote.quoteId);
      if (mounted.current) {
        if (cannotResolveSubmission(result)) {
          setSnapshot({ status: { kind: 'pending' }, balance: null });
        } else {
          uncertain.current = result.status.kind === 'pending';
          setSnapshot(result);
        }
      }
    } catch {
      // Lost responses may have submitted funds. Reconcile before another approval.
      if (mounted.current) setSnapshot({ status: { kind: 'pending' }, balance: null });
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return { snapshot, busy, error, review, claim, recover, cancelReview, confirmReview, refresh };
}
