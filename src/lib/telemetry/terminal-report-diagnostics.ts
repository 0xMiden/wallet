import {
  QUEUE_ADMISSION_OBSERVATIONS,
  QUEUE_SIGHTINGS,
  type QueueAdmissionObservation,
  type QueueSighting
} from 'lib/miden/transaction/queue-admission-diagnostics';

import { rootDiagnosticStore, safeOwnDiagnosticData } from './closed-root-diagnostics';
import { REAP_START_RELATIONS, type ReapStartRelation } from './reap-start-diagnostics';
export const PREFLIGHT_SYNC_REPORTS = ['not_entered', 'entered', 'returned', 'threw'] as const;
export type PreflightSyncReport = (typeof PREFLIGHT_SYNC_REPORTS)[number];
export const QUEUE_HIDDEN_BUCKETS = [
  'not_measured',
  'unobserved',
  'none',
  'under_half',
  'half_or_more',
  'unavailable'
] as const;
export type QueueHiddenBucket = (typeof QUEUE_HIDDEN_BUCKETS)[number];
export const PROOF_WINDOW_BUCKETS = ['under_30_blocks', '30_to_180_blocks', 'over_180_blocks', 'unavailable'] as const;
export type ProofWindowBucket = (typeof PROOF_WINDOW_BUCKETS)[number];
export const SUBMIT_HIDDEN_ANSWERS = ['yes', 'no', 'unavailable'] as const;
export type SubmitHiddenAnswer = (typeof SUBMIT_HIDDEN_ANSWERS)[number];
export const SUBMIT_LEG_BUCKETS: readonly ['under_9s', '9_to_11s', 'over_11s', 'unavailable'] = [
  'under_9s',
  '9_to_11s',
  'over_11s',
  'unavailable'
];
export type SubmitLegBucket = (typeof SUBMIT_LEG_BUCKETS)[number];
export interface TerminalReportDiagnostics {
  queueAdmissionObservation?: QueueAdmissionObservation;
  queueSighting?: QueueSighting;
  preflightSync?: PreflightSyncReport;
  queueHidden?: QueueHiddenBucket;
  reapStartRelation?: ReapStartRelation;
  submitApproachHidden?: QueueHiddenBucket;
  proofWindow?: ProofWindowBucket;
  submitHidden?: SubmitHiddenAnswer;
  submitLeg?: SubmitLegBucket;
}
const listed = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  allowed.find(item => item === value);
const store = rootDiagnosticStore<TerminalReportDiagnostics>(value => {
  const queue = listed(safeOwnDiagnosticData(value, 'queueAdmissionObservation'), QUEUE_ADMISSION_OBSERVATIONS);
  const sighting = listed(safeOwnDiagnosticData(value, 'queueSighting'), QUEUE_SIGHTINGS);
  const sync = listed(safeOwnDiagnosticData(value, 'preflightSync'), PREFLIGHT_SYNC_REPORTS);
  const hidden = listed(safeOwnDiagnosticData(value, 'queueHidden'), QUEUE_HIDDEN_BUCKETS);
  const reap = listed(safeOwnDiagnosticData(value, 'reapStartRelation'), REAP_START_RELATIONS);
  const approach = listed(safeOwnDiagnosticData(value, 'submitApproachHidden'), QUEUE_HIDDEN_BUCKETS);
  const proofWindow = listed(safeOwnDiagnosticData(value, 'proofWindow'), PROOF_WINDOW_BUCKETS);
  const submitHidden = listed(safeOwnDiagnosticData(value, 'submitHidden'), SUBMIT_HIDDEN_ANSWERS);
  const submitLeg = listed(safeOwnDiagnosticData(value, 'submitLeg'), SUBMIT_LEG_BUCKETS);
  return queue || sighting || sync || hidden || reap || approach || proofWindow || submitHidden || submitLeg
    ? {
        ...(queue ? { queueAdmissionObservation: queue } : {}),
        ...(sighting ? { queueSighting: sighting } : {}),
        ...(sync ? { preflightSync: sync } : {}),
        ...(hidden ? { queueHidden: hidden } : {}),
        ...(reap ? { reapStartRelation: reap } : {}),
        ...(approach ? { submitApproachHidden: approach } : {}),
        ...(proofWindow ? { proofWindow } : {}),
        ...(submitHidden ? { submitHidden } : {}),
        ...(submitLeg ? { submitLeg } : {})
      }
    : undefined;
});
export const annotateTerminalReport = store.annotate;
export const snapshotTerminalReport = store.snapshot;
