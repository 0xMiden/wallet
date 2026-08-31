export const SUCCESS_RECEIPT_DELAY_MS = 1_500;
export const TRANSACTION_LOOP_INTERVAL_MS = 10_000;
export const EXPLORER_TITLE = 'Midenscan';

export const SUCCESS_GREEN = '#90BA89';
export const PROCESSING_ORANGE = '#E77537';
export const PENDING_STEP_COLOR = '#C7C7CC';

export const TRANSACTION_STEPS = [
  {
    id: 'guardian-approving',
    labelKey: 'transactionStepGuardianApproved',
    defaultLabel: 'Guardian approved'
  },
  {
    id: 'generating-proof',
    labelKey: 'transactionStepProofGenerated',
    defaultLabel: 'Proof generated'
  },
  {
    id: 'submitting',
    labelKey: 'transactionStepSubmitting',
    defaultLabel: 'Submitting'
  },
  {
    id: 'syncing-guardian',
    labelKey: 'transactionStepSyncingGuardian',
    defaultLabel: 'Syncing with Guardian'
  }
] as const;

/**
 * Steps of a tracking-only EVM → Miden bridge row. These rows never enter the
 * Miden prove/submit FIFO (they are born `Completed`), so they get their own
 * two-step ladder driven by `extraInputs.phase` instead of `ITransactionStatus`.
 * The first step's label depends on the provider — see `AGGLAYER_SUBMIT_STEP_LABEL_KEY`.
 */
export const BRIDGED_RECEIVE_STEPS = [
  {
    id: 'bridge-submitting',
    labelKey: 'transactionStepSubmittingIntent',
    defaultLabel: 'Submitting intent'
  },
  {
    id: 'bridge-delivering',
    labelKey: 'transactionStepBridgingToMiden',
    defaultLabel: 'Bridging to Miden'
  }
] as const;

/** AggLayer broadcasts a Sepolia tx rather than an intent, so its first step reads differently. */
export const AGGLAYER_SUBMIT_STEP_LABEL_KEY = 'transactionStepSendingToEthereum';
