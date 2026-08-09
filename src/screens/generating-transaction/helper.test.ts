import { GUARDIAN_TRANSACTION_STEPS, STANDARD_TRANSACTION_STEPS } from './constants';
import { getActiveStepIndex, getStepDurationsMs } from './helper';

describe('getActiveStepIndex', () => {
  it('returns steps.length once the tx is complete', () => {
    expect(getActiveStepIndex(GUARDIAN_TRANSACTION_STEPS, 'proving', true)).toBe(GUARDIAN_TRANSACTION_STEPS.length);
  });

  it('treats the terminal stages as fully done', () => {
    expect(getActiveStepIndex(GUARDIAN_TRANSACTION_STEPS, 'complete', false)).toBe(GUARDIAN_TRANSACTION_STEPS.length);
    expect(getActiveStepIndex(GUARDIAN_TRANSACTION_STEPS, 'guardian-synced', false)).toBe(
      GUARDIAN_TRANSACTION_STEPS.length
    );
  });

  it('maps guardian stages to the owning step', () => {
    expect(getActiveStepIndex(GUARDIAN_TRANSACTION_STEPS, 'creating-proposal', false)).toBe(0);
    expect(getActiveStepIndex(GUARDIAN_TRANSACTION_STEPS, 'proving', false)).toBe(1);
    expect(getActiveStepIndex(GUARDIAN_TRANSACTION_STEPS, 'submitting', false)).toBe(2);
    expect(getActiveStepIndex(GUARDIAN_TRANSACTION_STEPS, 'guardian-syncing', false)).toBe(3);
  });

  it('maps standard-send stages to its two steps', () => {
    expect(getActiveStepIndex(STANDARD_TRANSACTION_STEPS, 'proving', false)).toBe(0);
    expect(getActiveStepIndex(STANDARD_TRANSACTION_STEPS, 'submitting', false)).toBe(1);
  });

  it('falls back to the first step for an undefined or unowned stage', () => {
    expect(getActiveStepIndex(STANDARD_TRANSACTION_STEPS, undefined, false)).toBe(0);
    // 'guardian-syncing' is not part of the standard step set.
    expect(getActiveStepIndex(STANDARD_TRANSACTION_STEPS, 'guardian-syncing', false)).toBe(0);
  });
});

describe('getStepDurationsMs', () => {
  it('spans each step from its startStage to the next step start, and the last to `complete`', () => {
    const durations = getStepDurationsMs(GUARDIAN_TRANSACTION_STEPS, {
      'creating-proposal': 100,
      proving: 400,
      submitting: 900,
      'guardian-syncing': 1_500,
      complete: 1_800
    });
    expect(durations).toEqual([300, 500, 600, 300]);
  });

  it('returns undefined for a step whose start or end stamp is missing (no fabricated value)', () => {
    // Missing `proving` → generating-proof has no start; missing nothing else.
    const durations = getStepDurationsMs(STANDARD_TRANSACTION_STEPS, { submitting: 3_000, complete: 3_500 });
    expect(durations).toEqual([undefined, 500]);
  });

  it('returns undefined rather than a negative duration when stamps are out of order', () => {
    const durations = getStepDurationsMs(STANDARD_TRANSACTION_STEPS, {
      proving: 5_000,
      submitting: 1_000,
      complete: 6_000
    });
    // generating-proof: submitting(1000) < proving(5000) → undefined; submitting: complete(6000) - submitting(1000).
    expect(durations).toEqual([undefined, 5_000]);
  });

  it('returns all undefined when there are no stamps', () => {
    expect(getStepDurationsMs(STANDARD_TRANSACTION_STEPS, undefined)).toEqual([undefined, undefined]);
  });
});
