import type {
  IBridgedReceivePhase,
  IBridgeProvider,
  ITransaction,
  ITransactionStage,
  ITransactionType
} from 'lib/miden/db/types';

import type { TRANSACTION_STEPS } from './constants';

/** Bridge lifecycle read off a `bridged-receive` row's `extraInputs`. */
export interface BridgedReceiveMeta {
  phase: IBridgedReceivePhase;
  provider?: IBridgeProvider;
  sourceAmount?: string;
  sourceSymbol?: string;
}

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
  /**
   * Set for tracking-only EVM → Miden bridge rows, whose lifecycle lives in
   * `extraInputs.phase` rather than `ITransactionStatus`. Switches the screen to
   * the two-step bridge ladder.
   */
  bridgedReceive?: BridgedReceiveMeta;
}

export type TransactionStepState = 'complete' | 'active' | 'pending' | 'failed';
export type TransactionStep = (typeof TRANSACTION_STEPS)[number];

/** Structural shape of a step row — satisfied by both step ladders. */
export interface TransactionStepDescriptor {
  id: string;
  labelKey: string;
  defaultLabel: string;
}
export type TransactionHeroState = 'processing' | 'success' | 'failed';

export interface TransactionHeroIconProps {
  state: TransactionHeroState;
}

export interface StatusIndicatorProps {
  state: TransactionStepState;
}

export interface TransactionStepRowProps {
  step: TransactionStepDescriptor;
  state: TransactionStepState;
  isLast: boolean;
  label?: string;
  /** Right-aligned muted text, e.g. the step's duration ("2 sec"). */
  meta?: string;
}
