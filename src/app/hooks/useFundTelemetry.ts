import { useCallback, useEffect, useMemo, useRef } from 'react';

import { beginFlow, classifyError, FlowHandle } from 'lib/telemetry';
import { reportTelemetryEvent } from 'lib/telemetry/report-flow';
import {
  attachStepProgressionLifecycle,
  isDocumentHidden,
  startVisibleDwellTimer,
  VisibleDwellTimer
} from 'lib/telemetry/step-lifecycle';
import { createStepProgressionTracker, StepProgressionTracker } from 'lib/telemetry/step-progression';
import { TelemetryStep, TelemetryStepAction } from 'lib/telemetry/types';

/**
 * Wraps one deposit attempt, passing its result — or its error — straight back
 * through, so the bridge screen's own error handling is untouched.
 */
export type ReportDeposit = <T>(attempt: () => Promise<T>) => Promise<T>;

export interface FundFlowTelemetry {
  reportDeposit: ReportDeposit;
  enterStep: (step: TelemetryStep) => void;
  transitionStep: (action: TelemetryStepAction, nextStep?: TelemetryStep) => void;
  recordActionWithoutProgress: () => void;
  recordRetry: () => void;
}

function attachTrackerForFlow(flow: FlowHandle | null | undefined): {
  tracker: StepProgressionTracker | null;
  detach: (() => void) | null;
} {
  if (
    !flow ||
    typeof flow.flowId !== 'string' ||
    flow.flowId.length === 0 ||
    typeof flow.runId !== 'string' ||
    flow.runId.length === 0
  ) {
    return { tracker: null, detach: null };
  }
  const tracker = createStepProgressionTracker({
    flow: 'fund',
    flowId: flow.flowId,
    runId: flow.runId,
    initiallyVisible: !isDocumentHidden(),
    emit: reportTelemetryEvent
  });
  return { tracker, detach: attachStepProgressionLifecycle(tracker) };
}

/**
 * Reports funding the wallet as a `fund` flow plus closed step progression.
 *
 * Scope: one flow per attempt to fund, begun on entry to the bridge-deposit
 * surface — so connecting a wallet, picking a token, and walking away mid-quote
 * are all visible as abandonment, which is where this flow actually loses
 * people. It ends at the outcome of the deposit submission.
 *
 * A deposit is "completed" once the bridge transfer is accepted and tracked;
 * what the bridge does afterwards plays out on the status screen and is not the
 * user's part of the flow. A failed submission settles the flow errored, and the
 * next tap begins a fresh one, so a retry's outcome is never swallowed by the
 * (idempotent) handle of the attempt that failed.
 */
export function useFundFlow(): FundFlowTelemetry {
  const flowRef = useRef<FlowHandle | null>(null);
  const trackerRef = useRef<StepProgressionTracker | null>(null);
  const detachRef = useRef<(() => void) | null>(null);
  const hasFailedAttemptRef = useRef(false);
  const pendingStepRef = useRef<TelemetryStep | null>(null);
  const activeDepositTokenRef = useRef(0);
  const postFailureDwellRef = useRef<VisibleDwellTimer | null>(null);

  useEffect(() => {
    const initialFlow = beginFlow('fund');
    flowRef.current = initialFlow ?? null;
    const { tracker, detach } = attachTrackerForFlow(initialFlow);
    trackerRef.current = tracker;
    detachRef.current = detach;
    if (pendingStepRef.current !== null) {
      const step = pendingStepRef.current;
      pendingStepRef.current = null;
      flowRef.current?.step?.(step);
      tracker?.enter(step);
    }
    return () => {
      activeDepositTokenRef.current += 1;
      pendingStepRef.current = null;
      hasFailedAttemptRef.current = false;
      postFailureDwellRef.current?.cancel();
      postFailureDwellRef.current = null;
      detachRef.current?.();
      detachRef.current = null;
      trackerRef.current?.finish('leave');
      trackerRef.current = null;
      flowRef.current?.cancel();
      flowRef.current = null;
    };
  }, []);

  const enterStep = useCallback((step: TelemetryStep) => {
    if (!trackerRef.current) {
      pendingStepRef.current = step;
      flowRef.current?.step?.(step);
      return;
    }
    pendingStepRef.current = null;
    if (trackerRef.current.currentStep() !== null) return;
    flowRef.current?.step?.(step);
    trackerRef.current.enter(step);
  }, []);

  const transitionStep = useCallback((action: TelemetryStepAction, nextStep?: TelemetryStep) => {
    activeDepositTokenRef.current += 1;
    if (!flowRef.current) {
      postFailureDwellRef.current?.cancel();
      postFailureDwellRef.current = null;
      if (trackerRef.current) {
        detachRef.current?.();
        detachRef.current = null;
        trackerRef.current.finish(action);
        trackerRef.current = null;
      }
      hasFailedAttemptRef.current = false;
      if (nextStep === undefined) return;
      const nextFlow = beginFlow('fund') ?? null;
      flowRef.current = nextFlow;
      const next = attachTrackerForFlow(nextFlow);
      trackerRef.current = next.tracker;
      detachRef.current = next.detach;
      nextFlow?.step?.(nextStep);
      next.tracker?.enter(nextStep);
      return;
    }
    if (nextStep !== undefined) flowRef.current.step?.(nextStep);
    trackerRef.current?.transition(action, nextStep);
  }, []);

  const recordActionWithoutProgress = useCallback(() => {
    trackerRef.current?.recordActionWithoutProgress();
  }, []);

  const recordRetry = useCallback(() => {
    trackerRef.current?.recordRetry();
  }, []);

  const reportDeposit = useCallback(async <T>(attempt: () => Promise<T>): Promise<T> => {
    const wasRetry = hasFailedAttemptRef.current;
    let flow = flowRef.current;
    let activeTracker = trackerRef.current;
    if (!flow) {
      const carriedVisibleMs = postFailureDwellRef.current?.consume() ?? 0;
      postFailureDwellRef.current = null;
      if (trackerRef.current) {
        detachRef.current?.();
        detachRef.current = null;
        trackerRef.current.finish('leave');
        trackerRef.current = null;
      }
      flow = beginFlow('fund') ?? null;
      flowRef.current = flow;
      const next = attachTrackerForFlow(flow);
      activeTracker = next.tracker;
      trackerRef.current = next.tracker;
      detachRef.current = next.detach;
      if (activeTracker) {
        activeTracker.enter('review', carriedVisibleMs);
      }
    } else {
      postFailureDwellRef.current?.cancel();
      postFailureDwellRef.current = null;
    }

    hasFailedAttemptRef.current = false;
    flow?.step?.('submitting');
    if (activeTracker) {
      activeTracker.transition(wasRetry ? 'retry' : 'submit', 'submitting');
    }

    const depositToken = activeDepositTokenRef.current + 1;
    activeDepositTokenRef.current = depositToken;

    try {
      const result = await attempt();
      // Only settle while the ref still holds this flow: a leave mid-deposit has
      // already reported it abandoned, and that reading should stand.
      if (flow && flowRef.current === flow && activeDepositTokenRef.current === depositToken) {
        flowRef.current = null;
        if (trackerRef.current === activeTracker) {
          activeTracker?.transition('continue');
        }
        flow.complete();
      }
      return result;
    } catch (err) {
      if (flow && flowRef.current === flow && activeDepositTokenRef.current === depositToken) {
        flowRef.current = null;
        hasFailedAttemptRef.current = true;
        if (trackerRef.current === activeTracker) {
          detachRef.current?.();
          detachRef.current = null;
          activeTracker?.finish('leave');
          trackerRef.current = null;
        }
        flow.fail(classifyError(err));
        postFailureDwellRef.current = startVisibleDwellTimer();
      }
      throw err;
    }
  }, []);

  return useMemo(
    () => ({
      reportDeposit,
      enterStep,
      transitionStep,
      recordActionWithoutProgress,
      recordRetry
    }),
    [enterStep, recordActionWithoutProgress, recordRetry, reportDeposit, transitionStep]
  );
}

export function useFundTelemetry(): ReportDeposit {
  return useFundFlow().reportDeposit;
}
