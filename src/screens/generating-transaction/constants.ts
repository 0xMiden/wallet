export const GENERATING_TRANSACTIONS_SWR_KEY = 'all-latest-generating-transactions';
export const FAILED_TRANSACTIONS_SWR_KEY = 'all-failed-transactions';

export const GENERATING_TRANSACTIONS_REFRESH_INTERVAL_MS = 500;
export const GENERATING_TRANSACTIONS_DEDUPING_INTERVAL_MS = 250;
export const FAILED_TRANSACTIONS_REFRESH_INTERVAL_MS = 5_000;
export const FAILED_TRANSACTIONS_DEDUPING_INTERVAL_MS = 3_000;

export const AUTO_CLOSE_DELAY_MS = 10_000;
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
