import { useEffect, useReducer } from 'react';

import type { ITransaction } from 'lib/miden/db/types';
import { keptCandidateHoldUntil, nowSeconds } from 'lib/miden/transaction/verdict-rules';
import { subscribeDeadlineSample } from 'lib/ui/deadline-ticker';

/**
 * When the Guardian hold on this row clears (`keptCandidateHoldUntil`), undefined when none applies. A hold ends with
 * no write to its row, so this samples the clock and re-renders only when the answer changes, never once a second:
 * the countdown's ticking belongs to `GuardianHoldNotice`.
 */
export const useGuardianHoldUntil = (row: Pick<ITransaction, 'submitEvidence'> | undefined): number | undefined => {
  const until = row === undefined ? undefined : keptCandidateHoldUntil(row, nowSeconds());
  const [, rerender] = useReducer((renders: number) => renders + 1, 0);
  useEffect(() => {
    if (row === undefined || until === undefined) return undefined;
    return subscribeDeadlineSample(until * 1000, nowMs => {
      if (keptCandidateHoldUntil(row, Math.floor(nowMs / 1000)) !== until) rerender();
    });
  }, [row, until]);
  return until;
};
