import { BURN_FEE_FAILURES, type BurnFeeFailure } from 'lib/usdcx/burn-fee-failure';

import { classifyError } from './classify';
import { closedDiagnosticPair, ownDiagnosticData } from './closed-root-diagnostics';
import { SUBMIT_ENDPOINTS, SUBMIT_GRPC_STATUSES } from './transaction-failure';

export const FEATURE_UNAVAILABLE_FEATURES = [
  'earnDeposit',
  'fastBridgeOut',
  'fastBridgeIn',
  'bridgeIn',
  'bridgeOut',
  'usdcxDeposit',
  'usdcxWithdrawal',
  'unknown'
] as const;
export const FEATURE_UNAVAILABLE_REASONS = [
  'off',
  'not-configured',
  'not-deployed',
  'service-down',
  'unknown'
] as const;
export const SUBMISSION_FEEDBACK_BRANCHES = [
  'prover_at_submit',
  'guardian_unanswered',
  'grpc_unknown',
  'no_answer'
] as const;
export type SubmissionRejectedEndpoint = (typeof SUBMIT_ENDPOINTS)[number];
export type SubmissionRejectedStatus = (typeof SUBMIT_GRPC_STATUSES)[number];
export const PENDING_RETRY_REASONS = [
  'row_missing',
  'not_retryable',
  'guardian_hold',
  'landing_pending',
  'verdict_busy',
  'unsafe_retry',
  'unexpected'
] as const;
export const EARN_POSITIONS_LOAD_STAGES = [
  'configuration',
  'owner_lookup',
  'request',
  'response_decode',
  'position_decode',
  'unrecorded'
] as const;
export const EARN_POSITIONS_LOAD_OUTCOMES = ['complete_failure', 'partial_failure'] as const;
export type EarnPositionsLoadStage = (typeof EARN_POSITIONS_LOAD_STAGES)[number];
export type EarnPositionsLoadOutcome = (typeof EARN_POSITIONS_LOAD_OUTCOMES)[number];
export type BridgeBalanceBranch = 'fast_usdc' | 'circle_usdc' | 'native' | 'registered_erc20' | 'unrecorded';
export type BridgeBalanceStage =
  | 'configuration'
  | 'input_validation'
  | 'request_build'
  | 'request'
  | 'response_decode'
  | 'rpc_rejected'
  | 'value_decode'
  | 'unrecorded';
export const BRIDGE_BALANCE_BRANCHES: readonly BridgeBalanceBranch[] = [
  'fast_usdc',
  'circle_usdc',
  'native',
  'registered_erc20',
  'unrecorded'
];
export const BRIDGE_BALANCE_STAGES: readonly BridgeBalanceStage[] = [
  'configuration',
  'input_validation',
  'request_build',
  'request',
  'response_decode',
  'rpc_rejected',
  'value_decode',
  'unrecorded'
];
export const RETRY_NOTICE_ORIGINS = [
  'history_primary',
  'history_earn_receive',
  'history_payback',
  'status_screen'
] as const;
export const RECIPIENT_VALIDATION_STAGES = ['prefix_rejected', 'decoder_throw', 'validator_exception'] as const;
export type MainnetAccessCheckFailure =
  | 'endpoint_resolve'
  | 'sdk_ready'
  | 'rpc_client'
  | 'invitation_check'
  | 'unrecorded';
export const MAINNET_ACCESS_CHECK_FAILURES: readonly MainnetAccessCheckFailure[] = [
  'endpoint_resolve',
  'sdk_ready',
  'rpc_client',
  'invitation_check',
  'unrecorded'
];
export const MAINNET_ACCESS_CODE_REJECTION_ORIGINS = ['eligibility_check', 'registration_redemption'] as const;
export type MainnetAccessCodeRejectionOrigin = (typeof MAINNET_ACCESS_CODE_REJECTION_ORIGINS)[number];
export type NoteClaimFailureOrigin = 'queue_single' | 'queue_batch' | 'transaction_row';
export const NOTE_CLAIM_FAILURE_ORIGINS: readonly NoteClaimFailureOrigin[] = [
  'queue_single',
  'queue_batch',
  'transaction_row'
];
export type UiFailureKind =
  | 'network'
  | 'rpc'
  | 'proving'
  | 'validation'
  | 'storage'
  | 'access_denied'
  | 'timeout'
  | 'unknown'
  | 'unavailable';
export const UI_FAILURE_KINDS: readonly UiFailureKind[] = [
  'network',
  'rpc',
  'proving',
  'validation',
  'storage',
  'access_denied',
  'timeout',
  'unknown',
  'unavailable'
];

export function classifyUiFailure(error: unknown): UiFailureKind {
  try {
    const kind = classifyError(error);
    return kind === 'auth' ? 'access_denied' : kind;
  } catch {
    return 'unavailable';
  }
}

export const BACKUP_NETWORK_FAILURE_STAGES = ['declared_network', 'genesis_header'] as const;
export type BackupNetworkFailureStage = (typeof BACKUP_NETWORK_FAILURE_STAGES)[number];
export type FeatureUnavailableFeature = (typeof FEATURE_UNAVAILABLE_FEATURES)[number];
export type FeatureUnavailableReason = (typeof FEATURE_UNAVAILABLE_REASONS)[number];
export type SubmissionFeedbackBranch = (typeof SUBMISSION_FEEDBACK_BRANCHES)[number];
export type PendingRetryReason = (typeof PENDING_RETRY_REASONS)[number];
export type RetryNoticeOrigin = (typeof RETRY_NOTICE_ORIGINS)[number];
export type RecipientValidationStage = (typeof RECIPIENT_VALIDATION_STAGES)[number];
export type UiEvidenceInput =
  | {
      kind: 'bridge_balance_read';
      bridgeBalanceBranch: BridgeBalanceBranch;
      bridgeBalanceStage: BridgeBalanceStage;
    }
  | {
      kind: 'feature_unavailable';
      featureUnavailableFeature: FeatureUnavailableFeature;
      featureUnavailableReason: FeatureUnavailableReason;
    }
  | { kind: 'submission_feedback'; submissionFeedbackBranch: SubmissionFeedbackBranch }
  | {
      kind: 'submission_rejected';
      submissionRejectedEndpoint: SubmissionRejectedEndpoint;
      submissionRejectedStatus: SubmissionRejectedStatus;
    }
  | { kind: 'pending_retry'; pendingRetryReason: PendingRetryReason }
  | {
      kind: 'history_retry';
      retryNoticeOrigin: 'history_primary' | 'history_earn_receive';
      pendingRetryReason: PendingRetryReason;
    }
  | { kind: 'history_payback_retry'; retryNoticeOrigin: 'history_payback'; pendingRetryReason: PendingRetryReason }
  | { kind: 'transaction_retry'; retryNoticeOrigin: 'status_screen'; pendingRetryReason: PendingRetryReason }
  | { kind: 'recipient_validation'; recipientValidationStage: RecipientValidationStage }
  | {
      kind: 'earn_positions_load';
      earnPositionsLoadStage: EarnPositionsLoadStage;
      earnPositionsLoadOutcome: EarnPositionsLoadOutcome;
    }
  | { kind: 'burn_fee'; burnFeeFailure: BurnFeeFailure }
  | { kind: 'mainnet_access_check'; mainnetAccessCheckFailure: MainnetAccessCheckFailure; uiFailureKind: UiFailureKind }
  | {
      kind: 'mainnet_access_code_rejection';
      mainnetAccessCodeRejectionOrigin: MainnetAccessCodeRejectionOrigin;
    }
  | { kind: 'note_claim'; noteClaimFailureOrigin: NoteClaimFailureOrigin; uiFailureKind: UiFailureKind }
  | { kind: 'backup_network_failure'; backupNetworkFailureStage: BackupNetworkFailureStage };
export type UiProducerDiagnostics = {
  earnPositionsLoadStage?: EarnPositionsLoadStage;
  earnPositionsLoadOutcome?: EarnPositionsLoadOutcome;
  bridgeBalanceBranch?: BridgeBalanceBranch;
  bridgeBalanceStage?: BridgeBalanceStage;
  featureUnavailableFeature?: FeatureUnavailableFeature;
  featureUnavailableReason?: FeatureUnavailableReason;
  submissionFeedbackBranch?: SubmissionFeedbackBranch;
  submissionRejectedEndpoint?: SubmissionRejectedEndpoint;
  submissionRejectedStatus?: SubmissionRejectedStatus;
  pendingRetryReason?: PendingRetryReason;
  retryNoticeOrigin?: RetryNoticeOrigin;
  recipientValidationStage?: RecipientValidationStage;
  burnFeeFailure?: BurnFeeFailure;
  mainnetAccessCheckFailure?: MainnetAccessCheckFailure;
  mainnetAccessCodeRejectionOrigin?: MainnetAccessCodeRejectionOrigin;
  noteClaimFailureOrigin?: NoteClaimFailureOrigin;
  uiFailureKind?: UiFailureKind;
  backupNetworkFailureStage?: BackupNetworkFailureStage;
};
export const UI_PRODUCER_KEYS = [
  'earnPositionsLoadStage',
  'earnPositionsLoadOutcome',
  'bridgeBalanceBranch',
  'bridgeBalanceStage',
  'featureUnavailableFeature',
  'featureUnavailableReason',
  'submissionFeedbackBranch',
  'submissionRejectedEndpoint',
  'submissionRejectedStatus',
  'pendingRetryReason',
  'retryNoticeOrigin',
  'recipientValidationStage',
  'burnFeeFailure',
  'mainnetAccessCheckFailure',
  'mainnetAccessCodeRejectionOrigin',
  'noteClaimFailureOrigin',
  'uiFailureKind',
  'backupNetworkFailureStage'
] as const;
const groups = {
  earn_positions_load: {
    id: 'earnPositionsLoadError',
    surface: 'notice',
    fields: {
      earnPositionsLoadStage: EARN_POSITIONS_LOAD_STAGES,
      earnPositionsLoadOutcome: EARN_POSITIONS_LOAD_OUTCOMES
    }
  },
  bridge_balance_read: {
    id: 'raw_bridge_balance_failed',
    surface: 'field',
    fields: { bridgeBalanceBranch: BRIDGE_BALANCE_BRANCHES, bridgeBalanceStage: BRIDGE_BALANCE_STAGES }
  },
  feature_unavailable: {
    id: 'bridgeFeatureUnavailableBody',
    surface: 'notice',
    fields: {
      featureUnavailableFeature: FEATURE_UNAVAILABLE_FEATURES,
      featureUnavailableReason: FEATURE_UNAVAILABLE_REASONS
    }
  },
  submission_feedback: {
    id: 'submissionUnanswered',
    surface: 'status_screen',
    fields: { submissionFeedbackBranch: SUBMISSION_FEEDBACK_BRANCHES }
  },
  submission_rejected: {
    id: 'submissionRejectedByNetwork',
    surface: 'notice',
    fields: { submissionRejectedEndpoint: SUBMIT_ENDPOINTS, submissionRejectedStatus: SUBMIT_GRPC_STATUSES }
  },
  pending_retry: {
    id: 'raw_pending_activity_retry_failed',
    surface: 'notice',
    fields: { pendingRetryReason: PENDING_RETRY_REASONS }
  },
  mainnet_access_check: {
    id: 'mainnetAccessCheckFailed',
    surface: 'inline',
    fields: { mainnetAccessCheckFailure: MAINNET_ACCESS_CHECK_FAILURES, uiFailureKind: UI_FAILURE_KINDS }
  },
  mainnet_access_code_rejection: {
    id: 'mainnetAccessCodeRejected',
    surface: 'inline',
    fields: { mainnetAccessCodeRejectionOrigin: MAINNET_ACCESS_CODE_REJECTION_ORIGINS }
  },
  note_claim: {
    id: 'noteClaimFailedRetry',
    surface: 'notice',
    fields: { noteClaimFailureOrigin: NOTE_CLAIM_FAILURE_ORIGINS, uiFailureKind: UI_FAILURE_KINDS }
  },
  burn_fee: {
    id: 'usdcxBurnFeeUnavailable',
    surface: 'field',
    fields: { burnFeeFailure: BURN_FEE_FAILURES }
  },
  history_retry: {
    id: 'raw_history_retry_failed',
    surface: 'inline',
    fields: {
      retryNoticeOrigin: ['history_primary', 'history_earn_receive'],
      pendingRetryReason: PENDING_RETRY_REASONS
    }
  },
  history_payback_retry: {
    id: 'raw_history_retry_failed',
    surface: 'notice',
    fields: { retryNoticeOrigin: ['history_payback'], pendingRetryReason: PENDING_RETRY_REASONS }
  },
  transaction_retry: {
    id: 'raw_transaction_retry_failed',
    surface: 'inline',
    fields: { retryNoticeOrigin: ['status_screen'], pendingRetryReason: PENDING_RETRY_REASONS }
  },
  backup_network_failure: {
    id: 'encryptedWalletFileWrongNetwork',
    surface: 'field',
    fields: { backupNetworkFailureStage: BACKUP_NETWORK_FAILURE_STAGES }
  },
  recipient_validation: {
    id: 'invalidMidenAccountId',
    surface: 'inline',
    fields: { recipientValidationStage: RECIPIENT_VALIDATION_STAGES }
  }
} as const;
export function validateUiEvidence(id: unknown, surface: unknown, value: unknown): UiEvidenceInput | undefined {
  try {
    const kind = ownDiagnosticData(value, 'kind');
    if (typeof kind !== 'string' || !Object.prototype.hasOwnProperty.call(groups, kind)) return undefined;
    const group = groups[kind as keyof typeof groups];
    if (id !== group.id || surface !== group.surface) return undefined;
    return closedDiagnosticPair<UiEvidenceInput>(value, { kind: [kind], ...group.fields });
  } catch {
    return undefined;
  }
}
const reports = new WeakMap<object, { id: unknown; surface: unknown; value: UiEvidenceInput }>();
export function annotateUiProducer(error: unknown, id: unknown, surface: unknown, value: unknown): void {
  try {
    if (typeof error !== 'object' || error === null) return;
    const safe = validateUiEvidence(id, surface, value);
    if (safe) reports.set(error, { id, surface, value: safe });
    else reports.delete(error);
  } catch {
    /* Diagnostics cannot change the display. */
  }
}
export function snapshotUiProducer(error: unknown, id: unknown, surface: unknown): UiProducerDiagnostics | undefined {
  try {
    if (typeof error !== 'object' || error === null) return undefined;
    const stored = reports.get(error);
    if (!stored || stored.id !== id || stored.surface !== surface) return undefined;
    const value = validateUiEvidence(id, surface, stored.value);
    if (!value) return undefined;
    const { kind: _kind, ...fields } = value;
    return fields;
  } catch {
    return undefined;
  }
}
function closedErrorObservation<T extends string>(values: readonly T[]) {
  const observations = new WeakMap<object, T>();
  return {
    annotate(error: unknown, value: unknown): void {
      try {
        if (typeof error !== 'object' || error === null) return;
        const safe = values.find(item => item === value);
        if (safe === undefined) observations.delete(error);
        else observations.set(error, safe);
      } catch {
        /* Preserve the original rejection. */
      }
    },
    snapshot(error: unknown): T | undefined {
      try {
        return typeof error === 'object' && error !== null ? observations.get(error) : undefined;
      } catch {
        return undefined;
      }
    }
  };
}
const retries = closedErrorObservation(PENDING_RETRY_REASONS);
export const annotatePendingRetry = retries.annotate;
export const snapshotPendingRetry = retries.snapshot;
const recipients = closedErrorObservation(RECIPIENT_VALIDATION_STAGES);
export const annotateRecipientValidation = recipients.annotate;
export const snapshotRecipientValidation = recipients.snapshot;

const mainnetChecks = closedErrorObservation(MAINNET_ACCESS_CHECK_FAILURES);
export const annotateMainnetAccessCheckFailure = mainnetChecks.annotate;
export const snapshotMainnetAccessCheckFailure = mainnetChecks.snapshot;
