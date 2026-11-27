import { attachStepProgressionLifecycle, startVisibleDwellTimer } from './step-lifecycle';
import {
  createStepProgressionTracker,
  MAX_REPEAT_EVENTS_PER_STEP_VISIT,
  MAX_STEP_EVENTS_PER_FLOW
} from './step-progression';
import type { TaskStepEvent } from './types';

describe('step-progression', () => {
  it('orders steps monotonically within one attempt and counts only visible time', () => {
    let clock = 1_000;
    const emitted: TaskStepEvent[] = [];
    const tracker = createStepProgressionTracker({
      flow: 'send',
      flowId: 'flow-1',
      runId: 'run-1',
      now: () => clock,
      emit: event => emitted.push(event)
    });

    tracker.enter('select_recipient');
    clock += 1_500;
    // Hidden for 10 seconds: must not be added to visibleMs.
    tracker.visible(false);
    clock += 10_000;
    tracker.visible(true);
    clock += 500;
    tracker.transition('continue', 'select_amount');

    clock += 800;
    tracker.transition('back', 'select_recipient');

    clock += 300;
    tracker.transition('close');

    expect(emitted).toEqual([
      {
        phase: 'step',
        flow: 'send',
        flowId: 'flow-1',
        runId: 'run-1',
        step: 'select_recipient',
        stepAction: 'continue',
        order: 1,
        visibleMs: 2_000,
        complete: true
      },
      {
        phase: 'step',
        flow: 'send',
        flowId: 'flow-1',
        runId: 'run-1',
        step: 'select_amount',
        stepAction: 'back',
        order: 2,
        visibleMs: 800,
        complete: true
      },
      {
        phase: 'step',
        flow: 'send',
        flowId: 'flow-1',
        runId: 'run-1',
        step: 'select_recipient',
        stepAction: 'close',
        order: 3,
        visibleMs: 300,
        complete: true
      }
    ]);
  });

  it('starts hidden when created while the document is hidden and begins counting only once visible', () => {
    let clock = 500;
    const emitted: TaskStepEvent[] = [];
    const tracker = createStepProgressionTracker({
      flow: 'fund',
      flowId: 'flow-h',
      runId: 'run-1',
      initiallyVisible: false,
      now: () => clock,
      emit: event => emitted.push(event)
    });

    tracker.enter('connect_wallet');
    clock += 5_000;
    tracker.visible(true);
    clock += 250;
    tracker.transition('continue', 'select_amount');

    expect(emitted).toEqual([
      {
        phase: 'step',
        flow: 'fund',
        flowId: 'flow-h',
        runId: 'run-1',
        step: 'connect_wallet',
        stepAction: 'continue',
        order: 1,
        visibleMs: 250,
        complete: true
      }
    ]);
  });

  it('emits repeat on the second non-progressing action without resetting visible dwell and enforces per-visit cap', () => {
    let clock = 100;
    const emitted: TaskStepEvent[] = [];
    const tracker = createStepProgressionTracker({
      flow: 'send',
      flowId: 'flow-2',
      runId: 'run-1',
      now: () => clock,
      emit: event => emitted.push(event)
    });

    tracker.enter('review');
    clock += 1_000;
    // First blocked press is ignored; repeated presses signal friction without resetting dwell.
    tracker.recordActionWithoutProgress();
    expect(emitted).toEqual([]);

    for (let i = 0; i < MAX_REPEAT_EVENTS_PER_STEP_VISIT + 2; i++) {
      clock += 200;
      tracker.recordActionWithoutProgress();
    }

    clock += 400;
    tracker.transition('submit', 'submitting');

    const repeats = emitted.filter(event => event.stepAction === 'repeat');
    expect(repeats).toHaveLength(MAX_REPEAT_EVENTS_PER_STEP_VISIT);
    expect(repeats.map(event => event.order)).toEqual([1, 2, 3]);
    expect(emitted[emitted.length - 1]).toEqual({
      phase: 'step',
      flow: 'send',
      flowId: 'flow-2',
      runId: 'run-1',
      step: 'review',
      stepAction: 'submit',
      order: 4,
      visibleMs: 1_000 + (MAX_REPEAT_EVENTS_PER_STEP_VISIT + 2) * 200 + 400,
      complete: true
    });
  });

  it('resets non-progressing repeat count when retrying or entering another step', () => {
    let clock = 0;
    const emitted: TaskStepEvent[] = [];
    const tracker = createStepProgressionTracker({
      flow: 'fund',
      flowId: 'flow-3',
      runId: 'run-1',
      now: () => clock,
      emit: event => emitted.push(event)
    });

    tracker.enter('review');
    clock += 500;
    tracker.recordActionWithoutProgress();
    clock += 300;
    tracker.recordRetry();
    clock += 200;
    // First non-progressing action after retry must not emit repeat.
    tracker.recordActionWithoutProgress();
    clock += 200;
    tracker.recordActionWithoutProgress();
    tracker.finish('leave');

    expect(emitted.map(event => event.stepAction)).toEqual(['retry', 'repeat', 'leave']);
  });

  it('marks teardown incomplete and ignores all subsequent calls', () => {
    let clock = 1_000;
    const emitted: TaskStepEvent[] = [];
    const tracker = createStepProgressionTracker({
      flow: 'fund',
      flowId: 'flow-4',
      runId: 'run-1',
      now: () => clock,
      emit: event => emitted.push(event)
    });

    tracker.enter('select_route');
    clock += 650;
    tracker.teardown();
    clock += 1_000;
    tracker.enter('review');
    tracker.transition('continue', 'submitting');
    tracker.recordActionWithoutProgress();
    tracker.recordRetry();
    tracker.finish('close');
    tracker.teardown();

    expect(emitted).toEqual([
      {
        phase: 'step',
        flow: 'fund',
        flowId: 'flow-4',
        runId: 'run-1',
        step: 'select_route',
        stepAction: 'leave',
        order: 1,
        visibleMs: 650,
        complete: false
      }
    ]);
  });

  it('caps total step events emitted per flow', () => {
    let clock = 0;
    const emitted: TaskStepEvent[] = [];
    const tracker = createStepProgressionTracker({
      flow: 'send',
      flowId: 'flow-cap',
      runId: 'run-1',
      now: () => clock,
      emit: event => emitted.push(event)
    });

    tracker.enter('select_recipient');
    for (let i = 0; i < MAX_STEP_EVENTS_PER_FLOW + 15; i++) {
      clock += 100;
      tracker.transition(i % 2 === 0 ? 'continue' : 'back', i % 2 === 0 ? 'select_amount' : 'select_recipient');
    }

    expect(emitted).toHaveLength(MAX_STEP_EVENTS_PER_FLOW);
    expect(emitted[MAX_STEP_EVENTS_PER_FLOW - 1]?.order).toBe(MAX_STEP_EVENTS_PER_FLOW);
  });

  it('uses monotonic performance.now by default rather than Date.now', () => {
    const perfSpy = jest.spyOn(performance, 'now').mockReturnValueOnce(500).mockReturnValueOnce(925);
    const dateSpy = jest.spyOn(Date, 'now').mockReturnValue(9_999_999);
    const emitted: TaskStepEvent[] = [];

    try {
      const tracker = createStepProgressionTracker({
        flow: 'send',
        flowId: 'flow-mono',
        runId: 'run-1',
        emit: event => emitted.push(event)
      });

      tracker.enter('review');
      tracker.transition('submit', 'submitting');

      expect(emitted).toEqual([
        {
          phase: 'step',
          flow: 'send',
          flowId: 'flow-mono',
          runId: 'run-1',
          step: 'review',
          stepAction: 'submit',
          order: 1,
          visibleMs: 425,
          complete: true
        }
      ]);
      expect(dateSpy).not.toHaveBeenCalled();
    } finally {
      perfSpy.mockRestore();
      dateSpy.mockRestore();
    }
  });

  it('pauses on persisted pagehide/pageshow and tears down only on non-persisted pagehide', () => {
    let clock = 100;
    const emitted: TaskStepEvent[] = [];
    const tracker = createStepProgressionTracker({
      flow: 'fund',
      flowId: 'flow-bfcache',
      runId: 'run-1',
      now: () => clock,
      emit: event => emitted.push(event)
    });
    const detach = attachStepProgressionLifecycle(tracker);

    try {
      tracker.enter('select_amount');
      clock += 300;
      const persistedHide = new Event('pagehide');
      Object.defineProperty(persistedHide, 'persisted', { value: true });
      window.dispatchEvent(persistedHide);

      // Suspended in BFCache: dwell must pause and tracker stays alive.
      clock += 5_000;
      expect(tracker.isDisposed()).toBe(false);
      expect(emitted).toEqual([]);

      const persistedShow = new Event('pageshow');
      Object.defineProperty(persistedShow, 'persisted', { value: true });
      window.dispatchEvent(persistedShow);
      clock += 200;
      tracker.transition('continue', 'select_route');

      clock += 150;
      const terminalHide = new Event('pagehide');
      Object.defineProperty(terminalHide, 'persisted', { value: false });
      window.dispatchEvent(terminalHide);

      expect(tracker.isDisposed()).toBe(true);
      expect(emitted).toEqual([
        {
          phase: 'step',
          flow: 'fund',
          flowId: 'flow-bfcache',
          runId: 'run-1',
          step: 'select_amount',
          stepAction: 'continue',
          order: 1,
          visibleMs: 500,
          complete: true
        },
        {
          phase: 'step',
          flow: 'fund',
          flowId: 'flow-bfcache',
          runId: 'run-1',
          step: 'select_route',
          stepAction: 'leave',
          order: 2,
          visibleMs: 150,
          complete: false
        }
      ]);
    } finally {
      detach();
    }
  });

  it('carries passive foreground dwell via startVisibleDwellTimer() into enter(step, initialVisibleMs) without holding a flowId', () => {
    let clock = 100;
    const dwell = startVisibleDwellTimer(() => clock);

    clock += 450;
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    clock += 5_000;

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    clock += 200;

    // Persisted BFCache hide pauses without discarding; pageshow resumes accumulation.
    const persistedHide = new Event('pagehide');
    Object.defineProperty(persistedHide, 'persisted', { value: true });
    window.dispatchEvent(persistedHide);
    clock += 3_000;

    const persistedShow = new Event('pageshow');
    Object.defineProperty(persistedShow, 'persisted', { value: true });
    window.dispatchEvent(persistedShow);
    clock += 100;

    const carriedMs = dwell.consume();
    expect(carriedMs).toBe(750);
    // Consuming is idempotent and detaches listeners.
    clock += 500;
    expect(dwell.consume()).toBe(0);

    const emitted: TaskStepEvent[] = [];
    const retryTracker = createStepProgressionTracker({
      flow: 'send',
      flowId: 'flow-carry-2',
      runId: 'run-1',
      now: () => clock,
      emit: event => emitted.push(event)
    });

    retryTracker.enter('review', carriedMs);
    clock += 100;
    retryTracker.transition('retry', 'submitting');

    expect(emitted).toEqual([
      {
        phase: 'step',
        flow: 'send',
        flowId: 'flow-carry-2',
        runId: 'run-1',
        step: 'review',
        stepAction: 'retry',
        order: 1,
        visibleMs: 850,
        complete: true
      }
    ]);

    // Non-persisted pagehide and cancel() discard accumulated dwell cleanly.
    const cancelledByPageHide = startVisibleDwellTimer(() => clock);
    clock += 300;
    const terminalHide = new Event('pagehide');
    Object.defineProperty(terminalHide, 'persisted', { value: false });
    window.dispatchEvent(terminalHide);
    expect(cancelledByPageHide.consume()).toBe(0);

    const cancelledExplicitly = startVisibleDwellTimer(() => clock);
    clock += 250;
    cancelledExplicitly.cancel();
    expect(cancelledExplicitly.consume()).toBe(0);
  });
});
