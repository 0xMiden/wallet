import type { ITransaction, ITransactionStage, ITransactionType } from 'lib/miden/db/types';

import type { TRANSACTION_STEPS } from './constants';

export interface GeneratingTransactionPageProps {
  /** Id of the transaction this page tracks; comes from the `/:txId` route param. */
  txId: string;
  keepOpen?: boolean;
}

export interface GeneratingTransactionProps {
  onDoneClick: () => void;
  transactionComplete: boolean;
  hasErrors?: boolean;
  keepOpen?: boolean;
  /** Stage of the tx currently being processed (or head of queue). */
  activeStage?: ITransactionStage;
  /** Type of the tx currently being processed (for type-specific labels). */
  activeType?: ITransactionType;
  /** The in-flight tx, used by the summary badge under the title. */
  activeTransaction?: ITransaction;
  /** Last transaction shown before the queue completed, used by the success receipt. */
  completedTransaction?: ITransaction;
  /** On-chain hash for the completed transaction receipt. */
  completedTxHash?: string | null;
  /**
   * When provided and the tx completed successfully, lets the success receipt
   * open the source transaction in Midenscan.
   */
  onViewExplorer?: () => void;
  /** Retry a FAILED tx from the failure footer (#483). Shown only when `canRetry`. */
  onRetry?: () => void;
  /** Whether the failed tx can be retried (requeueable / resubmittable). */
  canRetry?: boolean;
  /** True while a retry is in flight — drives the Retry button spinner. */
  isRetrying?: boolean;
  /** Error message from a failed retry attempt, shown under the buttons. */
  retryError?: string | null;
}

export type TransactionStepState = 'complete' | 'active' | 'pending' | 'failed';
export type TransactionStep = (typeof TRANSACTION_STEPS)[number];
export type TransactionHeroState = 'processing' | 'success' | 'failed';

export interface TransactionHeroIconProps {
  state: TransactionHeroState;
}

export interface StatusIndicatorProps {
  state: TransactionStepState;
}

export interface TransactionStepRowProps {
  step: TransactionStep;
  state: TransactionStepState;
  isLast: boolean;
  label?: string;
  /** Right-aligned muted text, e.g. the step's duration ("2 sec"). */
  meta?: string;
}
