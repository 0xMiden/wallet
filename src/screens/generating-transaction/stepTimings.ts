import { TRANSACTION_STEPS } from './constants';

export type TransactionStepId = (typeof TRANSACTION_STEPS)[number]['id'];
export type StepTiming = { startedAt: number; endedAt?: number };
export type StepTimings = Partial<Record<TransactionStepId, StepTiming>>;

export interface StepTimingEvent {
  /** The timed step index for the current stage, or undefined if the stage isn't timed. */
  stepIndex: number | undefined;
  transactionComplete: boolean;
  now: number;
}

/**
 * Fold a step-timing event into the accumulated timings. Writes are IDEMPOTENT:
 * each step's `startedAt`/`endedAt` is recorded exactly once and never bumped.
 *
 * This is what stops the displayed duration from creeping (#530): several
 * transaction *stages* collapse onto the same *step index* (e.g. `sending` and
 * `proving` both → index 1, and `guardian-syncing`/completion tick over the last
 * step), so this reducer is invoked repeatedly for a step that is already timed.
 * Re-invocations must leave the recorded times untouched.
 *
 * Returns the SAME reference when nothing changes, so callers using it as a React
 * state updater don't trigger a needless re-render.
 */
export function advanceStepTimings(prev: StepTimings, event: StepTimingEvent): StepTimings {
  const { stepIndex, transactionComplete, now } = event;

  if (transactionComplete) {
    const last = TRANSACTION_STEPS[TRANSACTION_STEPS.length - 1];
    if (!last) return prev;
    const existing = prev[last.id];
    if (existing?.endedAt != null) return prev; // already finalized — don't bump
    return { ...prev, [last.id]: { startedAt: existing?.startedAt ?? now, endedAt: now } };
  }

  if (stepIndex === undefined) return prev;

  const step = TRANSACTION_STEPS[stepIndex];
  if (!step) return prev;

  if (stepIndex === 0) {
    if (prev[step.id]?.startedAt != null) return prev; // already started — keep the original start
    return { [step.id]: { startedAt: now } };
  }

  const prevStep = TRANSACTION_STEPS[stepIndex - 1];
  if (!prevStep) return prev;

  const prevAlreadyEnded = prev[prevStep.id]?.endedAt != null;
  const stepAlreadyStarted = prev[step.id]?.startedAt != null;
  if (prevAlreadyEnded && stepAlreadyStarted) return prev; // both already recorded — no-op

  return {
    ...prev,
    [prevStep.id]: {
      startedAt: prev[prevStep.id]?.startedAt ?? now,
      endedAt: prev[prevStep.id]?.endedAt ?? now
    },
    [step.id]: {
      startedAt: prev[step.id]?.startedAt ?? now
    }
  };
}
