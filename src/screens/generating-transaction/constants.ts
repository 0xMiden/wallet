import type { ITransactionStage } from 'lib/miden/db/types';

export const SUCCESS_RECEIPT_DELAY_MS = 1_500;
export const TRANSACTION_LOOP_INTERVAL_MS = 10_000;
export const EXPLORER_TITLE = 'Midenscan';

export const SUCCESS_GREEN = '#90BA89';
export const PROCESSING_ORANGE = '#E77537';
export const PENDING_STEP_COLOR = '#C7C7CC';

export interface TransactionStepDef {
  id: string;
  labelKey: string;
  defaultLabel: string;
  /**
   * Stage whose persisted timestamp (`ITransaction.stageTimestamps`) marks this
   * step's START. The step's duration runs from here to the next step's
   * `startStage` — or the synthetic `complete` stamp for the terminal step.
   */
  startStage: ITransactionStage;
  /**
   * Stage that opens this step on a path that never reaches `startStage`.
   *
   * Resolved AFTER `startStage`, so `startStage` must be the EARLIER of the two
   * whenever a row can carry both — otherwise the step times from the later stamp
   * and silently drops the span in front of it. The offline rotation's first step
   * is the case that makes this concrete: it always stamps `creating-proposal`
   * (the attempt against the dead operator is what sends it down that path) and
   * then `signing-locally`, so `creating-proposal` is the `startStage` there too,
   * and only the LABEL differs from the coordinated set.
   */
  fallbackStartStage?: ITransactionStage;
  /**
   * Stages during which this is the in-progress step; drives the row's
   * checkmark/active/pending state (`getActiveStepIndex`).
   */
  activeStages: readonly ITransactionStage[];
}

/**
 * Guardian send: co-sign the proposal → generate proof → submit → sync the new
 * state back to the guardian. Four steps, all with real per-step durations
 * because the guardian pipeline drives execute → prove → submit as distinct
 * stages on every platform — including the extension's offscreen realm, which
 * stamps the same three boundaries and posts each back to the service worker
 * (`OFFSCREEN_STAGE_EVENT`) to land on the row.
 */
export const GUARDIAN_TRANSACTION_STEPS = [
  {
    id: 'guardian-approving',
    labelKey: 'transactionStepGuardianApproved',
    defaultLabel: 'Guardian approved',
    startStage: 'creating-proposal',
    // Unreachable today and kept deliberately: a row carrying `signing-locally`
    // in its stage OR its stamps makes `isDirectGuardianSwitch` true, so
    // `stepsForFlow` hands it the DIRECT set below and never this one. These two
    // entries only keep the coordinated set from mistiming such a row if a future
    // caller reaches it another way — they are not evidence that it can.
    fallbackStartStage: 'signing-locally',
    activeStages: ['syncing', 'creating-proposal', 'signing-proposal', 'signing-locally']
  },
  {
    id: 'generating-proof',
    labelKey: 'transactionStepProofGenerated',
    defaultLabel: 'Proof generated',
    startStage: 'proving',
    activeStages: ['sending', 'executing', 'proving']
  },
  {
    id: 'submitting',
    labelKey: 'transactionStepSubmitting',
    defaultLabel: 'Submitting',
    startStage: 'submitting',
    activeStages: ['submitting']
  },
  {
    id: 'syncing-guardian',
    labelKey: 'transactionStepSyncingGuardian',
    defaultLabel: 'Syncing with Guardian',
    startStage: 'guardian-syncing',
    // NO switch-guardian row stamps `guardian-syncing` — the type is excluded
    // from the block that stamps it, on the coordinated path as well as the
    // direct one — so this fallback is what times the step for every rotation,
    // not just the offline kind. Their shared post-commit boundary is the
    // registration on the INCOMING guardian, stamped `registering-guardian`.
    // Resolved only when `guardian-syncing` is absent, so an ordinary guardian
    // send is unaffected.
    fallbackStartStage: 'registering-guardian',
    activeStages: ['confirming', 'registering-guardian', 'delivering', 'guardian-syncing']
  }
] as const satisfies readonly TransactionStepDef[];

/**
 * The guardian steps as an offline direct switch actually performs them.
 *
 * Only the first step differs, and it has to: on this path no operator approves
 * anything. The outgoing guardian is unreachable — that is why the direct switch
 * is running at all — and the account's hot and cold keys sign locally instead.
 * Telling the user "Guardian approved" there is not a cosmetic mismatch; it
 * describes an approval that provably did not happen, on the one screen whose
 * job is to say what the wallet is doing with their keys.
 */
export const DIRECT_SWITCH_TRANSACTION_STEPS = [
  {
    id: 'signed-locally',
    labelKey: 'transactionStepSignedLocally',
    defaultLabel: 'Signed on this device',
    // Same boundaries as the coordinated first step, deliberately: this row
    // reaches `signing-locally` only by first attempting a proposal and waiting
    // out the unreachable operator, and that wait is the bulk of what the user
    // sat through. Opening the step at `signing-locally` would report the local
    // signature alone — a couple of seconds standing in for half a minute.
    startStage: 'creating-proposal',
    fallbackStartStage: 'signing-locally',
    activeStages: ['syncing', 'creating-proposal', 'signing-proposal', 'signing-locally']
  },
  ...GUARDIAN_TRANSACTION_STEPS.slice(1)
] as const satisfies readonly TransactionStepDef[];

/**
 * Standard (non-Guardian) send: generate proof → submit. The guardian-approval
 * and guardian-sync steps don't apply — a non-guardian account has no co-signer
 * — so they're omitted rather than shown blank. Both steps are timed on every path
 * that executes and proves live — the inline pipeline, mobile/desktop, and the
 * extension's offscreen realm (same cross-realm stamp route as the guardian set).
 * A step whose boundary stamp never arrives renders blank rather than a fabricated
 * zero, which is what a speculation-cache hit (no live prove) and a dropped
 * cross-realm stamp both look like.
 */
export const STANDARD_TRANSACTION_STEPS = [
  {
    id: 'generating-proof',
    labelKey: 'transactionStepProofGenerated',
    defaultLabel: 'Proof generated',
    startStage: 'proving',
    activeStages: ['syncing', 'sending', 'executing', 'proving']
  },
  {
    id: 'submitting',
    labelKey: 'transactionStepSubmitting',
    defaultLabel: 'Submitting',
    startStage: 'submitting',
    activeStages: ['submitting']
  }
] as const satisfies readonly TransactionStepDef[];

/** Backwards-compatible alias: the full (Guardian) step tuple. */
export const TRANSACTION_STEPS = GUARDIAN_TRANSACTION_STEPS;

/**
 * The step set to render for a given account flow.
 *
 * `signedLocally` is the row's `switchedDirectly` marker, which the direct path
 * stamps before it signs — so the relabelled first step is on screen while that
 * step is the active one, not only in hindsight.
 */
export const stepsForFlow = (isGuardian: boolean, signedLocally = false): readonly TransactionStepDef[] => {
  if (!isGuardian) return STANDARD_TRANSACTION_STEPS;
  return signedLocally ? DIRECT_SWITCH_TRANSACTION_STEPS : GUARDIAN_TRANSACTION_STEPS;
};
