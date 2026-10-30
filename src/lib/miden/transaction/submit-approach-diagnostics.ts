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

// Evidence counts as well as the stamp, because an offscreen `submitting` stamp is fire-and-forget and may never arrive.
const reachedSubmit = (row: ITransaction): boolean => {
  if (row.stageTimestamps?.submitting !== undefined) return true;
  const entry = currentEntry(row);
  return entry !== undefined && entry.preSubmitEnd !== true;
};

/** What a report says about the way to this row's submit; nothing for a row that never reached one. */
export const submitApproach = (
  row: ITransaction
): Pick<TerminalReportDiagnostics, 'submitApproachHidden' | 'proofWindow'> =>
  reachedSubmit(row)
    ? { submitApproachHidden: submitApproachHiddenBucket(row), proofWindow: proofWindowBucket(row) }
    : {};
