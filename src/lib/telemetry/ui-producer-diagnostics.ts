import { closedDiagnosticPair, ownDiagnosticData } from './closed-root-diagnostics';

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
export const PENDING_RETRY_REASONS = [
  'row_missing',
  'not_retryable',
  'guardian_hold',
  'landing_pending',
  'verdict_busy',
  'unsafe_retry',
  'unexpected'
] as const;
export const RECIPIENT_VALIDATION_STAGES = ['prefix_rejected', 'decoder_throw', 'validator_exception'] as const;
export const BACKUP_NETWORK_FAILURE_STAGES = ['declared_network', 'genesis_header'] as const;
export type BackupNetworkFailureStage = (typeof BACKUP_NETWORK_FAILURE_STAGES)[number];
export type FeatureUnavailableFeature = (typeof FEATURE_UNAVAILABLE_FEATURES)[number];
export type FeatureUnavailableReason = (typeof FEATURE_UNAVAILABLE_REASONS)[number];
export type SubmissionFeedbackBranch = (typeof SUBMISSION_FEEDBACK_BRANCHES)[number];
export type PendingRetryReason = (typeof PENDING_RETRY_REASONS)[number];
export type RecipientValidationStage = (typeof RECIPIENT_VALIDATION_STAGES)[number];
export type UiEvidenceInput =
  | {
      kind: 'feature_unavailable';
      featureUnavailableFeature: FeatureUnavailableFeature;
      featureUnavailableReason: FeatureUnavailableReason;
    }
  | { kind: 'submission_feedback'; submissionFeedbackBranch: SubmissionFeedbackBranch }
  | { kind: 'pending_retry'; pendingRetryReason: PendingRetryReason }
  | { kind: 'recipient_validation'; recipientValidationStage: RecipientValidationStage }
  | { kind: 'backup_network_failure'; backupNetworkFailureStage: BackupNetworkFailureStage };
export type UiProducerDiagnostics = {
  featureUnavailableFeature?: FeatureUnavailableFeature;
  featureUnavailableReason?: FeatureUnavailableReason;
  submissionFeedbackBranch?: SubmissionFeedbackBranch;
  pendingRetryReason?: PendingRetryReason;
  recipientValidationStage?: RecipientValidationStage;
  backupNetworkFailureStage?: BackupNetworkFailureStage;
};
export const UI_PRODUCER_KEYS = [
  'featureUnavailableFeature',
  'featureUnavailableReason',
  'submissionFeedbackBranch',
  'pendingRetryReason',
  'recipientValidationStage',
  'backupNetworkFailureStage'
] as const;
const groups = {
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
  pending_retry: {
    id: 'raw_pending_activity_retry_failed',
    surface: 'notice',
    fields: { pendingRetryReason: PENDING_RETRY_REASONS }
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
