import {
  isProgressionStep,
  TaskStepEvent,
  TELEMETRY_STEP_ACTIONS,
  TelemetryProgressionFlow,
  TelemetryRunId,
  TelemetryStep,
  TelemetryStepAction
} from './types';

/** Caps step events emitted for a single task attempt to bound egress volume. */
export const MAX_STEP_EVENTS_PER_FLOW = 40;

/** Caps repeated non-progressing triggers per step visit while preserving dwell. */
export const MAX_REPEAT_EVENTS_PER_STEP_VISIT = 3;

export interface StepProgressionTrackerOptions {
  flow: TelemetryProgressionFlow;
  flowId: string;
  runId: TelemetryRunId;
  initiallyVisible?: boolean;
  now?: () => number;
  emit: (event: TaskStepEvent) => void;
}

export interface StepProgressionTracker {
  enter(step: TelemetryStep, initialVisibleMs?: number): void;
  transition(action: TelemetryStepAction, nextStep?: TelemetryStep): void;
  recordActionWithoutProgress(): void;
  recordRetry(): void;
  finish(action: TelemetryStepAction): void;
  teardown(): void;
  visible(isVisible: boolean): void;
  currentStep(): TelemetryStep | null;
  isDisposed(): boolean;
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function isAllowedAction(action: TelemetryStepAction): boolean {
  return TELEMETRY_STEP_ACTIONS.includes(action);
}

/**
 * Tracks closed task steps, active visible dwell, backtracking/retry transitions,
 * and repeated non-progressing triggers for one Send or Funding attempt.
 */
export function createStepProgressionTracker(options: StepProgressionTrackerOptions): StepProgressionTracker {
  const { flow, flowId, runId, emit } = options;
  const now = options.now ?? defaultNow;

  let isVisible = options.initiallyVisible ?? true;
  let activeStep: TelemetryStep | null = null;
  let visibleMsAccumulated = 0;
  let visibleSince: number | null = null;
  let order = 0;
  let nonProgressingActions = 0;
  let repeatsEmitted = 0;
  let disposed = false;

  function flushVisibleTime(at: number): void {
    if (activeStep !== null && isVisible && visibleSince !== null) {
      visibleMsAccumulated += Math.max(0, at - visibleSince);
      visibleSince = at;
    }
  }

  function resetVisit(nextStep: TelemetryStep | null, at: number | null): void {
    activeStep = nextStep;
    visibleMsAccumulated = 0;
    visibleSince = nextStep !== null && isVisible ? at : null;
    nonProgressingActions = 0;
    repeatsEmitted = 0;
  }

  function emitStep(step: TelemetryStep, stepAction: TelemetryStepAction, visibleMs: number, complete: boolean): void {
    if (disposed || order >= MAX_STEP_EVENTS_PER_FLOW) return;
    if (!isProgressionStep(flow, step) || !isAllowedAction(stepAction)) return;
    order += 1;
    emit({
      phase: 'step',
      flow,
      flowId,
      runId,
      step,
      stepAction,
      order,
      visibleMs: Math.max(0, Math.round(visibleMs)),
      complete
    });
  }

  function endFlow(stepAction: TelemetryStepAction, complete: boolean): void {
    if (disposed) return;
    if (activeStep !== null) {
      const at = now();
      flushVisibleTime(at);
      emitStep(activeStep, stepAction, visibleMsAccumulated, complete);
    }
    disposed = true;
    resetVisit(null, null);
  }

  function enter(step: TelemetryStep, initialVisibleMs?: number): void {
    if (disposed || !isProgressionStep(flow, step) || activeStep === step) return;
    resetVisit(step, now());
    if (typeof initialVisibleMs === 'number' && Number.isFinite(initialVisibleMs) && initialVisibleMs > 0) {
      visibleMsAccumulated = Math.round(initialVisibleMs);
    }
  }

  return {
    enter,

    transition(action: TelemetryStepAction, nextStep?: TelemetryStep): void {
      if (disposed || !isAllowedAction(action)) return;
      const at = now();
      if (activeStep !== null) {
        flushVisibleTime(at);
        const completedStep = activeStep;
        const duration = visibleMsAccumulated;
        resetVisit(null, null);
        emitStep(completedStep, action, duration, true);
      }
      if (nextStep !== undefined) {
        enter(nextStep);
      }
    },

    recordActionWithoutProgress(): void {
      if (disposed || activeStep === null) return;
      flushVisibleTime(now());
      nonProgressingActions += 1;
      if (nonProgressingActions < 2 || repeatsEmitted >= MAX_REPEAT_EVENTS_PER_STEP_VISIT) return;
      repeatsEmitted += 1;
      emitStep(activeStep, 'repeat', visibleMsAccumulated, true);
    },

    recordRetry(): void {
      if (disposed || activeStep === null) return;
      const at = now();
      flushVisibleTime(at);
      const retryStep = activeStep;
      const duration = visibleMsAccumulated;
      resetVisit(retryStep, at);
      emitStep(retryStep, 'retry', duration, true);
    },

    finish(action: TelemetryStepAction): void {
      if (!isAllowedAction(action)) return;
      endFlow(action, true);
    },

    teardown(): void {
      endFlow('leave', false);
    },

    visible(nextVisible: boolean): void {
      if (disposed || nextVisible === isVisible) return;
      const at = now();
      if (nextVisible) {
        isVisible = true;
        if (activeStep !== null) visibleSince = at;
        return;
      }
      flushVisibleTime(at);
      isVisible = false;
      visibleSince = null;
    },

    currentStep: () => activeStep,
    isDisposed: () => disposed
  };
}
