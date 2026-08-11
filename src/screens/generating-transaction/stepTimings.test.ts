import { advanceStepTimings, type StepTimings } from './stepTimings';

/**
 * #530 — the "Guardian approved" duration jumped (~1.488s → ~2.033s) shortly
 * after the step turned green. Root cause: several transaction *stages* map to
 * the same *step index* (e.g. `sending` and `proving` → index 1), and the timing
 * reducer ran again for the same step, overwriting the already-recorded times.
 * Each step's start/end must be recorded exactly once.
 */
describe('advanceStepTimings (#530 duration stability)', () => {
  it('does not bump a step end / next-step start when the stage re-enters the same index', () => {
    let t = advanceStepTimings({}, { stepIndex: 0, transactionComplete: false, now: 1000 }); // step 0 starts
    t = advanceStepTimings(t, { stepIndex: 1, transactionComplete: false, now: 2000 }); // `sending` → step 0 ends, step 1 starts
    expect(t['guardian-approving']?.endedAt).toBe(2000);
    expect(t['generating-proof']?.startedAt).toBe(2000);

    // `proving` also maps to index 1 — it must NOT overwrite the recorded times.
    t = advanceStepTimings(t, { stepIndex: 1, transactionComplete: false, now: 5000 });
    expect(t['guardian-approving']?.endedAt).toBe(2000);
    expect(t['generating-proof']?.startedAt).toBe(2000);
  });

  it('does not re-start step 0 while still on an index-0 stage', () => {
    let t = advanceStepTimings({}, { stepIndex: 0, transactionComplete: false, now: 1000 });
    t = advanceStepTimings(t, { stepIndex: 0, transactionComplete: false, now: 1500 }); // creating- → signing-proposal
    expect(t['guardian-approving']?.startedAt).toBe(1000);
  });

  it('finalizes the last step once and does not bump it on re-completion ticks', () => {
    let t = advanceStepTimings({}, { stepIndex: 3, transactionComplete: false, now: 1000 }); // last step starts
    t = advanceStepTimings(t, { stepIndex: undefined, transactionComplete: true, now: 2000 });
    expect(t['syncing-guardian']?.endedAt).toBe(2000);
    t = advanceStepTimings(t, { stepIndex: undefined, transactionComplete: true, now: 9000 }); // effect re-runs while complete
    expect(t['syncing-guardian']?.endedAt).toBe(2000);
  });

  it('returns the same reference when nothing changes (avoids needless re-renders)', () => {
    const started = advanceStepTimings({}, { stepIndex: 0, transactionComplete: false, now: 1000 });
    expect(advanceStepTimings(started, { stepIndex: 0, transactionComplete: false, now: 2000 })).toBe(started);
  });

  it('records every step once across the full guardian stage walk (the true #530 repro)', () => {
    // stepIndex per stage (see getTimedStepIndexForStage): syncing/creating-/signing-proposal -> 0,
    // sending/proving -> 1, executing -> undefined, submitting -> 2, guardian-syncing -> 3,
    // guardian-synced -> 4 (out of range → no-op), complete -> finalize.
    const walk: Array<{ stepIndex: number | undefined; complete: boolean }> = [
      { stepIndex: 0, complete: false }, // syncing
      { stepIndex: 0, complete: false }, // creating-proposal
      { stepIndex: 0, complete: false }, // signing-proposal
      { stepIndex: 1, complete: false }, // sending  -> step 0 ends, step 1 starts
      { stepIndex: undefined, complete: false }, // executing (no-op)
      { stepIndex: 1, complete: false }, // proving  -> must NOT bump
      { stepIndex: 2, complete: false }, // submitting -> step 1 ends, step 2 starts
      { stepIndex: 3, complete: false }, // guardian-syncing -> step 2 ends, step 3 starts
      { stepIndex: 4, complete: false }, // guardian-synced -> index past the last step, no-op
      { stepIndex: undefined, complete: true } // complete -> step 3 ends
    ];
    let t: StepTimings = {};
    let now = 0;
    for (const event of walk) {
      now += 1000;
      t = advanceStepTimings(t, { stepIndex: event.stepIndex, transactionComplete: event.complete, now });
    }
    expect(t['guardian-approving']).toEqual({ startedAt: 1000, endedAt: 4000 });
    expect(t['generating-proof']).toEqual({ startedAt: 4000, endedAt: 7000 });
    expect(t['submitting']).toEqual({ startedAt: 7000, endedAt: 8000 });
    expect(t['syncing-guardian']).toEqual({ startedAt: 8000, endedAt: 10000 });
  });

  it('sets startedAt when a step is first seen via a transition, so the duration is 0 not NaN', () => {
    // Tx observed mid-flow: the first event is already a transition to index 1.
    // The old inline code left the previous step's startedAt undefined, so the
    // rendered duration was `endedAt - undefined` = NaN.
    const t = advanceStepTimings({}, { stepIndex: 1, transactionComplete: false, now: 3000 });
    expect(t['guardian-approving']?.startedAt).toBe(3000);
    expect(t['guardian-approving']?.endedAt).toBe(3000);
    expect((t['guardian-approving']!.endedAt! - t['guardian-approving']!.startedAt) / 1000).toBe(0);
  });
});
