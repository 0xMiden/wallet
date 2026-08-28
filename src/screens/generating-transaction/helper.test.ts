import type { ITransactionStage, ITransactionType } from 'lib/miden/db/types';

import {
  DIRECT_SWITCH_TRANSACTION_STEPS,
  GUARDIAN_TRANSACTION_STEPS,
  STANDARD_TRANSACTION_STEPS,
  stepsForFlow
} from './constants';
import {
  getActiveStepIndex,
  getProcessingTitleKey,
  getStageDescriptionKey,
  getStageTitleKey,
  getStepDurationsMs,
  getTransactionStepState,
  isDirectGuardianSwitch
} from './helper';

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

  it.each<[ITransactionStage | undefined, number]>([
    [undefined, 0],
    ['syncing', 0],
    ['creating-proposal', 0],
    ['signing-proposal', 0],
    // Offline rotation: hot+cold sign locally, so this replaces
    // `signing-proposal` on that path and owns the same step.
    ['signing-locally', 0],
    ['sending', 1],
    ['executing', 1],
    ['proving', 1],
    ['submitting', 2],
    ['confirming', 3],
    ['registering-guardian', 3],
    ['delivering', 3],
    ['guardian-syncing', 3]
  ])('maps guardian stage %s onto step %i', (stage, expected) => {
    expect(getActiveStepIndex(GUARDIAN_TRANSACTION_STEPS, stage, false)).toBe(expected);
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

  // The offline rotation never stamps `creating-proposal` — it signs locally
  // instead — so step 0 had no start boundary and rendered no duration at all on
  // the one path where the user is most likely to be watching the clock.
  it('times the first guardian step from `signing-locally` on the offline path', () => {
    const durations = getStepDurationsMs(GUARDIAN_TRANSACTION_STEPS, {
      'signing-locally': 200,
      proving: 500,
      submitting: 900,
      'guardian-syncing': 1_200,
      complete: 1_400
    });
    expect(durations).toEqual([300, 400, 300, 200]);
  });

  // Both stamps can exist on one row: a proposal attempt that failed and
  // requeued into the direct path. The earlier stamp is the honest start.
  // The offline rotation's first step declares `signing-locally` and falls back to
  // `creating-proposal`, and the row always stamps the fallback FIRST — the failed
  // proposal against the dead operator is what sent it down this path. Timing from
  // the declared stage would drop that whole wait from the label.
  it('times the offline first step from the proposal attempt that preceded it', () => {
    const durations = getStepDurationsMs(DIRECT_SWITCH_TRANSACTION_STEPS, {
      'creating-proposal': 1_000,
      'signing-locally': 31_000,
      proving: 32_000,
      submitting: 33_000,
      'registering-guardian': 34_000,
      complete: 35_000
    });

    // 31s, not the 1s of local signing: the wait on the dead operator is the part
    // the user actually experienced.
    expect(durations[0]).toBe(31_000);
  });

  it('prefers the proposal stamp when a row carries both', () => {
    const durations = getStepDurationsMs(GUARDIAN_TRANSACTION_STEPS, {
      'creating-proposal': 100,
      'signing-locally': 400,
      proving: 500,
      submitting: 900,
      'guardian-syncing': 1_200,
      complete: 1_400
    });
    expect(durations[0]).toBe(400);
  });

  // The direct switch has no outgoing operator to sync with, so its post-commit
  // work stamps `registering-guardian` and never `guardian-syncing` — which left
  // the last step blank on exactly the path with the longest tail (up to eight
  // registration attempts with backoff).
  it('times the last guardian step from `registering-guardian` on the offline path', () => {
    const durations = getStepDurationsMs(DIRECT_SWITCH_TRANSACTION_STEPS, {
      'signing-locally': 200,
      proving: 500,
      submitting: 900,
      'registering-guardian': 1_200,
      complete: 2_000
    });
    expect(durations).toEqual([300, 400, 300, 800]);
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

describe('getTransactionStepState', () => {
  it('marks every step complete on a clean finish', () => {
    expect(getTransactionStepState(0, 2, true, false)).toBe('complete');
    expect(getTransactionStepState(3, 2, true, false)).toBe('complete');
  });

  // On a failure the active step carries the cross; earlier steps stay done and
  // later ones never started.
  it('splits the rows around the failed step', () => {
    expect(getTransactionStepState(2, 2, true, true)).toBe('failed');
    expect(getTransactionStepState(1, 2, true, true)).toBe('complete');
    expect(getTransactionStepState(3, 2, true, true)).toBe('pending');
  });

  it('tracks progress while the transaction is still running', () => {
    expect(getTransactionStepState(0, 1, false, false)).toBe('complete');
    expect(getTransactionStepState(1, 1, false, false)).toBe('active');
    expect(getTransactionStepState(2, 1, false, false)).toBe('pending');
  });
});

describe('getStageTitleKey', () => {
  it.each<[ITransactionStage, string]>([
    ['syncing', 'transactionStageSyncing'],
    ['creating-proposal', 'transactionStageCreatingProposal'],
    ['signing-proposal', 'transactionStageSigningProposal'],
    ['signing-locally', 'transactionStageSigningLocally'],
    ['proving', 'transactionStageProving'],
    ['submitting', 'transactionStageSubmitting'],
    ['guardian-syncing', 'transactionStageGuardianSyncing'],
    ['complete', 'transactionStageComplete'],
    ['confirming', 'transactionStageConfirming'],
    ['registering-guardian', 'transactionStageRegisteringGuardian'],
    ['delivering', 'transactionStageDelivering']
  ])('titles the %s stage', (stage, expected) => {
    expect(getStageTitleKey(stage)).toBe(expected);
  });

  it('falls back to the generic title with no stage', () => {
    expect(getStageTitleKey(undefined)).toBe('generatingTransaction');
  });

  // Stages with no title of their own (e.g. `sending`) fall through to a
  // per-transaction-type title instead.
  it.each<[ITransactionType | undefined, string]>([
    ['consume', 'transactionStageClaiming'],
    ['execute', 'transactionStageExecuting'],
    ['switch-guardian', 'transactionStageSwitching'],
    ['swap', 'transactionStageSwapping'],
    ['send', 'transactionStageSending'],
    [undefined, 'transactionStageSending']
  ])('falls through to the %s type title', (type, expected) => {
    expect(getStageTitleKey('sending', type)).toBe(expected);
  });
});

describe('getStageDescriptionKey', () => {
  it.each<[ITransactionStage, string]>([
    ['syncing', 'transactionStageSyncingDescription'],
    ['creating-proposal', 'transactionStageCreatingProposalDescription'],
    ['signing-proposal', 'transactionStageSigningProposalDescription'],
    ['signing-locally', 'transactionStageSigningLocallyDescription'],
    ['executing', 'transactionStageExecutingDescription'],
    ['proving', 'transactionStageProvingDescription'],
    ['submitting', 'transactionStageSubmittingDescription'],
    ['guardian-syncing', 'transactionStageGuardianSyncingDescription'],
    ['complete', 'transactionStageCompleteDescription'],
    ['confirming', 'transactionStageConfirmingDescription'],
    ['registering-guardian', 'transactionStageRegisteringGuardianDescription'],
    ['delivering', 'transactionStageDeliveringDescription'],
    ['sending', 'transactionStageSendingDescription']
  ])('describes the %s stage', (stage, expected) => {
    expect(getStageDescriptionKey(stage)).toBe(expected);
  });

  it('falls back to the generic description with no stage', () => {
    expect(getStageDescriptionKey(undefined)).toBe('generatingTransactionDescription');
  });
});

describe('getProcessingTitleKey', () => {
  it.each<[ITransactionType | undefined, string]>([
    ['send', 'transactionTitleSend'],
    ['swap', 'transactionTitleSwap'],
    ['consume', 'generatingTransaction'],
    [undefined, 'generatingTransaction']
  ])('titles the in-progress view for %s', (type, expected) => {
    expect(getProcessingTitleKey(type)).toBe(expected);
  });
});

describe('stepsForFlow', () => {
  it('keeps the operator-approval label for an ordinary guardian transaction', () => {
    expect(stepsForFlow(true)[0]?.labelKey).toBe('transactionStepGuardianApproved');
  });

  // "Guardian approved" on the offline rotation describes an approval that
  // provably did not happen: the path exists BECAUSE the outgoing operator is
  // unreachable, and the account's own hot and cold keys sign instead.
  it('relabels the first step when the row signed locally', () => {
    expect(stepsForFlow(true, true)[0]?.labelKey).toBe('transactionStepSignedLocally');
    expect(stepsForFlow(true, true).slice(1)).toEqual(GUARDIAN_TRANSACTION_STEPS.slice(1));
  });

  it('ignores the marker for a non-guardian account, which has no such step', () => {
    expect(stepsForFlow(false, true)).toEqual(STANDARD_TRANSACTION_STEPS);
  });
});

describe('isDirectGuardianSwitch', () => {
  it('is true only for a switch-guardian row carrying the direct marker', () => {
    expect(isDirectGuardianSwitch(undefined)).toBe(false);
    expect(isDirectGuardianSwitch({ type: 'switch-guardian', extraInputs: { switchedDirectly: true } } as never)).toBe(
      true
    );
    expect(isDirectGuardianSwitch({ type: 'switch-guardian', extraInputs: {} } as never)).toBe(false);
    expect(isDirectGuardianSwitch({ type: 'send', extraInputs: { switchedDirectly: true } } as never)).toBe(false);
  });

  // The marker write is deliberately non-fatal, so a dexie failure leaves the row
  // WITHOUT it while the `signing-locally` stage — a separate write — still lands.
  // Reading only the marker then labelled a direct rotation with the coordinated
  // step "Guardian approved" underneath a title reading "Signing locally".
  it('is true from the signing-locally stage when the marker write was lost', () => {
    expect(isDirectGuardianSwitch({ type: 'switch-guardian', stage: 'signing-locally' } as never)).toBe(true);
    // And it keeps holding once the row moves past that stage.
    expect(
      isDirectGuardianSwitch({
        type: 'switch-guardian',
        stage: 'proving',
        stageTimestamps: { 'signing-locally': 1 }
      } as never)
    ).toBe(true);
    // A coordinated switch never stamps it, so it stays false.
    expect(
      isDirectGuardianSwitch({
        type: 'switch-guardian',
        stage: 'proving',
        stageTimestamps: { 'signing-proposal': 1 }
      } as never)
    ).toBe(false);
  });
});
