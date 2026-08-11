import { advanceStepTimings } from './stepTimings';

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
});
