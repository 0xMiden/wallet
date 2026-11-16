import {
  hiddenMsBetween,
  isBackgroundTimeTrackingInstalled,
  wasRecordingHiddenTimeAt
} from 'lib/mobile/background-time';
import { isMobile } from 'lib/platform';
import type {
  ProofWindowBucket,
  QueueHiddenBucket,
  TerminalReportDiagnostics
} from 'lib/telemetry/terminal-report-diagnostics';

import type { ITransaction } from '../db/types';

/** How much of `span` was hidden; both numbers in one unit. */
export const hiddenShareBucket = (hidden: number, span: number): QueueHiddenBucket => {
  if (!Number.isFinite(hidden) || hidden < 0) return 'unavailable';
  if (hidden === 0) return 'none';
  return hidden * 2 >= span ? 'half_or_more' : 'under_half';
};

/**
 * Hidden share of the way from the proposal to the submit stamp, the stretch a proof's short window has to survive. It
 * opens at the proposal stamp, else at local signing, as the progress screen's first step does.
 */
export const submitApproachHiddenBucket = (row: ITransaction): QueueHiddenBucket => {
  if (!isMobile()) return 'not_measured';
  if (!isBackgroundTimeTrackingInstalled()) return 'unobserved';
  const stamps = row.stageTimestamps;
  const startMs = stamps?.['creating-proposal'] ?? stamps?.['signing-locally'];
  const submittedAtMs = stamps?.submitting;
  if (startMs === undefined || submittedAtMs === undefined) return 'unavailable';
  const spanMs = submittedAtMs - startMs;
  if (!Number.isFinite(spanMs) || spanMs <= 0) return 'unavailable';
  // Hidden intervals die with the run that kept them: a row judged after a relaunch would otherwise read `none`, the
  // opposite of what a killed app means.
  if (!wasRecordingHiddenTimeAt(startMs)) return 'unobserved';
  return hiddenShareBucket(hiddenMsBetween(startMs, submittedAtMs), spanMs);
};

const currentEntry = (row: ITransaction) => row.submitEvidence?.find(({ attemptId }) => attemptId === row.attemptId);

/** Blocks this attempt's expiration allowed from its reference block. */
export const proofWindowBucket = (row: ITransaction): ProofWindowBucket => {
  const entry = currentEntry(row);
  const refBlock = entry?.refBlock;
  const expirationBlock = entry?.expirationBlock;
  if (refBlock === undefined || expirationBlock === undefined) return 'unavailable';
  const blocks = expirationBlock - refBlock;
  if (!Number.isFinite(blocks) || blocks <= 0) return 'unavailable';
  if (blocks < 30) return 'under_30_blocks';
  return blocks <= 180 ? '30_to_180_blocks' : 'over_180_blocks';
};

const SUBMIT_CROSSING_EVIDENCE_FIELDS = [
  'transactionId',
  'initialCommitment',
  'finalCommitment',
  'initialNonce',
  'outputNoteIds',
  'nullifiers',
  'refBlock',
  'refBlockCommitment',
  'expirationBlock'
] as const;

/** What the attempt's entry shows. An entry alone shows nothing: every end writes one, crossed or not. */
export const attemptSubmitCrossing = (row: ITransaction): 'crossed' | 'not_crossed' | 'unavailable' => {
  if (row.attemptId === undefined) return 'unavailable';
  const attempt = currentEntry(row);
  if (attempt === undefined) return 'unavailable';
  if (attempt.preSubmitEnd === true) return 'not_crossed';
  return attempt.source === 'stage' || SUBMIT_CROSSING_EVIDENCE_FIELDS.some(field => attempt[field] !== undefined)
    ? 'crossed'
    : 'unavailable';
};

// Either the entry or the stamp shows it, because an offscreen `submitting` stamp is fire-and-forget and may never
// arrive. The stamp precedes the call, so it never outweighs a proven pre-submit end.
const reachedSubmit = (row: ITransaction): boolean => {
  const crossing = attemptSubmitCrossing(row);
  return crossing === 'crossed' || (crossing === 'unavailable' && row.stageTimestamps?.submitting !== undefined);
};

/** What a report says about the way to this row's submit; nothing unless the row shows it reached one. */
export const submitApproach = (
  row: ITransaction
): Pick<TerminalReportDiagnostics, 'submitApproachHidden' | 'proofWindow'> =>
  reachedSubmit(row)
    ? { submitApproachHidden: submitApproachHiddenBucket(row), proofWindow: proofWindowBucket(row) }
    : {};
