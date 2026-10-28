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
export interface TerminalReportDiagnostics {
  queueAdmissionObservation?: QueueAdmissionObservation;
  queueSighting?: QueueSighting;
  preflightSync?: PreflightSyncReport;
  queueHidden?: QueueHiddenBucket;
  reapStartRelation?: ReapStartRelation;
}
const listed = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  allowed.find(item => item === value);
const store = rootDiagnosticStore<TerminalReportDiagnostics>(value => {
  const queue = listed(safeOwnDiagnosticData(value, 'queueAdmissionObservation'), QUEUE_ADMISSION_OBSERVATIONS);
  const sighting = listed(safeOwnDiagnosticData(value, 'queueSighting'), QUEUE_SIGHTINGS);
  const sync = listed(safeOwnDiagnosticData(value, 'preflightSync'), PREFLIGHT_SYNC_REPORTS);
  const hidden = listed(safeOwnDiagnosticData(value, 'queueHidden'), QUEUE_HIDDEN_BUCKETS);
  const reap = listed(safeOwnDiagnosticData(value, 'reapStartRelation'), REAP_START_RELATIONS);
  return queue || sighting || sync || hidden || reap
    ? {
        ...(queue ? { queueAdmissionObservation: queue } : {}),
        ...(sighting ? { queueSighting: sighting } : {}),
        ...(sync ? { preflightSync: sync } : {}),
        ...(hidden ? { queueHidden: hidden } : {}),
        ...(reap ? { reapStartRelation: reap } : {})
      }
    : undefined;
});
export const annotateTerminalReport = store.annotate;
export const snapshotTerminalReport = store.snapshot;
