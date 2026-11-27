/**
 * The `send` telemetry flow, held module-scoped for the same reason the send
 * draft is (`send-draft.ts`): a send spans two disjoint React trees — the form
 * at `/send` and the review page at `/send/review`, which owns the transaction
 * pipeline — and the form fully unmounts on handoff. A component-local handle
 * would have to settle at that unmount, reporting every successful send as
 * abandoned on the way to review.
 *
 * Scope: one flow per attempt to send. It begins when the user enters the send
 * form (so walking away mid-compose is visible as an abandonment) and ends at
 * the submit's outcome. A submit that fails settles the flow errored and the
 * next tap begins a fresh one, so a retry's outcome is never swallowed by the
 * (idempotent) handle of the attempt that failed.
 *
 * Module-scoped like the draft: it lives exactly as long as the JS context,
 * never persists, and needs no reactivity.
 */
import { beginFlow, FlowHandle } from 'lib/telemetry';
import { reportTelemetryEvent } from 'lib/telemetry/report-flow';
import { attachStepProgressionLifecycle, isDocumentHidden } from 'lib/telemetry/step-lifecycle';
import { createStepProgressionTracker, StepProgressionTracker } from 'lib/telemetry/step-progression';
import { TelemetryStep, TelemetryStepAction } from 'lib/telemetry/types';

let handle: FlowHandle | null = null;
let tracker: StepProgressionTracker | null = null;
let detachLifecycle: (() => void) | null = null;
let sessionToken = 0;

/** Begin the send flow, or adopt the one already in progress. */
export function enterSendFlow(): void {
  if (handle) return;
  if (tracker || detachLifecycle) {
    const staleTracker = tracker;
    const staleDetach = detachLifecycle;
    tracker = null;
    detachLifecycle = null;
    sessionToken = 0;
    staleDetach?.();
    staleTracker?.finish('leave');
  }
  const nextHandle = beginFlow('send');
  if (!nextHandle) return;
  handle = nextHandle;
  sessionToken += 1;
  if (
    typeof nextHandle.flowId === 'string' &&
    nextHandle.flowId.length > 0 &&
    typeof nextHandle.runId === 'string' &&
    nextHandle.runId.length > 0
  ) {
    const nextTracker = createStepProgressionTracker({
      flow: 'send',
      flowId: nextHandle.flowId,
      runId: nextHandle.runId,
      initiallyVisible: !isDocumentHidden(),
      emit: reportTelemetryEvent
    });
    tracker = nextTracker;
    detachLifecycle = attachStepProgressionLifecycle(nextTracker);
  }
}

/**
 * Settle the open flow, if any. The handle is idempotent, but clearing it here
 * keeps a later settle — an unmount after a completed submit, say — from being
 * attributed to a flow that has already ended.
 */
export function settleSendFlow(settle: (handle: FlowHandle) => void): void {
  const current = handle;
  const currentTracker = tracker;
  const detach = detachLifecycle;
  if (!current) {
    if (currentTracker || detach) {
      tracker = null;
      detachLifecycle = null;
      sessionToken = 0;
      detach?.();
      currentTracker?.finish('leave');
    } else {
      sessionToken = 0;
    }
    return;
  }
  const activeToken = sessionToken;
  handle = null;
  tracker = null;
  detachLifecycle = null;
  let settled = false;
  const finishTracker = (action: TelemetryStepAction) => {
    if (settled) return;
    settled = true;
    sessionToken = 0;
    detach?.();
    currentTracker?.finish(action);
  };
  settle({
    flowId: current.flowId,
    runId: current.runId,
    complete: () => {
      finishTracker('continue');
      current.complete();
    },
    cancel: () => {
      finishTracker('leave');
      current.cancel();
    },
    fail: kind => {
      settled = true;
      current.fail(kind);
      if (currentTracker && currentTracker.currentStep() === 'submitting') {
        currentTracker.transition('leave', 'review');
        tracker = currentTracker;
        detachLifecycle = detach;
        sessionToken = activeToken;
      } else {
        sessionToken = 0;
        detach?.();
        currentTracker?.finish('leave');
      }
    },
    step: step => current.step?.(step)
  });
  finishTracker('leave');
}

export function hasOpenSendFlow(): boolean {
  return handle !== null;
}

export function hasActiveSendSession(): boolean {
  return handle !== null || tracker !== null;
}

export function getSendSessionToken(): number {
  return hasActiveSendSession() ? sessionToken : 0;
}

/** Record the furthest step the open flow reached. No-op when none is open. */
export function reportSendStep(step: TelemetryStep): void {
  handle?.step?.(step);
  tracker?.enter(step);
}

/** Record a transition action within the open send flow attempt. */
export function transitionSendStep(action: TelemetryStepAction, nextStep?: TelemetryStep): void {
  if (nextStep !== undefined) handle?.step?.(nextStep);
  tracker?.transition(action, nextStep);
}

/** Record a transition only while `expectedToken` still owns the active send session. */
export function transitionSendStepForSession(
  expectedToken: number,
  action: TelemetryStepAction,
  nextStep?: TelemetryStep
): void {
  if (expectedToken === 0 || getSendSessionToken() !== expectedToken) return;
  transitionSendStep(action, nextStep);
}

/** Settle the send flow only while `expectedToken` still owns the active send session. */
export function settleSendFlowForSession(expectedToken: number, settle: (handle: FlowHandle) => void): void {
  if (expectedToken === 0 || getSendSessionToken() !== expectedToken) return;
  settleSendFlow(settle);
}

/** Restores `review` when an in-flight submit returns or is superseded without settling. */
export function restoreSendReviewIfSubmitting(): void {
  if (tracker?.currentStep() === 'submitting') {
    transitionSendStep('back', 'review');
  }
}

/** Record a non-progressing trigger on the active Send step. */
export function recordSendActionWithoutProgress(): void {
  tracker?.recordActionWithoutProgress();
}

/** Record a retry trigger on the active Send step. */
export function recordSendRetry(): void {
  tracker?.recordRetry();
}

/**
 * Transitions the active `review` step to `submitting`, starting a fresh attempt
 * cleanly on retry after an earlier submit failure settled the prior handle.
 */
export function beginSendSubmitting(isRetry: boolean): void {
  let carriedVisibleMs = 0;
  if (!handle && tracker) {
    carriedVisibleMs = tracker.currentStep() === 'review' ? tracker.disposeSilently() : 0;
    const staleDetach = detachLifecycle;
    tracker = null;
    detachLifecycle = null;
    staleDetach?.();
  }
  enterSendFlow();
  handle?.step?.('review');
  if (tracker && tracker.currentStep() === null) {
    tracker.enter('review', carriedVisibleMs);
  }
  transitionSendStep(isRetry ? 'retry' : 'submit', 'submitting');
}
